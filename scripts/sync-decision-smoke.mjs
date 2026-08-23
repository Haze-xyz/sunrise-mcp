#!/usr/bin/env node
/**
 * Table-driven test of decideSyncOutcome / shouldNotify / mayPublish / describeOutcome
 * (dist/sync-decision.js). Pure functions over plain objects: no git, no MSBuild, no repository.
 *
 * Run after `npm run build`:
 *   node scripts/sync-decision-smoke.mjs
 * or as part of:
 *   npm run test:sync
 *
 * What the table is actually for. The sync job's whole value is that it is trusted on the days it
 * says nothing, and the two ways to destroy that are symmetric: notifying on a quiet day trains the
 * reader to ignore it, and staying quiet on a broken day means a fork that has silently rotted. So
 * the priority cases below (a quiet upstream beating a dirty tree, an unbuilt merge not counting as
 * a success) are the point of the file, not filler around the happy path.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decideSyncOutcome,
  describeOutcome,
  mayPublish,
  shouldNotify,
} from '../dist/sync-decision.js';
import { looksLikeForkCheckout, resolveForkDir } from '../dist/sync.js';
import { buildSucceeded, extractBuildErrors } from '../dist/build.js';
import { clampBody, notifyTelegram } from '../dist/notify.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

/** A clean, uneventful observation. Cases below override only the field they are about. */
const base = {
  workingTreeClean: true,
  upstreamCommitsAhead: 0,
  mergeAttempted: false,
  conflictedFiles: [],
  mergeError: null,
  buildSucceeded: null,
};

const CASES = [
  {
    name: 'nothing upstream -> upToDate',
    observation: {},
    expected: 'upToDate',
  },
  {
    name: 'nothing upstream beats a dirty checkout (no nagging on a quiet day)',
    observation: { workingTreeClean: false },
    expected: 'upToDate',
  },
  {
    name: 'nothing upstream beats leftover conflict data',
    observation: { mergeAttempted: true, conflictedFiles: ['a.cpp'] },
    expected: 'upToDate',
  },
  {
    name: 'commits waiting on a dirty checkout -> dirty, before any merge',
    observation: { workingTreeClean: false, upstreamCommitsAhead: 12 },
    expected: 'dirty',
  },
  {
    name: 'clean checkout, commits waiting, no merge attempted -> aborted, not success',
    observation: { upstreamCommitsAhead: 12 },
    expected: 'aborted',
  },
  {
    name: 'conflicts -> conflict, checked before the build',
    observation: {
      upstreamCommitsAhead: 43,
      mergeAttempted: true,
      conflictedFiles: ['server_settings_parser.cpp', 'client_runtime_lifecycle.cpp'],
      buildSucceeded: true,
    },
    expected: 'conflict',
  },
  {
    // The regression this whole field exists for. Measured 2026-08-23 against a real checkout:
    // FETCH_HEAD is per worktree, so the merge in the scratch worktree died with exit 128 and zero
    // conflicted files -- and the first version of this logic called that a clean merge.
    name: 'a merge that failed without conflicting is aborted, never a clean merge',
    observation: {
      upstreamCommitsAhead: 42,
      mergeAttempted: true,
      mergeError: "fatal: could not open '.../FETCH_HEAD' for reading (git exit 128)",
    },
    expected: 'aborted',
  },
  {
    name: 'a conflict outranks the merge error git reports alongside it',
    observation: {
      upstreamCommitsAhead: 42,
      mergeAttempted: true,
      conflictedFiles: ['parser.cpp'],
      mergeError: 'Automatic merge failed (git exit 1)',
    },
    expected: 'conflict',
  },
  {
    name: 'clean merge, no build run -> mergedNotBuilt, not ready',
    observation: { upstreamCommitsAhead: 43, mergeAttempted: true },
    expected: 'mergedNotBuilt',
  },
  {
    name: 'clean merge, build failed -> buildFailed',
    observation: { upstreamCommitsAhead: 43, mergeAttempted: true, buildSucceeded: false },
    expected: 'buildFailed',
  },
  {
    name: 'clean merge, build green -> ready',
    observation: { upstreamCommitsAhead: 43, mergeAttempted: true, buildSucceeded: true },
    expected: 'ready',
  },
  {
    name: 'a negative commit count is reported, not treated as up to date',
    observation: { upstreamCommitsAhead: -1 },
    expected: 'aborted',
  },
];

async function main() {
  for (const testCase of CASES) {
    await test(testCase.name, () => {
      const outcome = decideSyncOutcome({ ...base, ...testCase.observation });
      assert.equal(outcome.kind, testCase.expected, `expected ${testCase.expected}, got ${outcome.kind}`);
    });
  }

  await test('a message is sent only when the run needs a human', () => {
    // Nothing to do and it worked are both silent: the Actions history already carries green/red,
    // and a channel used for "nothing happened" stops being read.
    const silent = new Set(['upToDate', 'ready']);
    for (const testCase of CASES) {
      const outcome = decideSyncOutcome({ ...base, ...testCase.observation });
      assert.equal(shouldNotify(outcome), !silent.has(outcome.kind), `${outcome.kind} notified wrongly`);
    }
  });

  await test('an unbuilt merge still notifies, because it is the success that is not one', () => {
    // On the scheduled job this can only mean MSBuild went missing from the runner: the merge is
    // published-shaped but was never compiled, and silence there is how a build quietly stops being
    // proof of anything.
    const outcome = decideSyncOutcome({ ...base, upstreamCommitsAhead: 43, mergeAttempted: true });
    assert.equal(outcome.kind, 'mergedNotBuilt');
    assert.equal(shouldNotify(outcome), true);
  });

  await test('only ready may be published', () => {
    for (const testCase of CASES) {
      const outcome = decideSyncOutcome({ ...base, ...testCase.observation });
      assert.equal(mayPublish(outcome), outcome.kind === 'ready', `${outcome.kind} publish wrongly`);
    }
  });

  await test('an unproven merge is never publishable', () => {
    const outcome = decideSyncOutcome({ ...base, upstreamCommitsAhead: 43, mergeAttempted: true });
    assert.equal(outcome.kind, 'mergedNotBuilt');
    assert.equal(mayPublish(outcome), false);
  });

  await test('every outcome describes itself, and a conflict names its files', () => {
    const seen = new Set();
    for (const testCase of CASES) {
      const outcome = decideSyncOutcome({ ...base, ...testCase.observation });
      const line = describeOutcome(outcome);
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 0, `${outcome.kind} described itself with an empty string`);
      seen.add(outcome.kind);
    }
    const conflict = decideSyncOutcome({
      ...base,
      upstreamCommitsAhead: 43,
      mergeAttempted: true,
      conflictedFiles: ['parser.cpp'],
    });
    assert.ok(describeOutcome(conflict).includes('parser.cpp'), 'a conflict must name its files');
    assert.ok(describeOutcome(conflict).includes('43'), 'a conflict must say how many commits');
    for (const kind of ['upToDate', 'dirty', 'conflict', 'buildFailed', 'mergedNotBuilt', 'ready', 'aborted']) {
      assert.ok(seen.has(kind), `no case in the table produces ${kind}`);
    }
  });

  // ---- the I/O module's pure helpers: no git, no MSBuild, no network ----

  await test('a build counts as green only when the exit code AND the banner agree', () => {
    const green = 'Sunrise.vcxproj -> steam_api64.dll\n\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n';
    assert.equal(buildSucceeded(0, green), true);
    // The known trap on this installation: /v:minimal omits the banner even on success, and an
    // agent once read that as failure. Here the reverse is enforced -- no banner, no claim.
    assert.equal(buildSucceeded(0, 'Sunrise.vcxproj -> steam_api64.dll\n'), false);
    assert.equal(buildSucceeded(1, green), false);
    assert.equal(buildSucceeded(0, 'Build succeeded with warnings.'), false);
  });

  await test('build errors are extracted, deduplicated and capped', () => {
    const log = [
      'foo.cpp(12,5): error C2065: undeclared identifier',
      'foo.cpp(12,5): error C2065: undeclared identifier',
      '  Creating library steam_api64.lib',
      'bar.cpp(3,1): error LNK2019: unresolved external symbol',
    ].join('\n');
    const errors = extractBuildErrors(log);
    assert.equal(errors.length, 2, 'the duplicate must collapse');
    assert.ok(errors[0].includes('C2065'));
    assert.ok(errors[1].includes('LNK2019'));
    assert.deepEqual(extractBuildErrors('nothing wrong here'), []);
  });

  await test('a checkout is recognized by the file the build cannot do without', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sync-smoke-'));
    assert.equal(await looksLikeForkCheckout(root), false);
    await mkdir(path.join(root, 'Sunrise'), { recursive: true });
    await writeFile(path.join(root, 'Sunrise', 'Sunrise.vcxproj'), '<Project/>', 'utf8');
    assert.equal(await looksLikeForkCheckout(root), true);
  });

  await test('the fork directory is never guessed: argument, then env, then cwd, then refuse', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'sync-smoke-real-'));
    await mkdir(path.join(real, 'Sunrise'), { recursive: true });
    await writeFile(path.join(real, 'Sunrise', 'Sunrise.vcxproj'), '<Project/>', 'utf8');
    const empty = await mkdtemp(path.join(tmpdir(), 'sync-smoke-empty-'));

    assert.equal(await resolveForkDir(real, {}, empty), path.resolve(real), 'the argument wins');
    assert.equal(
      await resolveForkDir(undefined, { SUNRISE_FORK_DIR: real }, empty),
      path.resolve(real),
      'the env var is used when there is no argument',
    );
    assert.equal(await resolveForkDir(undefined, {}, real), path.resolve(real), 'the cwd is the last resort');
    // The whole point: nothing left to try means an error naming what to set, not a default path
    // that happens to be the author's machine.
    await assert.rejects(
      () => resolveForkDir(undefined, {}, empty),
      (err) => err.message.includes('SUNRISE_FORK_DIR') && err.message.includes('--repo'),
      'refusing must say what to set',
    );
    // An argument pointing at something that is not a checkout must not silently fall through to a
    // directory that is: the caller named a place, and being wrong about it has to be visible.
    await assert.rejects(() => resolveForkDir(empty, {}, empty));
  });

  await test('the notifier stays quiet and explains itself when it has no credentials', async () => {
    const noneSet = await notifyTelegram('hello', {});
    assert.equal(noneSet.sent, false);
    assert.ok(noneSet.reason.includes('TELEGRAM_BOT_TOKEN'));
    assert.ok(noneSet.reason.includes('TELEGRAM_CHAT_ID'));
    const halfSet = await notifyTelegram('hello', { TELEGRAM_BOT_TOKEN: 'x' });
    assert.equal(halfSet.sent, false);
    assert.ok(halfSet.reason.includes('TELEGRAM_CHAT_ID'));
    assert.ok(!halfSet.reason.includes('TELEGRAM_BOT_TOKEN'), 'it must name only what is missing');
  });

  await test('a message too long for Telegram is cut visibly, not dropped', () => {
    const short = 'a'.repeat(100);
    assert.equal(clampBody(short), short);
    const long = 'a'.repeat(5000);
    const clamped = clampBody(long);
    assert.equal(clamped.length, 4096);
    assert.ok(clamped.endsWith('truncated'));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('sync-decision smoke test crashed:', err);
  process.exit(1);
});
