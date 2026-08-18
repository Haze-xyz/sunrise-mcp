#!/usr/bin/env node
/**
 * Drives waitForTitleScreen (dist/keys.js) against a temp log file this script writes to
 * incrementally -- no mock, no game. getLogPath() in game.ts builds its path with `path.win32`,
 * which mangles a Linux-style temp path's separators, so a WSL-node test can't reach a real temp
 * file through SUNRISE_GAME_DIR alone -- that's why waitForTitleScreen takes an explicit `logPath`
 * override, which is all this script exercises.
 *
 * Run after `npm run build`:
 *   node scripts/keys-smoke.mjs
 * or just:
 *   npm run test:keys
 *
 * Covers: false before the marker line is present and the timeout is hit; true once the marker is
 * appended mid-wait, returned promptly rather than riding out the full timeout; the timeout being
 * respected (and not rounded up to the poll interval) when it's shorter than a single poll; the log
 * file simply not existing yet (the game hasn't written anything); currentLogSize's contract (0 for
 * a missing file, the real byte size for an existing one); timeoutMs 0 acting as a single immediate
 * check rather than a wait, both when the marker is present and when it isn't -- this is the
 * building block game_enter's "already past the title screen" short-circuit in index.ts relies on;
 * and, per the Task 3 review's Important finding, sinceOffset making the wait ignore a marker that
 * was already in the file before that offset was captured, only matching content appended after it
 * -- without this, a marker written by an earlier, already-completed pass through the title screen
 * (sunrise.log is append-only, so it never goes away) would look identical to fresh evidence on a
 * repeat call, which is exactly what let game_enter re-press Enter into a game that had already
 * loaded a world and falsely report 'ok'. See index.ts's game_enter for how this is actually used.
 *
 * pressTitleScreenKey() itself is not covered here -- it shells out to a real destiny2.exe process
 * check and (with the game running) SendInput, neither of which this script can safely fake. What
 * IS covered is interpretPressKeyOutput(), the pure half it delegates to: the part that decides
 * which route ran, whether the press counts as sent, and what a caller is told. That decision is
 * what an agent branches on when this breaks.
 *
 * Those cases feed it hand-written JSON, so on their own they prove the parser's behaviour and
 * nothing about the script -- a key renamed in press-title-screen-key.ps1 would leave every one of
 * them green while interpretPressKeyOutput silently stopped seeing that field (every optional field
 * is tolerated as absent, including foregroundIsGame, which is the one fact the no-leak argument
 * rests on). The last case closes that gap by reading the .ps1 itself and asserting the key names
 * and route literals it actually writes; that is the case that fails on drift, and the literal-JSON
 * cases above it are what pin the behaviour once the names are known to match.
 */

import assert from 'node:assert/strict';
import { mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  waitForTitleScreen,
  waitForLogMarker,
  currentLogSize,
  interpretPressKeyOutput,
  TITLE_SCREEN_MARKER,
} from '../dist/keys.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'sunrise-mcp-keys-smoke-'));
  const logPath = path.join(dir, 'sunrise.log');

  try {
    await test('returns false before the marker line appears, once its timeout is hit', async () => {
      await writeFile(logPath, 'some boot line\nanother line\n', 'utf8');
      const start = performance.now();
      const seen = await waitForTitleScreen(300, logPath);
      const elapsed = performance.now() - start;
      assert.equal(seen, false);
      assert.ok(elapsed < 600, `expected to return close to the 300ms timeout, took ${elapsed.toFixed(1)}ms`);
    });

    await test('returns true once the marker line is appended mid-wait, without riding out the full timeout', async () => {
      await writeFile(logPath, 'some boot line\n', 'utf8');
      const appendTimer = setTimeout(() => {
        appendFile(logPath, `${TITLE_SCREEN_MARKER}\n`, 'utf8').catch(() => {});
      }, 300);
      const start = performance.now();
      try {
        const seen = await waitForTitleScreen(3000, logPath);
        const elapsed = performance.now() - start;
        assert.equal(seen, true);
        assert.ok(elapsed >= 250, `expected to notice the marker only after it was written (~300ms), took ${elapsed.toFixed(1)}ms`);
        assert.ok(elapsed < 2000, `expected to return promptly once the marker appeared, not ride out the 3000ms timeout, took ${elapsed.toFixed(1)}ms`);
      } finally {
        clearTimeout(appendTimer);
      }
    });

    await test('respects a timeout shorter than the poll interval, instead of rounding up to it', async () => {
      await writeFile(logPath, 'no marker here\n', 'utf8');
      const start = performance.now();
      const seen = await waitForTitleScreen(150, logPath);
      const elapsed = performance.now() - start;
      assert.equal(seen, false);
      assert.ok(elapsed < 350, `expected close to the 150ms timeout, not the (longer) poll interval, took ${elapsed.toFixed(1)}ms`);
    });

    await test('tolerates the log file not existing yet, rather than throwing', async () => {
      const missingPath = path.join(dir, 'does-not-exist.log');
      const start = performance.now();
      const seen = await waitForTitleScreen(200, missingPath);
      const elapsed = performance.now() - start;
      assert.equal(seen, false);
      assert.ok(elapsed < 450, `expected close to the 200ms timeout, took ${elapsed.toFixed(1)}ms`);
    });

    await test('currentLogSize is 0 for a missing file and the real byte size for an existing one', async () => {
      const missingPath = path.join(dir, 'still-does-not-exist.log');
      assert.equal(await currentLogSize(missingPath), 0);

      const sizedPath = path.join(dir, 'sized.log');
      await writeFile(sizedPath, 'exactly this many bytes\n', 'utf8');
      assert.equal(await currentLogSize(sizedPath), Buffer.byteLength('exactly this many bytes\n', 'utf8'));
    });

    await test('timeoutMs 0 is a single immediate check, not a wait, in both directions', async () => {
      const presentPath = path.join(dir, 'marker-present.log');
      await writeFile(presentPath, `boot\n${TITLE_SCREEN_MARKER}\n`, 'utf8');
      const presentStart = performance.now();
      const seenPresent = await waitForLogMarker(TITLE_SCREEN_MARKER, 0, presentPath);
      const presentElapsed = performance.now() - presentStart;
      assert.equal(seenPresent, true);
      assert.ok(presentElapsed < 100, `expected an immediate true, took ${presentElapsed.toFixed(1)}ms`);

      const absentPath = path.join(dir, 'marker-absent.log');
      await writeFile(absentPath, 'boot only, no marker\n', 'utf8');
      const absentStart = performance.now();
      const seenAbsent = await waitForLogMarker(TITLE_SCREEN_MARKER, 0, absentPath);
      const absentElapsed = performance.now() - absentStart;
      assert.equal(seenAbsent, false);
      assert.ok(absentElapsed < 100, `expected an immediate false, took ${absentElapsed.toFixed(1)}ms`);
    });

    await test(
      'ignores a marker already in the log before sinceOffset was captured, matching only content appended after it',
      async () => {
        const offsetPath = path.join(dir, 'offset.log');
        // A marker present before sinceOffset is captured -- e.g. a stale line left over from an
        // earlier, already-completed pass through the title screen (or, across a relaunch that
        // reused the same log path, an entirely previous session).
        await writeFile(offsetPath, `some earlier boot\n${TITLE_SCREEN_MARKER}\n`, 'utf8');
        const sinceOffset = await currentLogSize(offsetPath);

        const staleStart = performance.now();
        const seenStale = await waitForTitleScreen(300, offsetPath, sinceOffset);
        const staleElapsed = performance.now() - staleStart;
        assert.equal(seenStale, false, 'a marker written before sinceOffset must not count as a match');
        assert.ok(staleElapsed < 600, `expected close to the 300ms timeout, took ${staleElapsed.toFixed(1)}ms`);

        // The same marker, appended fresh after sinceOffset, must be found.
        await appendFile(offsetPath, `${TITLE_SCREEN_MARKER}\n`, 'utf8');
        const freshStart = performance.now();
        const seenFresh = await waitForTitleScreen(300, offsetPath, sinceOffset);
        const freshElapsed = performance.now() - freshStart;
        assert.equal(seenFresh, true, 'a marker appended after sinceOffset must count as a match');
        assert.ok(freshElapsed < 100, `expected an immediate true (it was already there), took ${freshElapsed.toFixed(1)}ms`);
      },
    );

    // ---------------------------------------------------------------- interpretPressKeyOutput
    // Each input below is a literal line press-title-screen-key.ps1 emits, so these break if the
    // script's JSON and this parser ever drift apart.

    await test('names the sendInput route on a successful press, and reports the foreground was confirmed', () => {
      const result = interpretPressKeyOutput(
        '{"status":"sent","route":"sendInput","hwnd":"0x170E5E","alreadyForeground":false,' +
          '"setForegroundResult":true,"foregroundIsGame":true,"down":1,"up":1}\n',
      );
      assert.equal(result.status, 'sent');
      assert.equal(result.route, 'sendInput');
      assert.equal(result.foregroundIsGame, true);
      assert.equal(result.down, 1);
      assert.equal(result.up, 1);
    });

    await test('reports the postMessage fallback as failed, not sent, so it can never reach the press record', () => {
      const result = interpretPressKeyOutput(
        '{"status":"sent","route":"postMessage","hwnd":"0x170E5E","alreadyForeground":false,' +
          '"setForegroundResult":false,"foregroundIsGame":false,"postedDown":true,"postedUp":true}\n',
      );
      // The script says 'sent' -- both posts really were accepted. The interpreter must NOT pass
      // that through: 'sent' is the exact gate index.ts uses to commit the durable press record,
      // and a message this engine cannot read is not a press. This is the assertion that keeps the
      // record's input contract as narrow as the review that built it left it.
      assert.equal(result.status, 'failed', "the fallback must not report 'sent' -- that gate commits the press record");
      assert.equal(result.route, 'postMessage', 'the fallback must be distinguishable from the primary route');
      assert.equal(result.foregroundIsGame, false);
      assert.match(result.message, /PostMessage/);
      assert.match(result.message, /GetKeyState/);
    });

    await test('treats a zero SendInput count as a failure, not a success, and still names the route', () => {
      const result = interpretPressKeyOutput(
        '{"status":"sent","route":"sendInput","foregroundIsGame":true,"down":0,"up":0}\n',
      );
      assert.equal(result.status, 'failed');
      assert.equal(result.route, 'sendInput');
      assert.match(result.message, /down=0 up=0/);
    });

    await test("surfaces the script's own null-keystroke guard verbatim instead of a generic failure", () => {
      const guardMessage = 'the INPUT struct came out with wVk=0 instead of 13; SendInput would have injected a null keystroke.';
      const result = interpretPressKeyOutput(
        `{"status":"failed","route":"sendInput","hwnd":"0x170E5E","error":${JSON.stringify(guardMessage)}}\n`,
      );
      assert.equal(result.status, 'failed');
      assert.equal(result.route, 'sendInput');
      assert.equal(result.message, guardMessage);
    });

    await test('reports the no-game case cleanly, with no route (nothing was attempted)', () => {
      const result = interpretPressKeyOutput('{"status":"no-game"}\n');
      assert.equal(result.status, 'no-game');
      assert.equal(result.route, undefined);
    });

    await test('returns null when nothing parses, so the caller can tell that apart from an outcome', () => {
      assert.equal(interpretPressKeyOutput(''), null);
      assert.equal(interpretPressKeyOutput('powershell blew up\nAt line:1 char:1\n'), null);
      // Valid JSON, but not a result line: a bare array, and an object with no status at all.
      assert.equal(interpretPressKeyOutput('[1,2,3]\n{"hwnd":"0x1"}\n'), null);
    });

    await test('finds the result line among PowerShell noise, scanning from the end', () => {
      const result = interpretPressKeyOutput(
        'WARNING: something chatty\n' +
          '{"status":"no-game"}\n' +
          'more noise that is not JSON\n' +
          '{"status":"sent","route":"sendInput","foregroundIsGame":true,"down":1,"up":1}\n' +
          'trailing noise\n',
      );
      assert.equal(result.status, 'sent', 'the LAST result line wins, not the first one in the file');
      assert.equal(result.route, 'sendInput');
    });

    await test('carries the window-state facts through to the caller instead of losing them in stdout', () => {
      // The script has always written these; until they were propagated, pressTitleScreenKey threw
      // the raw stdout away on the success path and game_enter's caller never saw them. An agent
      // that pulled the game in front of whatever the user was looking at has to be able to say so.
      const sent = interpretPressKeyOutput(
        '{"status":"sent","route":"sendInput","hwnd":"0x170E5E","foregroundBefore":"0x3E0894",' +
          '"restoredIconicAtEntry":false,"minimized":true,"alreadyForeground":false,' +
          '"setForegroundResult":true,"foregroundIsGame":true,"down":1,"up":1}\n',
      );
      assert.equal(sent.foregroundBefore, '0x3E0894', 'the displaced window must reach the caller');
      assert.equal(sent.minimized, true);
      assert.equal(sent.restoredIconicAtEntry, false);

      // They must survive the failure paths too -- a press that failed after minimizing the game is
      // exactly when a caller most needs to know the window stack was disturbed.
      const failed = interpretPressKeyOutput(
        '{"status":"sent","route":"postMessage","foregroundBefore":"0x3E0894","minimized":true,' +
          '"restoredIconicAtEntry":true,"foregroundIsGame":false,"postedDown":true,"postedUp":true}\n',
      );
      assert.equal(failed.status, 'failed');
      assert.equal(failed.foregroundBefore, '0x3E0894');
      assert.equal(failed.minimized, true);
      assert.equal(failed.restoredIconicAtEntry, true);

      // Absent in, absent out -- never invented. A caller must be able to tell "the script did not
      // say" from "the script said false".
      const quiet = interpretPressKeyOutput('{"status":"sent","route":"sendInput","down":1,"up":1}\n');
      assert.equal('foregroundBefore' in quiet, false);
      assert.equal('minimized' in quiet, false);
      assert.equal('restoredIconicAtEntry' in quiet, false);
    });

    await test('every key and route literal this parser reads is one press-title-screen-key.ps1 actually writes', async () => {
      // The cases above feed hand-written JSON, so none of them can notice the .ps1 renaming or
      // dropping a key -- interpretPressKeyOutput tolerates every optional field being absent, so
      // the drift would be silent, and foregroundIsGame going missing would quietly retire the one
      // fact the whole no-leak argument rests on. This case reads the script and asserts the names.
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'press-title-screen-key.ps1');
      const script = await readFile(scriptPath, 'utf8');

      // Every field interpretPressKeyOutput/isPressKeyScriptOutput reads, as a hashtable assignment
      // (`name =`) so a mention in a comment cannot satisfy it.
      for (const key of [
        'status',
        'route',
        'foregroundIsGame',
        'foregroundBefore',
        'minimized',
        'restoredIconicAtEntry',
        'down',
        'up',
        'error',
      ]) {
        assert.match(
          script,
          new RegExp(`^\\s*${key}\\s*=`, 'm'),
          `press-title-screen-key.ps1 no longer writes a "${key}" field, but keys.ts still reads it`,
        );
      }

      // The closed union: both route names, and every status the parser accepts, must exist in the
      // script as literals it can emit.
      for (const literal of ["'sendInput'", "'postMessage'", "'no-game'", "'sent'", "'failed'"]) {
        assert.ok(script.includes(literal), `press-title-screen-key.ps1 no longer emits the literal ${literal}`);
      }

      // foregroundIsGame must be reported from the measured variable, never asserted as a literal.
      // It is true today only because of the branch it sits in; a future edit moving that write must
      // not silently turn a measurement into a claim.
      assert.doesNotMatch(
        script,
        /^\s*foregroundIsGame\s*=\s*\$(true|false)\s*$/m,
        'foregroundIsGame must be written from $foregroundIsGame, not as a $true/$false literal',
      );
    });

    await test('rejects an unknown route rather than handing a caller a name it cannot branch on', () => {
      // A future script that grew a third route without this parser learning about it must not slip
      // through as a valid result: callers switch on `route`, and an unmodelled value would fall
      // through every branch silently.
      assert.equal(interpretPressKeyOutput('{"status":"sent","route":"keybdEvent","down":1,"up":1}\n'), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('keys smoke test crashed:', err);
  process.exit(1);
});
