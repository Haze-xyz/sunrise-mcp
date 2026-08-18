/**
 * Getting the game past its title screen: waiting for the title screen to be ready, then pressing
 * Enter on it.
 *
 * This module must run under Windows node.exe (see README.md), same as game.ts: it shells out to
 * powershell.exe and reads a Windows filesystem path by default.
 *
 * `pressTitleScreenKey` is the one place in the whole Sunrise MCP project where sending a raw OS
 * keystroke via `SendInput` is the right tool. Everywhere else, key input reaches the game through
 * the DLL's own hook, which is installed once the game is far enough into its boot sequence to have
 * loaded Sunrise's code. A probe run against the real game on 2026-08-18 measured that the hook does
 * NOT reach the title screen: holding VK_RETURN through the hook for three seconds moved nothing.
 * `SendInput`, by contrast, worked immediately and the game went on to load all the way to
 * `successfully changed world to: orbit_d2`. The title screen precedes every hook this project
 * installs, so an OS-level keystroke is the only door open there.
 *
 * `SendInput` is deliberately not used anywhere else: it goes to whatever window currently has OS
 * foreground focus, not to a specific one, so it would leak keystrokes into whatever the user has
 * switched to. That is only acceptable here because the title screen is on screen for a few seconds
 * right at startup, and nowhere else in this project reaches for it.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getLogPath } from './game.js';

/** The line sunrise.log emits once the title screen is far enough along to accept input. */
export const TITLE_SCREEN_MARKER = "Entering state 'bootflow:start'";

/** The line sunrise.log emits once the world has finished loading after the title screen. */
export const WORLD_LOADED_MARKER = 'successfully changed world to: orbit_d2';

// Measured: the marker appeared 8s after launch in the probe run. This leaves generous headroom
// for a slower machine or a busier boot, the same way LAUNCH_TIMEOUT_MS in game.ts does over its
// own measured worst case.
const DEFAULT_TITLE_SCREEN_TIMEOUT_MS = 30_000;

// How often waitForLogMarker re-reads the log file. Deliberately short relative to the timeouts
// above so a short timeoutMs (see the smoke test) is still respected closely rather than being
// rounded up to this interval.
const LOG_POLL_INTERVAL_MS = 500;

/**
 * The byte size of `logPath` right now, or 0 if it doesn't exist yet. Lets a caller anchor
 * `waitForLogMarker`'s `sinceOffset` to "right now", so it can demand genuinely new evidence rather
 * than matching whatever the log already happened to contain -- see `waitForLogMarker`'s doc
 * comment for why that distinction matters.
 */
export async function currentLogSize(logPath: string = getLogPath()): Promise<number> {
  try {
    const { size } = await stat(logPath);
    return size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function logHasMarkerSince(logPath: string, marker: string, sinceOffset: number): Promise<boolean> {
  let buffer: Buffer;
  try {
    buffer = await readFile(logPath);
  } catch (err) {
    // ENOENT means sunrise.log hasn't been created yet (e.g. called right after launch, before the
    // game has written anything) -- that is "marker not seen yet", not an error worth throwing.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  // If the file is now smaller than the offset we started from, it was truncated or recreated
  // (e.g. log rotation) since sinceOffset was captured -- that offset no longer means anything
  // against this file, so treat the whole (now-smaller) file as new rather than reporting a
  // permanent false negative for the rest of this process's life.
  const effectiveOffset = buffer.length < sinceOffset ? 0 : sinceOffset;
  return buffer.subarray(effectiveOffset).toString('utf8').includes(marker);
}

/**
 * Polls `logPath` for a line containing `marker`, returning `true` the moment it appears and
 * `false` once `timeoutMs` has elapsed without it. Never sleeps a single fixed span in place of
 * actually watching for the marker: each iteration re-reads the file and re-checks the deadline, so
 * the wait ends as soon as the marker shows up rather than riding out a guessed duration, and it
 * never sleeps longer than the time remaining before the deadline.
 *
 * `sinceOffset` (bytes, default 0 -- the whole file) restricts a match to content at or after that
 * point in the file. This matters because sunrise.log is append-only: once a marker has been
 * written, it stays in the file for the rest of that process's life, so a whole-file check can't
 * tell "the game just reached this state" from "the game reached this state at some point in the
 * past and hasn't moved since". A caller that needs genuinely *new* evidence -- e.g. game_enter in
 * index.ts, right after a fresh launch, to avoid matching a not-yet-truncated previous session's
 * leftover marker, or right after pressing a key, to confirm that specific press actually did
 * something -- passes the log's size at that point as `sinceOffset`. Passing 0 (the default) keeps
 * the original whole-file behavior, which is still correct when nothing could be stale: nothing has
 * written a competing marker yet, so anything in the file is legitimate current evidence.
 *
 * With `timeoutMs` 0, this is a single immediate check: the deadline is already `Date.now()`, so the
 * loop checks once and returns without ever sleeping.
 */
export async function waitForLogMarker(
  marker: string,
  timeoutMs: number,
  logPath: string = getLogPath(),
  sinceOffset = 0,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await logHasMarkerSince(logPath, marker, sinceOffset)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(LOG_POLL_INTERVAL_MS, remaining));
  }
}

/**
 * Waits for the title screen to be ready to accept a keystroke, by watching sunrise.log for
 * `TITLE_SCREEN_MARKER`. `game_launch` resolving is not a usable readiness signal by itself: it
 * only waits for the game's window to exist, which the probe measured happening roughly 40s before
 * the title screen is actually ready -- a keystroke sent right after `game_launch` resolves is lost.
 *
 * `logPath` defaults to the real `sunrise.log` (via `getLogPath()`), overridable so a test can point
 * this at a temp file it writes incrementally instead: `getLogPath()` builds its path with
 * `path.win32`, which mangles a Linux-style temp path's separators, so a WSL-node test cannot reach
 * a real temp file through `SUNRISE_GAME_DIR` alone.
 *
 * `sinceOffset` is forwarded to `waitForLogMarker` -- see its doc comment for why a caller might
 * need to restrict the match to content appended after a specific point rather than the whole file.
 */
export async function waitForTitleScreen(
  timeoutMs: number = DEFAULT_TITLE_SCREEN_TIMEOUT_MS,
  logPath: string = getLogPath(),
  sinceOffset = 0,
): Promise<boolean> {
  return waitForLogMarker(TITLE_SCREEN_MARKER, timeoutMs, logPath, sinceOffset);
}

export interface PressResult {
  /** 'sent' means SendInput reported a non-zero down and up count; 'no-game' means destiny2.exe
   *  was not running; 'failed' covers a zero down/up count or any other script-level problem. */
  status: 'sent' | 'no-game' | 'failed';
  down?: number;
  up?: number;
  message: string;
}

interface PressKeyScriptOutput {
  status: 'sent' | 'no-game';
  down?: number;
  up?: number;
}

function isPressKeyScriptOutput(value: unknown): value is PressKeyScriptOutput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== 'sent' && record.status !== 'no-game') return false;
  if ('down' in record && record.down !== undefined && typeof record.down !== 'number') return false;
  if ('up' in record && record.up !== undefined && typeof record.up !== 'number') return false;
  return true;
}

/**
 * Mirrors game.ts's parseLaunchOutput: the script prints exactly one JSON result line via
 * [Console]::Out.WriteLine, but scan from the end for the first line that actually parses as our
 * shape anyway, rather than trusting it's strictly the last line PowerShell printed.
 */
function parsePressKeyOutput(stdout: string): PressKeyScriptOutput | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const candidate of lines.slice().reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPressKeyScriptOutput(parsed)) return parsed;
    } catch {
      // Not JSON, or not our shape -- keep scanning backwards for the real result line.
    }
  }
  return null;
}

// The script's own worst case is well under two seconds (a 400ms foreground-settle sleep plus a
// 250ms default hold), plus PowerShell startup overhead. This leaves generous headroom.
const PRESS_KEY_TIMEOUT_MS = 15_000;

function getModuleDir(): string {
  // Only ever evaluated when this module actually runs (under Windows node.exe), where
  // fileURLToPath yields a Windows-style path and path.win32 parses it correctly.
  return path.win32.dirname(fileURLToPath(import.meta.url));
}

function getPressKeyScriptPath(): string {
  // dist/keys.js -> ../scripts/press-title-screen-key.ps1, i.e. <repo root>/scripts/....
  return path.win32.join(getModuleDir(), '..', 'scripts', 'press-title-screen-key.ps1');
}

/**
 * Presses Enter on the game's foreground window via `SendInput` (see this file's header comment
 * for why `SendInput`, and only here). Resolves cleanly with `status: 'no-game'` if destiny2.exe is
 * not running, rather than throwing -- this branch is testable without the game.
 *
 * Not provable end-to-end without a running game: this only confirms the process spawns, parses its
 * output, and reports the no-game case cleanly.
 */
export function pressTitleScreenKey(): Promise<PressResult> {
  const scriptPath = getPressKeyScriptPath();

  return new Promise<PressResult>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: PRESS_KEY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const parsed = parsePressKeyOutput(stdout);
        if (parsed) {
          if (parsed.status === 'no-game') {
            resolve({ status: 'no-game', message: 'destiny2.exe is not running.' });
            return;
          }

          const down = parsed.down ?? 0;
          const up = parsed.up ?? 0;
          if (down === 0 || up === 0) {
            // SendInput returning 0 with no thrown error is exactly the failure mode the 40-byte
            // INPUT struct layout guards against (see press-title-screen-key.ps1) -- treat it as an
            // explicit failure, not a success, rather than trusting the 'sent' status alone.
            resolve({
              status: 'failed',
              down,
              up,
              message:
                `SendInput reported down=${down} up=${up}; a zero count means the OS did not accept the ` +
                'injected input (e.g. no foreground window, or the target window blocking synthetic input).',
            });
            return;
          }

          resolve({ status: 'sent', down, up, message: 'Sent Enter to the game as an OS-level SendInput keystroke.' });
          return;
        }

        if (error?.killed) {
          resolve({
            status: 'failed',
            message: `press-title-screen-key.ps1 did not finish within ${PRESS_KEY_TIMEOUT_MS}ms and was killed.`,
          });
          return;
        }

        const detail = [error?.message, stderr.trim(), stdout.trim() && `stdout: ${stdout.trim()}`]
          .filter((part): part is string => Boolean(part))
          .join('\n');
        resolve({
          status: 'failed',
          message: detail || 'press-title-screen-key.ps1 produced no parseable output.',
        });
      },
    );
  });
}
