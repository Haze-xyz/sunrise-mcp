#!/usr/bin/env node
/**
 * Drives the compiled dist/index.js as a REAL MCP server over stdio -- the one thing no other
 * suite in this repo does. Every other suite (endurance-smoke.mjs included) tests the pure modules
 * directly and injects the liveness probe itself, so none of them can ever observe a TOOL CALL that
 * makes its own liveness claim false. That is exactly the shape of the two Critical findings from
 * the 2026-08-24 review:
 *
 *   C1 -- withEndurance stamps "the game is alive" from tools whose success does not prove it
 *         (log_read always, wait_for on a gameDied answer), which can hide the SECOND crash of a
 *         night behind a TTL that never re-checks tasklist.
 *   C2 -- game_kill used to sit behind the same liveness preflight as every other game-facing tool,
 *         so calling it against an already-dead game launched the game first and only then killed
 *         what it had just started.
 *
 * `tasklist.exe`, `powershell.exe` and `taskkill.exe` are shadowed onto PATH with fakes that track a
 * tiny JSON "is the fake game alive" file -- so this runs entirely under WSL node, with no Windows
 * boundary crossed and no way to reach the real game. The fake `powershell.exe` also performs the
 * one piece of C++ behaviour the whole design exists around: it rotates sunrise.log into
 * sunrise.log.old (keeping exactly one previous file) before writing a fresh log, exactly like
 * log.cpp's open_log_file.
 *
 * `log_read` (not `console_run`) is used throughout as the "make a preflighted call" probe: this
 * harness has no real console endpoint, so console_run/console_describe would each burn a full
 * DEFAULT_REQUEST_TIMEOUT_MS (10s, endpoint.ts) retrying a connection nothing answers -- noise this
 * suite cannot afford between timing-sensitive steps. log_read is a plain file read with no such
 * tax, and (per C1) its own success proves nothing about liveness either way, which is exactly why
 * it is safe to use as a neutral "did the WRAPPER's preflight run" probe here.
 *
 * Run after `npm run build`:
 *   node scripts/wrapper-smoke.mjs
 * or:
 *   npm run test:wrapper
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const serverPath = path.join(repoRoot, 'dist', 'index.js');

/** Must be >= src/index.ts's PROOF_OF_LIFE_TTL_MS (5_000 at time of writing), with headroom -- this
 *  test cannot import a private module constant, so it waits comfortably past it instead of racing it. */
const PAST_TTL_MS = 5_500;

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

// ---------------------------------------------------------------------------
// The fake Windows tools. Each is a plain CommonJS script under a literal *.exe name -- Linux does
// not care about the extension, only that it is executable, and `execFile` resolves a bare command
// name against PATH on POSIX exactly as it does on Windows.
// ---------------------------------------------------------------------------

const FAKE_TASKLIST = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
let state = { alive: false, pid: 0 };
try { state = JSON.parse(fs.readFileSync(process.env.SUNRISE_MCP_TEST_FAKE_STATE, 'utf8')); } catch {}
if (state.alive) {
  process.stdout.write('"destiny2.exe","' + state.pid + '","Console","1","123,456 K"\\r\\n');
} else {
  process.stdout.write('INFO: No tasks are running which match the specified criteria.\\r\\n');
}
process.exit(0);
`;

const FAKE_TASKKILL = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const stateFile = process.env.SUNRISE_MCP_TEST_FAKE_STATE;
let state = { alive: false, pid: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
if (!state.alive) {
  process.stderr.write('ERROR: The process "destiny2.exe" not found.\\r\\n');
  process.exit(128);
}
state.alive = false;
fs.writeFileSync(stateFile, JSON.stringify(state));
process.stdout.write('SUCCESS: Sent termination signal to the process "destiny2.exe" with PID ' + state.pid + '.\\r\\n');
process.exit(0);
`;

// Mimics launch-game.ps1's contract (a JSON {ok,pid} line on stdout) AND log.cpp's rotation
// (MoveFileExW(sunrise.log, sunrise.log.old, MOVEFILE_REPLACE_EXISTING) before the fresh file), so
// the harvest-before-restart ordering this whole design exists for is actually exercised. Also
// counts its own invocations, in a file the test reads directly -- this is what "game_kill never
// launches the game" (C2) actually checks against.
const FAKE_POWERSHELL = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const gameDirIndex = args.indexOf('-GameDir');
const gameDir = gameDirIndex !== -1 ? args[gameDirIndex + 1] : null;

const counterFile = process.env.SUNRISE_MCP_TEST_LAUNCH_COUNTER;
let launchCount = 0;
try { launchCount = Number(fs.readFileSync(counterFile, 'utf8').trim()) || 0; } catch {}
launchCount += 1;
fs.writeFileSync(counterFile, String(launchCount));

if (gameDir) {
  const logPath = path.win32.join(gameDir, 'bin', 'x64', 'Sunrise', 'logs', 'sunrise.log');
  const oldLogPath = logPath + '.old';
  try { fs.renameSync(logPath, oldLogPath); } catch {} // No previous log yet -- the very first launch.
  fs.writeFileSync(logPath, 'client level=info t=0 ev=boot result=ok launch=' + launchCount + '\\n');
}

const pid = 40000 + launchCount;
const stateFile = process.env.SUNRISE_MCP_TEST_FAKE_STATE;
let state = { alive: false, pid: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
state.alive = true;
state.pid = pid;
fs.writeFileSync(stateFile, JSON.stringify(state));

console.log(JSON.stringify({ ok: true, pid }));
process.exit(0);
`;

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, 'utf8');
  await chmod(filePath, 0o755);
}

// ---------------------------------------------------------------------------
// Sandbox: an isolated directory tree, an isolated journal, and a game directory that only ever
// exists as a string fed to path.win32.join -- see the note by mangledLogPath below.
// ---------------------------------------------------------------------------

/** A Windows-shaped game dir. Never used to actually address the real filesystem: game.ts always
 *  builds paths under it with path.win32.join, which (correctly, since this game.ts must run under
 *  real Windows node in production) always joins with backslashes. Under WSL node those backslashes
 *  are just ordinary filename characters, not separators, so the "path" collapses into one oddly
 *  named file *relative to the process's cwd*. That is exploited on purpose here: pin the server's
 *  cwd to the sandbox directory (see startServer) and this same join, computed independently by the
 *  test, always lands on the same file the server itself reads and writes. */
const FAKE_GAME_DIR = 'C:\\FakeGame';

function mangledLogPath(sandboxDir) {
  return path.posix.join(sandboxDir, path.win32.join(FAKE_GAME_DIR, 'bin', 'x64', 'Sunrise', 'logs', 'sunrise.log'));
}

async function setupSandbox({ alive }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrapper-smoke-'));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeExecutable(path.join(binDir, 'tasklist.exe'), FAKE_TASKLIST);
  await writeExecutable(path.join(binDir, 'taskkill.exe'), FAKE_TASKKILL);
  await writeExecutable(path.join(binDir, 'powershell.exe'), FAKE_POWERSHELL);

  const stateFile = path.join(dir, 'fake-state.json');
  const counterFile = path.join(dir, 'launch-count.txt');
  await writeFile(stateFile, JSON.stringify({ alive, pid: 40000 }), 'utf8');
  await writeFile(counterFile, '0', 'utf8');

  // The fake game's very first life, written directly rather than via the fake powershell.exe, so
  // the sandbox starts already holding a real log the harvester can copy.
  await writeFile(mangledLogPath(dir), 'client level=info t=0 ev=boot result=ok launch=0\n', 'utf8');

  const journalDir = path.join(dir, 'journal');
  return { dir, binDir, stateFile, counterFile, journalDir };
}

async function readFakeState(sandbox) {
  return JSON.parse(await readFile(sandbox.stateFile, 'utf8'));
}

async function setFakeAlive(sandbox, alive) {
  const state = await readFakeState(sandbox);
  state.alive = alive;
  await writeFile(sandbox.stateFile, JSON.stringify(state), 'utf8');
}

async function readLaunchCount(sandbox) {
  return Number((await readFile(sandbox.counterFile, 'utf8')).trim());
}

async function readJournalState(sandbox) {
  try {
    return JSON.parse(await readFile(path.join(sandbox.journalDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function startServer(sandbox) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: sandbox.dir,
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      SUNRISE_GAME_DIR: FAKE_GAME_DIR,
      SUNRISE_MCP_JOURNAL_DIR: sandbox.journalDir,
      SUNRISE_MCP_SUPERVISOR: 'restart',
      SUNRISE_MCP_TEST_FAKE_STATE: sandbox.stateFile,
      SUNRISE_MCP_TEST_LAUNCH_COUNTER: sandbox.counterFile,
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'wrapper-smoke', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

/** log_read with no arguments: the plain tail read, unrelated to game liveness either way (that is
 *  the whole point of C1). Used purely as a fast, no-endpoint-required way to make a preflighted
 *  call and observe whether the wrapper's supervisor fired before it. */
function probe(client) {
  return client.callTool({ name: 'log_read', arguments: {} });
}

/** Pulls the `supervisor` block out of a tool result, whether it arrived as the sole (blocking)
 *  content item or appended alongside the wrapped tool's own answer (non-blocking). Null when the
 *  preflight never ran at all -- which, pre-fix, is exactly what a TTL wrongly kept alive produces. */
function extractSupervisor(result) {
  for (const item of result.content ?? []) {
    if (item.type !== 'text') continue;
    let parsed;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.supervisor) return parsed.supervisor;
  }
  return null;
}

async function withServer(alive, fn) {
  const sandbox = await setupSandbox({ alive });
  const client = await startServer(sandbox);
  try {
    await fn(sandbox, client);
  } finally {
    await client.close().catch(() => undefined);
    await rm(sandbox.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  // -------------------------------------------------------------------------------------------
  // C1 -- a wait_for that observes the game dead must not leave the NEXT preflighted call
  // thinking it is still alive.
  // -------------------------------------------------------------------------------------------
  await withServer(true, async (sandbox, client) => {
    await test('C1 setup: a live game is not blocked by the supervisor', async () => {
      const result = await probe(client);
      assert.equal(extractSupervisor(result), null);
    });

    let waitedMs = null;
    await test('C1: wait_for on a dead game reports gameDied quickly, not at the deadline', async () => {
      await setFakeAlive(sandbox, false); // The fake game "crashes" on its own -- no taskkill involved.
      const result = await client.callTool({
        name: 'wait_for',
        arguments: { text: 'this-will-never-appear-xyz', timeoutMs: 8000 },
      });
      const parsed = JSON.parse(result.content[0].text);
      waitedMs = parsed.waitedMs;
      assert.equal(parsed.matched, false);
      assert.equal(parsed.reason, 'gameDied');
      assert.ok(parsed.waitedMs < 4000, `gave up after ${parsed.waitedMs}ms, should be ~1 poll tick, not the 8000ms deadline`);
    });

    await test('C1 fix: the very next preflighted call still sees the game as dead', async () => {
      // Called immediately after the wait_for above, well inside the OLD liveness TTL established
      // by the setup probe. Pre-fix, that wait_for's gameDied answer is not an error, so the old
      // blanket rule stamps a fresh "proof of life" on the way out -- this call's preflight then
      // takes the TTL fast path and never touches tasklist again, so the supervisor never fires.
      // Post-fix, wait_for's own liveness observation (not a generic per-tool rule) drives the
      // stamp, so a gameDied answer expires it instead, and this call re-checks for real.
      const result = await probe(client);
      const supervisor = extractSupervisor(result);
      assert.notEqual(supervisor, null, 'the supervisor must see the game is down, not skip the check');
      assert.equal(supervisor.blocked, false); // policy=restart, first crash: harvestAndRestart, not a block.
      assert.equal(supervisor.action, 'harvestAndRestart');
    });

    await test('C1 second-order fix: the first crash was actually harvested, not just counted', async () => {
      const state = await readJournalState(sandbox);
      assert.ok(state, 'state.json must exist');
      assert.equal(state.crashes.length, 1);
      assert.ok(state.crashes[0].harvestDir.endsWith('crash-001'));
      const meta = JSON.parse(await readFile(path.join(sandbox.journalDir, 'crash-001', 'meta.json'), 'utf8'));
      assert.ok(meta.at > 0);
      assert.ok(
        existsSync(path.join(sandbox.journalDir, 'crash-001', 'sunrise.log')),
        "crash-001 must hold the crashed life's own log, not just a count",
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Two SEPARATE deaths of the game, each its own crash, must each be harvested -- not folded
  // into one another (a stale deadSpellRecorded), and not silently dropped.
  // -------------------------------------------------------------------------------------------
  await withServer(true, async (sandbox, client) => {
    // One real boot before any crash, via the unwrapped game_launch tool: this is what gives
    // sunrise.log.old real content by the time crash-001 happens, exactly as a game that was
    // already running for a while before an agent's session started watching it would.
    await client.callTool({ name: 'game_launch', arguments: {} });

    await test('two deaths, part 1: the first crash is harvested as crash-001', async () => {
      await setFakeAlive(sandbox, false);
      const result = await probe(client);
      const supervisor = extractSupervisor(result);
      assert.notEqual(supervisor, null);
      assert.equal(supervisor.crashes, 1);
      assert.ok(supervisor.harvestDir.endsWith('crash-001'));
    });

    await test('two deaths, part 2: the relaunched game reads as alive again', async () => {
      await sleep(PAST_TTL_MS);
      const result = await probe(client);
      assert.equal(extractSupervisor(result), null);
      const state = await readFakeState(sandbox);
      assert.equal(state.alive, true, 'the fake powershell.exe launch after crash-001 must have marked it alive');
    });

    await test('two deaths, part 3: a SECOND, later crash is harvested as its own crash-002', async () => {
      await sleep(PAST_TTL_MS);
      await setFakeAlive(sandbox, false);
      const result = await probe(client);
      const supervisor = extractSupervisor(result);
      assert.notEqual(supervisor, null);
      assert.equal(supervisor.crashes, 2);
      assert.ok(supervisor.harvestDir.endsWith('crash-002'));

      const state = await readJournalState(sandbox);
      assert.equal(state.crashes.length, 2);
      assert.ok(
        existsSync(path.join(sandbox.journalDir, 'crash-002', 'meta.json')),
        'crash-002 must be harvested too, not skipped because crash-001 already set deadSpellRecorded once',
      );
      assert.ok(
        existsSync(path.join(sandbox.journalDir, 'crash-001', 'sunrise.log.old')),
        'the FIRST crash of the session must keep the life before it (sunrise.log.old)',
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Fix 1 -- unlike the "two deaths" block above, NO call here ever observes the relaunched game
  // alive before it dies again: the "two deaths" block's own part 2 does exactly that (a probe
  // after sleeping past the TTL, which clears deadSpellRecorded through runPreflight's ordinary
  // info.running branch), so it cannot tell a fixed relaunch-observation path from a broken one.
  // Here the only thing that could clear deadSpellRecorded between the two crashes is the
  // relaunch's own "launched" answer.
  // -------------------------------------------------------------------------------------------
  await withServer(true, async (sandbox, client) => {
    await test('relaunch-as-proof-of-life setup: a live game is not blocked', async () => {
      assert.equal(extractSupervisor(await probe(client)), null);
    });

    await test('a relaunch answering "launched" is itself proof of life, so the next death is its own crash-002', async () => {
      await setFakeAlive(sandbox, false); // First death.
      await sleep(PAST_TTL_MS);
      const first = await probe(client); // Detects it, harvests crash-001, relaunches.
      assert.equal(extractSupervisor(first).crashes, 1);

      // The relaunched game dies again immediately -- no intervening call ever sees it alive.
      await setFakeAlive(sandbox, false);
      await sleep(PAST_TTL_MS);
      const second = await probe(client);
      const supervisor = extractSupervisor(second);
      assert.notEqual(supervisor, null);
      assert.equal(supervisor.crashes, 2, 'the second death must be its own crash, not folded into the first');

      const state = await readJournalState(sandbox);
      assert.equal(state.crashes.length, 2);
      assert.ok(existsSync(path.join(sandbox.journalDir, 'crash-002', 'meta.json')), 'crash-002 must exist on disk');
    });
  });

  // -------------------------------------------------------------------------------------------
  // C2 -- game_kill against an already-dead game must only report it is dead -- never launch it
  // first to satisfy a liveness check that was never its business to run.
  // -------------------------------------------------------------------------------------------
  await withServer(false, async (sandbox, client) => {
    await test('C2: game_kill on a dead game never launches it', async () => {
      const launchesBefore = await readLaunchCount(sandbox);
      const result = await client.callTool({ name: 'game_kill', arguments: {} });
      const launchesAfter = await readLaunchCount(sandbox);

      assert.equal(launchesAfter, launchesBefore, 'game_kill must not call launchGame() on a dead game');
      assert.equal(extractSupervisor(result), null, 'game_kill must not be preflighted at all');
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.status, 'notRunning');
      const state = await readFakeState(sandbox);
      assert.equal(state.alive, false, 'the game must still be down after killing an already-dead game');
    });

    await test('C2: game_kill on a live game still kills it, no preflight noise either way', async () => {
      await setFakeAlive(sandbox, true);
      const launchesBefore = await readLaunchCount(sandbox);
      const result = await client.callTool({ name: 'game_kill', arguments: {} });
      const launchesAfter = await readLaunchCount(sandbox);

      assert.equal(launchesAfter, launchesBefore);
      assert.equal(extractSupervisor(result), null);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.status, 'killed');
      const state = await readFakeState(sandbox);
      assert.equal(state.alive, false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // I1 -- a journal that cannot be written must still be visible on the wrapped tool's own
  // result, not silently swallowed (journal_note, which is not wrapped, was the only tool that
  // ever reported it before this fix).
  // -------------------------------------------------------------------------------------------
  await test('I1: an unwritable journal is reported on the tool result, not swallowed', async () => {
    const sandbox = await setupSandbox({ alive: true });
    // A file sitting where the journal directory should be: mkdir(dir, {recursive:true}) fails
    // with EEXIST against it, so every write this journal ever attempts fails the same way.
    await writeFile(sandbox.journalDir, 'not a directory, on purpose', 'utf8');
    const client = await startServer(sandbox);
    try {
      // mode:'lines' forces the cursor-tracking path (and its own rememberLogCursor call) instead
      // of log_read's zero-argument tail shortcut, which never touches the journal at all.
      const result = await client.callTool({ name: 'log_read', arguments: { mode: 'lines' } });
      const own = JSON.parse(result.content[0].text);
      assert.ok(own.journal, "log_read's own rememberLogCursor failure must appear in its own result");
      assert.equal(own.journal.status, 'unavailable');

      const appended = result.content[1] ? JSON.parse(result.content[1].text) : undefined;
      assert.ok(appended?.journal, "the wrapper's own appendCall failure must be reported too");
      assert.equal(appended.journal.status, 'unavailable');
    } finally {
      await client.close().catch(() => undefined);
      await rm(sandbox.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('wrapper smoke test crashed:', err);
  process.exit(1);
});
