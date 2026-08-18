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
 * The title screen precedes every hook this project installs, so an OS-level keystroke is the only
 * door open there.
 *
 * The measurement behind that choice was redone on 2026-08-18, this time reading every Win32 return
 * value instead of discarding it, and it changed two things (see `press-title-screen-key.ps1`'s
 * header for the full record):
 *
 * - The old script's `SendInput` never carried a key. PowerShell hands back a *copy* when you read
 *   a value-type field, so its `$down.ki.wVk = 13` was thrown away and the struct marshalled to
 *   `SendInput` held `wVk = 0` -- a null keystroke the OS reports as delivered. That, not the
 *   foreground, is why pressing Enter stopped working.
 * - `PostMessage`/`SendMessage` of WM_KEYDOWN/WM_KEYUP/WM_CHAR do not move this engine's title
 *   screen at all -- not at the visible window, not at the hidden 'Tiger Input Window' the process
 *   also owns, not at either window's thread queue. The engine reads the keyboard below the message
 *   queue (Raw Input or DirectInput), which the OS serves only to the foreground application.
 *
 * So `SendInput` stays the primary route, and `PostMessage` is the fallback -- and the result says
 * which one ran. What did change is that the script now *takes and verifies* the foreground before
 * injecting anything. Layer 2's design knowingly accepted that `SendInput` goes to whatever window
 * has focus, so a press could land in whatever the user had alt-tabbed to; that defect is gone,
 * because the keystroke is injected only once `GetForegroundWindow()` has been read back and found
 * to be the game's own window. If the foreground cannot be taken, nothing is injected at all and
 * the script falls back to `PostMessage`, which targets a HWND and so cannot leak anywhere either.
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

/**
 * Which of `press-title-screen-key.ps1`'s two routes delivered the keystroke. Callers branch on
 * this, so it is a closed union rather than a free string: `'sendInput'` is the primary route and
 * the only one measured to move the title screen; `'postMessage'` is the fallback the script takes
 * when it could not bring the game to the foreground, which reaches the window but was measured not
 * to move this engine's title screen. A result naming `postMessage` therefore means "the press
 * probably did nothing, and here is exactly why" -- see this file's header comment.
 */
export type PressRoute = 'sendInput' | 'postMessage';

export interface PressResult {
  /** 'sent' means the named route reported delivering the keystroke; 'no-game' means destiny2.exe
   *  was not running; 'failed' covers a zero SendInput count, a refused PostMessage, or any other
   *  script-level problem. */
  status: 'sent' | 'no-game' | 'failed';
  /** The route that ran. Absent only when nothing was attempted (no game) or the script produced
   *  no parseable result at all. */
  route?: PressRoute;
  /** Whether the game's window actually held the OS foreground at the moment of the press. */
  foregroundIsGame?: boolean;
  down?: number;
  up?: number;
  message: string;
}

interface PressKeyScriptOutput {
  status: 'sent' | 'no-game' | 'failed';
  route?: PressRoute;
  foregroundIsGame?: boolean;
  down?: number;
  up?: number;
  postedDown?: boolean;
  postedUp?: boolean;
  error?: string;
}

function isOptionalType(record: Record<string, unknown>, key: string, type: 'number' | 'boolean' | 'string'): boolean {
  if (!(key in record) || record[key] === undefined || record[key] === null) return true;
  return typeof record[key] === type;
}

function isPressKeyScriptOutput(value: unknown): value is PressKeyScriptOutput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== 'sent' && record.status !== 'no-game' && record.status !== 'failed') return false;
  if ('route' in record && record.route !== undefined && record.route !== 'sendInput' && record.route !== 'postMessage') {
    return false;
  }
  for (const key of ['down', 'up'] as const) {
    if (!isOptionalType(record, key, 'number')) return false;
  }
  for (const key of ['foregroundIsGame', 'postedDown', 'postedUp'] as const) {
    if (!isOptionalType(record, key, 'boolean')) return false;
  }
  return isOptionalType(record, 'error', 'string');
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

/**
 * Turns the script's stdout into a `PressResult`, or null if nothing in it parsed as a result line
 * (which the caller distinguishes from a real outcome -- a killed process, a PowerShell error).
 *
 * Pure, and exported so the keys smoke test can drive every branch of it without a running game:
 * the process spawn and the Win32 calls are what need the game, the interpretation of what they
 * answered is not, and that interpretation is where the route name a caller branches on is decided.
 */
export function interpretPressKeyOutput(stdout: string): PressResult | null {
  const parsed = parsePressKeyOutput(stdout);
  if (!parsed) return null;

  if (parsed.status === 'no-game') {
    return { status: 'no-game', message: 'destiny2.exe is not running.' };
  }

  const route = parsed.route;

  if (parsed.status === 'failed') {
    return {
      status: 'failed',
      ...(route !== undefined ? { route } : {}),
      message: parsed.error ?? 'press-title-screen-key.ps1 reported failure without a message.',
    };
  }

  if (route === 'postMessage') {
    // The script only takes this route when it could not bring the game to the foreground, and it
    // reports 'sent' for it when both posts were accepted. Do not upgrade that into a claim the
    // press worked: PostMessage was measured not to move this engine's title screen. Whether the
    // game actually moved is decided by the log wait in game_enter, not here.
    return {
      status: 'sent',
      route,
      ...(parsed.foregroundIsGame !== undefined ? { foregroundIsGame: parsed.foregroundIsGame } : {}),
      message:
        'The game could not be brought to the foreground, so Enter was posted to its window with ' +
        'PostMessage instead of injected with SendInput. That reaches the right window and leaks ' +
        'nothing, but this engine was measured not to react to posted key messages, so the title ' +
        'screen has most likely not moved.',
    };
  }

  const down = parsed.down ?? 0;
  const up = parsed.up ?? 0;
  if (down === 0 || up === 0) {
    // SendInput returning 0 with no thrown error is exactly the failure mode the 40-byte INPUT
    // struct layout guards against (see press-title-screen-key.ps1) -- treat it as an explicit
    // failure, not a success, rather than trusting the 'sent' status alone.
    return {
      status: 'failed',
      route: 'sendInput',
      down,
      up,
      message:
        `SendInput reported down=${down} up=${up}; a zero count means the OS did not accept the ` +
        'injected input (e.g. the target window blocking synthetic input).',
    };
  }

  return {
    status: 'sent',
    route: 'sendInput',
    // Reported, never assumed: this is the fact the whole no-leak argument rests on, so if the
    // script ever stops saying it, the result says nothing rather than claiming it was confirmed.
    ...(parsed.foregroundIsGame !== undefined ? { foregroundIsGame: parsed.foregroundIsGame } : {}),
    down,
    up,
    message: 'Sent Enter to the game as an OS-level SendInput keystroke, with its window confirmed in the foreground.',
  };
}

// The script's own worst case is about four seconds (400ms between minimize and restore, up to 2s
// polling for the foreground to change, a 1.2s settle before injecting, then the 250ms default
// hold), plus PowerShell startup overhead. This leaves generous headroom.
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
 * Presses Enter on the game, bringing its window to the foreground and confirming it got there
 * first, then injecting the keystroke with `SendInput` -- falling back to `PostMessage` at the
 * window if the foreground could not be taken. `PressResult.route` names which one ran. See this
 * file's header comment for why that order, and why the foreground step is what removes the
 * keystroke-leak defect rather than adding one.
 *
 * Resolves cleanly with `status: 'no-game'` if destiny2.exe is not running, rather than throwing --
 * that branch is testable without the game.
 *
 * Not provable end-to-end without a running game: this only confirms the process spawns and reports
 * the no-game case cleanly. The interpretation of what the script answered is `interpretPressKeyOutput`,
 * which is pure and covered directly by the keys smoke test.
 */
export function pressTitleScreenKey(): Promise<PressResult> {
  const scriptPath = getPressKeyScriptPath();

  return new Promise<PressResult>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: PRESS_KEY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const interpreted = interpretPressKeyOutput(stdout);
        if (interpreted) {
          resolve(interpreted);
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
