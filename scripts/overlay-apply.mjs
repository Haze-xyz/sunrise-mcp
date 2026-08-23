#!/usr/bin/env node
/**
 * Puts the fork's overlay into a Sunrise checkout, so somebody gains the console endpoint, mem.*,
 * character.* and the rest without merging the fork into their own history.
 *
 *   node scripts/overlay-apply.mjs --repo <checkout> [--fork-ref <branch>] [--allow-drift] [--json]
 *
 * It fetches upstream and the fork into the target, applies the fork's whole difference from
 * upstream as one squashed change with `git apply --3way`, and commits nothing. What lands in the
 * tree is yours to review, build and commit.
 *
 * It refuses by default when the target is behind upstream, and that refusal is the useful part:
 * measured on 2026-08-23, eight days of drift costs a third of the patch's hunks, every one of
 * which becomes a conflict resolved by hand for no reason. `npm run sync-fork` fixes that first.
 *
 * Exit 0 when the overlay is in the tree, 1 when the run needs a human.
 */

import { applyOverlay } from '../dist/overlay.js';
import { leftChanges } from '../dist/overlay-decision.js';

const USAGE = `usage: node scripts/overlay-apply.mjs --repo <checkout> [options]

  --repo <path>       the Sunrise checkout to apply the overlay to (required)
  --fork-url <url>    where the fork lives (default: Haze-xyz/Sunrise-mcp-fork; a local path works)
  --fork-ref <name>   which branch of it carries the overlay (default: layer2-entry)
  --allow-drift       apply even when the checkout is behind upstream, which costs hunks
  --json              print the run as JSON`;

function parseArgs(argv) {
  const args = { allowDrift: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo' || arg === '--fork-url' || arg === '--fork-ref') {
      const key = { '--repo': 'repo', '--fork-url': 'forkUrl', '--fork-ref': 'forkRef' }[arg];
      args[key] = argv[index + 1];
      index += 1;
    } else if (arg === '--allow-drift') args.allowDrift = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help || !args.repo) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  const log = args.json ? () => {} : (line) => console.log(`  ${line}`);
  if (!args.json) console.log(`target: ${args.repo}`);

  const result = await applyOverlay({
    targetDir: args.repo,
    allowDrift: args.allowDrift,
    log,
    ...(args.forkUrl === undefined ? {} : { forkUrl: args.forkUrl }),
    ...(args.forkRef === undefined ? {} : { forkRef: args.forkRef }),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.message}`);
    if (leftChanges(result.outcome)) {
      console.log(`\n${result.filesAdded} file(s) added, ${result.filesModified} of upstream's changed.`);
      console.log('Nothing is committed. Review, build, then commit.');
    }
  }
  process.exit(leftChanges(result.outcome) && result.outcome.kind === 'applied' ? 0 : 1);
}

main().catch((err) => {
  console.error(`overlay-apply failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
