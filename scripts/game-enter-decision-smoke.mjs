#!/usr/bin/env node
/**
 * Table-driven test of decideGameEnterAction (dist/game-enter-decision.js), the durable press
 * record (dist/press-record.js), and parseTasklistCsv (dist/tasklist.js) -- decideGameEnterAction
 * and isPressRecordFresh are pure functions needing no game and no filesystem, only plain objects;
 * the press-record read/write/clear functions do touch a real (temp) file, the same no-mock pattern
 * scripts/keys-smoke.mjs already established for waitForTitleScreen.
 *
 * Run after `npm run build`:
 *   node scripts/game-enter-decision-smoke.mjs
 * or as part of:
 *   npm run test:keys
 *
 * This is the direct regression test for the Task 3 review's second-round finding: a repeat
 * game_enter call against a game that is past the title screen but not yet in orbit (still loading,
 * or a prior call that timed out at the worldLoad stage) produced an identical two-marker log
 * signature to a game that was genuinely never pressed, so the old logic re-pressed Enter into
 * whatever the game was currently showing. A third round found that an in-process-only press record
 * doesn't survive an MCP server restart -- an ordinary event, not a rare one -- which is a residual
 * version of the same finding, not a different one. isPressRecordFresh + the durable record are
 * what close that; decideGameEnterAction still only ever sees the resulting boolean, kept pure.
 *
 * decideGameEnterAction's table covers the five situations the review traced by hand, one defensive
 * case beyond them (pid undeterminable), and two priority checks (a loaded world always wins, both
 * over a stale press record and over an undeterminable pid -- the latter fixed this round per the
 * re-review's note that a pid hiccup on an already-in-orbit game shouldn't report "ambiguous").
 * Note what this table does NOT cover: a relaunch whose log wasn't truncated, seeing stale markers
 * from the killed process. decideGameEnterAction has no concept of log offsets at all -- that
 * protection is the anchoring in index.ts's 'launch' branch, and it's scripts/keys-smoke.mjs's
 * sinceOffset case that actually tests it, not this file. (An earlier version of this file mislabeled
 * one of its own cases as covering that; this comment -- and the case's name below -- replace that
 * mistake with an explicit statement of what's NOT tested here, per the review's own preference for
 * an admitted gap over a false claim of coverage.)
 *
 * A fourth review round found that the durable record alone reopened the same finding within a
 * single, uninterrupted server process: writePressRecord never throws (an unwritable LOCALAPPDATA, a
 * mkdir failure, a transient I/O error are all swallowed), so a silently failed write meant the next
 * call in the same process found no record and re-pressed -- something the round-2 in-process
 * variable this replaced could never do, since a plain assignment cannot fail. resolvePressedThisSession
 * is the fix: an in-process cache checked first, gated by the same isPressRecordFresh check as the
 * file, with the file only consulted -- across a restart -- when the cache doesn't already answer
 * positively. Its own tests below specifically prove the cache alone is sufficient when the file
 * layer is broken: a readRecord stub that throws if called is passed in, and a fresh cache still
 * resolves true without ever invoking it.
 *
 * parseTasklistCsv is tested against real tasklist.exe output captured during the second review round
 * (see task-3-report.md): a genuine "not found" INFO line, and the exact CSV shape a match takes
 * (verified live against a real running process, with the image name substituted).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decideGameEnterAction } from '../dist/game-enter-decision.js';
import { parseTasklistCsv } from '../dist/tasklist.js';
import { clearPressRecord, isPressRecordFresh, readPressRecord, resolvePressedThisSession, writePressRecord } from '../dist/press-record.js';

/** @type {{ name: string; ok: boolean; error?: string }[]} */
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

async function main() {
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
      name: '2. running, world already loaded, pid known -> shortCircuitOk',
      obs: { running: true, pidKnown: true, worldMarkerPresent: true, titleMarkerPresent: true, pressedThisSession: false },
      expectedKind: 'shortCircuitOk',
    },
    {
      name: '3. running, world already loaded, pid UNDETERMINABLE -> shortCircuitOk, not ambiguous ' +
        '(a pid hiccup on an already-in-orbit game must not report ambiguous -- fixed this round)',
      obs: { running: true, pidKnown: false, worldMarkerPresent: true, titleMarkerPresent: true, pressedThisSession: false },
      expectedKind: 'shortCircuitOk',
    },
    {
      name: '4. running, world already loaded, pid known, pressedThisSession true -> shortCircuitOk ' +
        '(world-present check takes priority over a stale press record)',
      obs: { running: true, pidKnown: true, worldMarkerPresent: true, titleMarkerPresent: true, pressedThisSession: true },
      expectedKind: 'shortCircuitOk',
    },
    {
      name: '5. running, world not loaded, pid undeterminable -> decline (defensive, beyond the five traced situations)',
      obs: { running: true, pidKnown: false, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: false },
      expectedKind: 'decline',
    },
    {
      name: '6. running, world not loaded, already pressed this session -> resumeWorldWait (THE FINDING)',
      obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: true },
      expectedKind: 'resumeWorldWait',
    },
    {
      name: '7. running, world not loaded, title present, never pressed -> proceed (situation 2)',
      obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: false },
      expectedKind: 'proceed',
    },
    {
      name: '8. running, world not loaded, title absent, never pressed -> proceed ' +
        '(game still mid-boot -- NOT the relaunch/stale-offset case, which this file does not cover; see header comment)',
      obs: { running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: false, pressedThisSession: false },
      expectedKind: 'proceed',
    },
  ];

  for (const { name, obs, expectedKind } of cases) {
    await test(name, () => {
      const action = decideGameEnterAction(obs);
      assert.equal(action.kind, expectedKind, `expected ${expectedKind}, got ${action.kind}`);
      if (action.kind === 'decline') {
        assert.equal(typeof action.reason, 'string', 'decline must carry a reason string');
        assert.ok(action.reason.length > 0, 'decline reason must not be empty');
      }
    });
  }

  await test('cases 7 and 8 prove titleMarkerPresent does not change the outcome on the proceed branch', () => {
    const withTitle = decideGameEnterAction({
      running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: true, pressedThisSession: false,
    });
    const withoutTitle = decideGameEnterAction({
      running: true, pidKnown: true, worldMarkerPresent: false, titleMarkerPresent: false, pressedThisSession: false,
    });
    assert.equal(withTitle.kind, 'proceed');
    assert.equal(withoutTitle.kind, 'proceed');
  });

  // ---------------------------------------------------------------------------
  // isPressRecordFresh: pure staleness check, the input decideGameEnterAction's pressedThisSession
  // actually comes from at runtime (see index.ts).
  // ---------------------------------------------------------------------------

  await test('isPressRecordFresh: no record at all -> not fresh', () => {
    assert.equal(isPressRecordFresh(null, 1234, 5000), false);
  });

  await test('isPressRecordFresh: record for a different pid -> not fresh', () => {
    assert.equal(isPressRecordFresh({ pid: 9999, logSizeAtPress: 100 }, 1234, 5000), false);
  });

  await test('isPressRecordFresh: same pid, log has only grown since -> fresh', () => {
    assert.equal(isPressRecordFresh({ pid: 1234, logSizeAtPress: 100 }, 1234, 5000), true);
    assert.equal(isPressRecordFresh({ pid: 1234, logSizeAtPress: 100 }, 1234, 100), true); // exactly equal counts.
  });

  await test('isPressRecordFresh: same pid, log is now SMALLER than recorded -> stale, not fresh', () => {
    // The log was replaced (truncated or recreated) since this record was written -- it can no
    // longer refer to whatever session is running now, even though the pid happens to match.
    assert.equal(isPressRecordFresh({ pid: 1234, logSizeAtPress: 5000 }, 1234, 100), false);
  });

  // ---------------------------------------------------------------------------
  // resolvePressedThisSession: the fourth-round fix. A readRecord stub that throws if called stands
  // in for "the file layer is completely broken" (which is exactly what a silently failed
  // writePressRecord looks like from here) -- these cases prove the in-process cache is sufficient
  // entirely on its own when it's fresh, never needing to fall through to the file at all.
  // ---------------------------------------------------------------------------

  const readRecordMustNotBeCalled = async () => {
    throw new Error('readRecord should not have been called: a fresh cache must short-circuit before touching the file');
  };

  await test(
    'resolvePressedThisSession: a fresh cache is trusted on its own, without ever consulting the file ' +
      '(simulates a press whose durable write silently failed -- the cache is what still stops a re-press)',
    async () => {
      const fresh = await resolvePressedThisSession({ pid: 1234, logSizeAtPress: 100 }, 1234, 5000, readRecordMustNotBeCalled);
      assert.equal(fresh, true);
    },
  );

  await test('resolvePressedThisSession: no cache (or a stale one) falls back to the file, and a fresh file record is trusted', async () => {
    const freshFromFile = await resolvePressedThisSession(null, 1234, 5000, async () => ({ pid: 1234, logSizeAtPress: 100 }));
    assert.equal(freshFromFile, true);
  });

  await test('resolvePressedThisSession: no cache and no usable file record -> not fresh', async () => {
    const notFresh = await resolvePressedThisSession(null, 1234, 5000, async () => null);
    assert.equal(notFresh, false);
  });

  await test('resolvePressedThisSession: a stale cache (wrong pid) falls back to the file rather than trusting itself', async () => {
    const fresh = await resolvePressedThisSession({ pid: 9999, logSizeAtPress: 100 }, 1234, 5000, async () => ({
      pid: 1234,
      logSizeAtPress: 100,
    }));
    assert.equal(fresh, true);
  });

  // ---------------------------------------------------------------------------
  // readPressRecord / writePressRecord / clearPressRecord: real file I/O against a temp path.
  // ---------------------------------------------------------------------------

  const dir = await mkdtemp(path.join(tmpdir(), 'sunrise-mcp-press-record-smoke-'));
  const recordPath = path.join(dir, 'press-record.json');

  try {
    await test('readPressRecord returns null when the file does not exist yet', async () => {
      assert.equal(await readPressRecord(recordPath), null);
    });

    await test('writePressRecord then readPressRecord round-trips the same record', async () => {
      await writePressRecord({ pid: 4242, logSizeAtPress: 777 }, recordPath);
      assert.deepEqual(await readPressRecord(recordPath), { pid: 4242, logSizeAtPress: 777 });
    });

    await test('writePressRecord overwrites a previous record rather than merging with it', async () => {
      await writePressRecord({ pid: 4242, logSizeAtPress: 777 }, recordPath);
      await writePressRecord({ pid: 5555, logSizeAtPress: 999 }, recordPath);
      assert.deepEqual(await readPressRecord(recordPath), { pid: 5555, logSizeAtPress: 999 });
    });

    await test('writePressRecord leaves no leftover .tmp file behind (atomic rename, not a leaked partial write)', async () => {
      await writePressRecord({ pid: 1, logSizeAtPress: 1 }, recordPath);
      const entries = await readdir(dir);
      const leftovers = entries.filter((e) => e.includes('.tmp'));
      assert.deepEqual(leftovers, [], `expected no .tmp files, found: ${leftovers.join(', ')}`);
    });

    await test('readPressRecord returns null for a corrupt (non-JSON) file, rather than throwing', async () => {
      await writeFile(recordPath, 'this is not json{{{', 'utf8');
      assert.equal(await readPressRecord(recordPath), null);
    });

    await test('readPressRecord returns null for well-formed JSON that is not the expected shape', async () => {
      await writeFile(recordPath, JSON.stringify({ somethingElse: true }), 'utf8');
      assert.equal(await readPressRecord(recordPath), null);
    });

    await test('clearPressRecord removes the file, and is safe to call when there is nothing to remove', async () => {
      await writePressRecord({ pid: 1, logSizeAtPress: 1 }, recordPath);
      await clearPressRecord(recordPath);
      assert.equal(await readPressRecord(recordPath), null);
      await clearPressRecord(recordPath); // must not throw when the file is already gone.
    });

    await test('writePressRecord creates its parent directory if it does not exist yet', async () => {
      const nestedPath = path.join(dir, 'nested', 'does', 'not', 'exist', 'press-record.json');
      await writePressRecord({ pid: 7, logSizeAtPress: 7 }, nestedPath);
      assert.deepEqual(await readPressRecord(nestedPath), { pid: 7, logSizeAtPress: 7 });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // parseTasklistCsv: real captured tasklist.exe output shapes.
  // ---------------------------------------------------------------------------

  await test('parseTasklistCsv: a genuine "not found" INFO line means not running', () => {
    // Captured live: `tasklist.exe /FI "IMAGENAME eq destiny2.exe" /FO CSV /NH` with the game not running.
    const stdout = 'INFO: No tasks are running which match the specified criteria.\r\n';
    assert.deepEqual(parseTasklistCsv(stdout), { running: false, pid: null });
  });

  await test('parseTasklistCsv: a real CSV match reports running with the parsed pid', () => {
    // Shape captured live against a real running process (explorer.exe, pid substituted here for
    // destiny2.exe -- the CSV structure itself, `"image","pid","session","session#","mem"`, is real).
    const stdout = '"destiny2.exe","47592","Console","5","166,456 K"\r\n';
    assert.deepEqual(parseTasklistCsv(stdout), { running: true, pid: 47592 });
  });

  await test('parseTasklistCsv: an unparseable pid field still reports running, with pid null', () => {
    const stdout = '"destiny2.exe","not-a-number","Console","5","166,456 K"\r\n';
    assert.deepEqual(parseTasklistCsv(stdout), { running: true, pid: null });
  });

  await test('parseTasklistCsv: empty output means not running', () => {
    assert.deepEqual(parseTasklistCsv(''), { running: false, pid: null });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('game-enter-decision smoke test crashed:', err);
  process.exit(1);
});
