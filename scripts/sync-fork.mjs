#!/usr/bin/env node
/**
 * Brings the Sunrise fork up to date with upstream, and says which of six situations it ended in.
 *
 *   node scripts/sync-fork.mjs [--repo <path>] [--no-build] [--no-publish] [--push] [--json]
 *
 * With no --repo, the checkout comes from SUNRISE_FORK_DIR, then the current directory -- and if
 * neither is a Sunrise checkout it stops and says so. There is no built-in path on purpose.
 *
 * It never resolves a conflict and never publishes a red build; the merge happens in a throwaway
 * worktree, so a failed run leaves the checkout exactly as it found it. See src/sync.ts.
 *
 * Exit code is 0 when the run reached a conclusion that needs nobody (up to date, or merged and
 * green), and 1 when it needs a human. That makes it usable as a cron/CI step directly.
 *
 * Telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID and the same summary is sent there. With
 * neither set it prints that it sent nothing and carries on -- the sync is the point, not the ping.
 */

import { runSync, resolveForkDir, summarize } from '../dist/sync.js';
import { shouldNotify } from '../dist/sync-decision.js';
import { notifyTelegram } from '../dist/notify.js';

function parseArgs(argv) {
  const args = { build: true, publish: true, push: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      args.repo = argv[index + 1];
      index += 1;
    } else if (arg === '--no-build') args.build = false;
    else if (arg === '--no-publish') args.publish = false;
    else if (arg === '--push') args.push = true;
    else if (arg === '--no-credential-helper') args.credentialHelper = null;
    else if (arg === '--remote') {
      args.remote = argv[index + 1];
      index += 1;
    }
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `usage: node scripts/sync-fork.mjs [--repo <path>] [--no-build] [--no-publish] [--push] [--json]

  --repo <path>   the Sunrise fork checkout (else SUNRISE_FORK_DIR, else the current directory)
  --no-build      merge only; the result is reported unproven rather than ready
  --no-publish    do not move the branch even when the build is green
  --push          push the branch after publishing (needs the right gh account active)
  --remote <name> which remote to push to (default: backup)
  --no-credential-helper
                  do not force the gh credential helper on the push; use the checkout's own
                  configuration instead. This is what a CI runner needs: actions/checkout has
                  already put a token there, and gh is not installed.
  --json          print the run as JSON instead of a human summary`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const forkDir = await resolveForkDir(args.repo);
  const log = args.json ? () => {} : (line) => console.log(`  ${line}`);
  if (!args.json) console.log(`fork: ${forkDir}`);

  const result = await runSync({
    forkDir,
    build: args.build,
    publish: args.publish,
    push: args.push,
    log,
    ...(args.remote === undefined ? {} : { remote: args.remote }),
    ...(args.credentialHelper === undefined ? {} : { credentialHelper: args.credentialHelper }),
  });

  const summary = summarize(result);
  const needsHuman = ['dirty', 'conflict', 'buildFailed', 'aborted'].includes(result.outcome.kind);

  if (shouldNotify(result.outcome)) {
    const notified = await notifyTelegram(summary);
    if (!args.json && !notified.sent) console.log(`(telegram: ${notified.reason})`);
  }

  if (args.json) {
    console.log(JSON.stringify({ forkDir, ...result, summary, needsHuman }, null, 2));
  } else {
    console.log(`\n${summary}`);
  }
  process.exit(needsHuman ? 1 : 0);
}

main().catch((err) => {
  console.error(`sync-fork failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
