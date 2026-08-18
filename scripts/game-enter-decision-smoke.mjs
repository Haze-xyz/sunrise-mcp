#!/usr/bin/env node
/**
 * Table-driven test of decideGameEnterAction (dist/game-enter-decision.js) and parseTasklistCsv
 * (dist/tasklist.js) -- both pure functions, so this needs no game and no filesystem, only plain
 * objects and strings.
 *
 * Run after `npm run build`:
 *   node scripts/game-enter-decision-smoke.mjs
 * or as part of:
 *   npm run test:keys
 *
 * This is the direct regression test for the Task 3 review's second-round finding: a repeat
 * game_enter call against a game that is past the title screen but not yet in orbit (still loading,
 * or a prior call that timed out at the worldLoad stage) produced an identical two-marker log
 * signature to a game that was genuinely never pressed, so the old whole-file-only logic re-pressed
 * Enter into whatever the game was currently showing. decideGameEnterAction is the branch-selection
 * logic pulled out of index.ts's game_enter tool specifically so this can be pinned as a table of
 * cases instead of only reasoned about against the real tool.
 *
 * Table covers the five situations the review traced by hand, plus one defensive case beyond them
 * (pid undeterminable) and one priority check (world present always wins over a stale press record):
 *   1. not running                                              -> launch
 *   2. running, pid unknown                                     -> decline
 *   3. running, world already loaded                             -> shortCircuitOk
 *   4. running, world not loaded, already pressed this session   -> resumeWorldWait  (the finding)
 *   5. running, world not loaded, title present, never pressed   -> proceed          (situation 2)
 *   6. running, world not loaded, title absent, never pressed    -> proceed          (situation 5)
 *   7. running, world loaded AND already pressed this session    -> shortCircuitOk   (priority check)
 *
 * parseTasklistCsv is tested against real tasklist.exe output captured during this review round
 * (see task-3-report.md): a genuine "not found" INFO line, and the exact CSV shape a match takes
 * (verified live against a real running process, with the image name substituted).
 */

import assert from 'node:assert/strict';
import { decideGameEnterAction } from '../dist/game-enter-decision.js';
import { parseTasklistCsv } from '../dist/tasklist.js';

/** @type {{ name: string; ok: boolean; error?: string }[]} */
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// decideGameEnterAction: the table.
// ---------------------------------------------------------------------------

/** @type {{ name: string; obs: import('../dist/game-enter-decision.js').GameEnterObservation; expectedKind: string }[]} */
const cases = [
  {
    name: '1. not running -> launch',
    obs: { running: false, pidKnown: false, worldMarkerPresent: false, titleMarkerPresent: false, pressedThisSession: false },
    expectedKind: 'launch',
  },
  {
    name: '2. running, pid undeterminable -> decline (defensive, beyond the five traced situations)',
    obs: { running: true, pidKnown: false, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: false },
    expectedKind: 'decline',
  },
  {
    name: '3. running, world already loaded -> shortCircuitOk',
    obs: { running: true, pidKnown: true, worldMarkerPresent: true, titleMarkerPresent: true, pressedThisSession: false },
    expectedKind: 'shortCircuitOk',
  },
  {
    name: '4. running, world not loaded, already pressed this session -> resumeWorldWait (THE FINDING)',
    obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: true },
    expectedKind: 'resumeWorldWait',
  },
  {
    name: '5. running, world not loaded, title present, never pressed -> proceed (situation 2)',
    obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: false },
    expectedKind: 'proceed',
  },
  {
    name: '6. running, world not loaded, title absent, never pressed -> proceed (situation 5)',
    obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: false, pressedThisSession: false },
    expectedKind: 'proceed',
  },
  {
    name: '7. world loaded AND already pressed -> shortCircuitOk (world-present check takes priority)',
    obs: { running: true, pidKnown: true, worldMarkerPresent: true, titleMarkerPresent: true, pressedThisSession: true },
    expectedKind: 'shortCircuitOk',
  },
];

for (const { name, obs, expectedKind } of cases) {
  test(name, () => {
    const action = decideGameEnterAction(obs);
    assert.equal(action.kind, expectedKind, `expected ${expectedKind}, got ${action.kind}`);
    if (action.kind === 'decline') {
      assert.equal(typeof action.reason, 'string', 'decline must carry a reason string');
      assert.ok(action.reason.length > 0, 'decline reason must not be empty');
    }
  });
}

test('cases 5 and 6 prove titleMarkerPresent does not change the outcome on the proceed branch', () => {
  const withTitle = decideGameEnterAction({
    running: true,
    pidKnown: true,
    worldMarkerPresent: false,
    titleMarkerPresent: true,
    pressedThisSession: false,
  });
  const withoutTitle = decideGameEnterAction({
    running: true,
    pidKnown: true,
    worldMarkerPresent: false,
    titleMarkerPresent: false,
    pressedThisSession: false,
  });
  assert.equal(withTitle.kind, 'proceed');
  assert.equal(withoutTitle.kind, 'proceed');
});

// ---------------------------------------------------------------------------
// parseTasklistCsv: real captured tasklist.exe output shapes.
// ---------------------------------------------------------------------------

test('parseTasklistCsv: a genuine "not found" INFO line means not running', () => {
  // Captured live: `tasklist.exe /FI "IMAGENAME eq destiny2.exe" /FO CSV /NH` with the game not running.
  const stdout = 'INFO: No tasks are running which match the specified criteria.\r\n';
  assert.deepEqual(parseTasklistCsv(stdout), { running: false, pid: null });
});

test('parseTasklistCsv: a real CSV match reports running with the parsed pid', () => {
  // Shape captured live against a real running process (explorer.exe, pid substituted here for
  // destiny2.exe -- the CSV structure itself, `"image","pid","session","session#","mem"`, is real).
  const stdout = '"destiny2.exe","47592","Console","5","166,456 K"\r\n';
  assert.deepEqual(parseTasklistCsv(stdout), { running: true, pid: 47592 });
});

test('parseTasklistCsv: an unparseable pid field still reports running, with pid null', () => {
  const stdout = '"destiny2.exe","not-a-number","Console","5","166,456 K"\r\n';
  assert.deepEqual(parseTasklistCsv(stdout), { running: true, pid: null });
});

test('parseTasklistCsv: empty output means not running', () => {
  assert.deepEqual(parseTasklistCsv(''), { running: false, pid: null });
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
