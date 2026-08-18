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
 * respected (and not rounded up to the poll interval) when it's shorter than a single poll; and the
 * log file simply not existing yet (the game hasn't written anything).
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
import { waitForTitleScreen, TITLE_SCREEN_MARKER } from '../dist/keys.js';

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
