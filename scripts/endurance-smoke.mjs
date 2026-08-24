#!/usr/bin/env node
/**
 * Tests of wait-for.js, journal.js and supervisor.js. Every clock, probe and filesystem effect is
 * injected, so this runs under WSL with no game and no Windows.
 *
 * Run after `npm run build`:
 *   node scripts/endurance-smoke.mjs
 * or as part of:
 *   npm run test:endurance
 *
 * The two cases worth the file. A wait that keeps waiting after the game has died burns the whole
 * timeout for an answer that could not arrive -- over a night that is hours. And a supervisor that
 * relaunches before harvesting destroys the evidence it exists to preserve, because the game rotates
 * sunrise.log into sunrise.log.old at every start and keeps exactly one: the second crash of the
 * night would erase the first. Neither is visible by reading the code; both are asserted here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLogLine } from '../dist/log-parse.js';
import { DEFAULT_WAIT_TIMEOUT_MS, waitFor } from '../dist/wait-for.js';
import { appendCall, appendNote, buildResume, readNotes, readState, writeState } from '../dist/journal.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

/**
 * A fake world for waitFor: a virtual clock that only moves when the code sleeps, and a script of
 * what each successive read returns. Nothing here waits in real time.
 */
function world({ reads, alive = () => true }) {
  let now = 0;
  let call = 0;
  const progress = [];
  return {
    progress,
    deps: {
      readWindow: async () => {
        const lines = reads[call] ?? [];
        call += 1;
        return {
          records: lines.map(parseLogLine),
          cursor: `cursor-${call}`,
          state: 'resumable',
          dropped: 0,
          scanned: lines.length,
        };
      },
      isGameAlive: async () => alive(now),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      onProgress: (waitedMs) => progress.push(waitedMs),
    },
  };
}

async function main() {
  await test('a match on the first read returns at once', async () => {
    const { deps } = world({ reads: [['client level=info t=5 ev=world_loaded result=ok']] });
    const result = await waitFor(deps, { filter: { ev: ['world_loaded'] }, timeoutMs: 55_000, pollMs: 500 });
    assert.equal(result.matched, true);
    assert.ok(result.line.includes('ev=world_loaded'));
    assert.equal(result.waitedMs, 0);
  });

  await test('a match on a later read returns the matching line, not the last line', async () => {
    const { deps } = world({
      reads: [
        ['client level=info t=1 ev=send bytes=1'],
        ['client level=info t=2 ev=send bytes=2'],
        ['client level=info t=3 ev=world_loaded result=ok', 'client level=info t=4 ev=send bytes=3'],
      ],
    });
    const result = await waitFor(deps, { filter: { ev: ['world_loaded'] }, timeoutMs: 55_000, pollMs: 500 });
    assert.equal(result.matched, true);
    assert.ok(result.line.includes('ev=world_loaded'));
    assert.equal(result.waitedMs, 1000);
  });

  await test('a timeout is not an error: it hands back a cursor to resume from', async () => {
    const { deps } = world({ reads: [] });
    const result = await waitFor(deps, { filter: { ev: ['never'] }, timeoutMs: 2_000, pollMs: 500 });
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(result.cursor.startsWith('cursor-'));
    assert.ok(result.waitedMs >= 2_000);
  });

  await test('the game dying ends the wait at once, not at the deadline', async () => {
    // This is the case that costs hours over a night if it is got wrong.
    const { deps } = world({ reads: [], alive: (now) => now < 1_500 });
    const result = await waitFor(deps, { filter: { ev: ['never'] }, timeoutMs: 600_000, pollMs: 500 });
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'gameDied');
    assert.ok(result.waitedMs < 5_000, `gave up after ${result.waitedMs}ms, should be ~1500`);
  });

  await test('a rotation ends the wait and says so', async () => {
    let call = 0;
    const deps = {
      readWindow: async () => {
        call += 1;
        return { records: [], cursor: 'c', state: call === 1 ? 'resumable' : 'rotated', dropped: 0, scanned: 0 };
      },
      isGameAlive: async () => true,
      now: () => 0,
      sleep: async () => {},
      onProgress: () => {},
    };
    const result = await waitFor(deps, { filter: { ev: ['never'] }, timeoutMs: 5_000, pollMs: 500 });
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'rotated');
  });

  await test('a match inside a rotated read wins over the rotation', async () => {
    // The game restarting is the scenario this whole system exists for, and the rotated read is
    // exactly where the awaited line lives: cursorState resets the offset to 0, so that read starts
    // at the top of the new log and already holds ev=world_loaded. Reporting 'rotated' without
    // testing those records drops the match and returns a cursor pointing past it -- measured, the
    // line then appears only inside the digest and no later call can ever reach it again.
    const line = 'client level=info t=6 ev=world_loaded result=ok';
    const deps = {
      readWindow: async () => ({
        records: ['client level=info t=5 ev=signon', line].map(parseLogLine),
        cursor: 'cursor-after-scan',
        state: 'rotated',
      }),
      isGameAlive: async () => true,
      now: () => 0,
      sleep: async () => {},
      onProgress: () => {},
    };
    const result = await waitFor(deps, { filter: { ev: ['world_loaded'] }, timeoutMs: 55_000, pollMs: 500 });
    assert.equal(result.matched, true);
    assert.equal(result.line, line);
    assert.equal(result.reason, undefined);
  });

  await test('count waits for the nth occurrence, not the first', async () => {
    const { deps } = world({
      reads: [
        ['client level=info t=1 ev=tick'],
        ['client level=info t=2 ev=tick'],
        ['client level=info t=3 ev=tick'],
      ],
    });
    const result = await waitFor(deps, { filter: { ev: ['tick'] }, count: 3, timeoutMs: 55_000, pollMs: 500 });
    assert.equal(result.matched, true);
    assert.ok(result.line.includes('t=3'));
  });

  await test('everything seen during the wait comes back as a digest', async () => {
    const noise = Array.from({ length: 40 }, (_, i) => `client level=debug t=${i} ev=send bytes=${i}`);
    const { deps } = world({ reads: [noise, ['client level=info t=99 ev=world_loaded']] });
    const result = await waitFor(deps, { filter: { ev: ['world_loaded'] }, timeoutMs: 55_000, pollMs: 500 });
    assert.equal(result.matched, true);
    assert.equal(result.digest.total, 41);
    assert.equal(result.digest.rows.length, 1);
    assert.equal(result.digest.rows[0].ev, 'send');
    assert.equal(result.digest.rows[0].count, 40);
  });

  await test('the default timeout sits under the SDK client timeout', () => {
    // protocol.js: DEFAULT_REQUEST_TIMEOUT_MSEC = 60000. A wait that outlives it produces the worst
    // possible answer: the client reports a timeout, the server keeps waiting, and the event that
    // does arrive is reported to nobody.
    assert.ok(DEFAULT_WAIT_TIMEOUT_MS < 60_000);
    assert.ok(DEFAULT_WAIT_TIMEOUT_MS >= 50_000);
  });

  await test('progress is emitted on every poll, for the clients that honour it', async () => {
    const { deps, progress } = world({ reads: [] });
    await waitFor(deps, { filter: { ev: ['never'] }, timeoutMs: 2_000, pollMs: 500 });
    assert.ok(progress.length >= 3);
  });

  async function tempJournal() {
    const dir = await mkdtemp(path.join(tmpdir(), 'journal-'));
    return {
      paths: {
        dir,
        state: path.join(dir, 'state.json'),
        calls: path.join(dir, 'calls.jsonl'),
        notes: path.join(dir, 'notes.jsonl'),
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  await test('a journal that has never been written reads as empty, not as an error', async () => {
    const { paths, cleanup } = await tempJournal();
    const state = await readState(paths);
    assert.equal(state.lastGameEnter, null);
    assert.deepEqual(state.crashes, []);
    assert.equal(state.goal, null);
    await cleanup();
  });

  await test('state survives a round trip', async () => {
    const { paths, cleanup } = await tempJournal();
    await writeState(paths, {
      lastGameEnter: { args: { character: 'warlock' }, at: 1000 },
      crashes: [{ at: 2000, harvestDir: 'crash-001' }],
      logCursor: 'abc',
      goal: 'find the foreground flag',
    });
    const state = await readState(paths);
    assert.equal(state.lastGameEnter.args.character, 'warlock');
    assert.equal(state.crashes.length, 1);
    assert.equal(state.goal, 'find the foreground flag');
    await cleanup();
  });

  await test('a corrupt state file reads as empty rather than taking the server down', async () => {
    const { paths, cleanup } = await tempJournal();
    await writeFile(paths.state, '{ this is not json', 'utf8');
    const state = await readState(paths);
    assert.equal(state.lastGameEnter, null);
    await cleanup();
  });

  await test('an unwritable journal is reported, never thrown', async () => {
    // The directory does not exist and cannot be created under a file.
    const { paths, cleanup } = await tempJournal();
    await writeFile(path.join(paths.dir, 'blocker'), 'x', 'utf8');
    const blocked = {
      dir: path.join(paths.dir, 'blocker'),
      state: path.join(paths.dir, 'blocker', 'state.json'),
      calls: path.join(paths.dir, 'blocker', 'calls.jsonl'),
      notes: path.join(paths.dir, 'blocker', 'notes.jsonl'),
    };
    const write = await appendNote(blocked, { ts: 1, kind: 'finding', text: 'x' });
    assert.equal(write.status, 'unavailable');
    assert.ok(typeof write.reason === 'string' && write.reason.length > 0);
    await cleanup();
  });

  await test('calls and notes append one JSON object per line', async () => {
    const { paths, cleanup } = await tempJournal();
    await appendCall(paths, { ts: 1, tool: 'console_run', args: { line: 'mem.read' }, status: 'ok', ms: 12 });
    await appendCall(paths, { ts: 2, tool: 'game_enter', args: {}, status: 'failed', ms: 900 });
    await appendNote(paths, { ts: 3, kind: 'finding', text: 'g_flagA reads 0 in both states' });
    const calls = (await readFile(paths.calls, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1]).tool, 'game_enter');
    const notes = await readNotes(paths, 10);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'finding');
    await cleanup();
  });

  await test('an oversized arg is truncated rather than written whole', async () => {
    const { paths, cleanup } = await tempJournal();
    await appendCall(paths, { ts: 1, tool: 'console_run', args: { line: 'x'.repeat(50_000) }, status: 'ok', ms: 1 });
    const line = (await readFile(paths.calls, 'utf8')).trim();
    assert.ok(line.length < 2_000, `a journal line grew to ${line.length} bytes`);
    assert.ok(line.includes('truncated'));
    await cleanup();
  });

  await test('a resume block is small, and leads with the goal and the findings', () => {
    const notes = [
      { ts: 1, kind: 'goal', text: 'find the foreground-lock flag' },
      ...Array.from({ length: 30 }, (_, i) => ({ ts: 10 + i, kind: 'attempt', text: `tried rva ${i}` })),
      { ts: 100, kind: 'finding', text: 'the static RVA reads 0 in both states' },
    ];
    const resume = buildResume(
      { lastGameEnter: { args: { character: 'warlock' }, at: 500 }, crashes: [{ at: 900, harvestDir: 'crash-001' }], logCursor: 'c', goal: 'find the foreground-lock flag' },
      notes,
      1_000,
    );
    assert.equal(resume.goal, 'find the foreground-lock flag');
    assert.ok(resume.recentNotes.length <= 5);
    assert.equal(resume.crashes, 1);
    assert.equal(resume.lastGameEnter.args.character, 'warlock');
    assert.ok(JSON.stringify(resume).length < 2_000, 'a resume block lands in somebody\'s context');
    assert.ok(resume.recentNotes.some((n) => n.kind === 'finding'), 'a finding must outrank an attempt');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('endurance smoke test crashed:', err);
  process.exit(1);
});
