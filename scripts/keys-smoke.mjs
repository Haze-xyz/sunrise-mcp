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
 * pressTitleScreenKey() is not covered here -- it shells out to a real destiny2.exe process check
 * and (with the game running) SendInput, neither of which this script can safely fake. Its no-game
 * branch is exercised separately; see the task report for how.
 */

import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { waitForTitleScreen, waitForLogMarker, currentLogSize, TITLE_SCREEN_MARKER } from '../dist/keys.js';

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
