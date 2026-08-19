/**
 * Windows-side game process and log helpers: launching destiny2.exe (and waiting for its window),
 * killing it, and tailing sunrise.log. None of this talks to the console endpoint — see
 * endpoint.ts for that.
 *
 * This module must run under Windows node.exe (see README.md). It shells out to powershell.exe
 * and taskkill.exe, and reads a Windows filesystem path — none of that exists under WSL.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { open as openFile, stat as statFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { getGameProcessInfo } from './tasklist.js';

const DEFAULT_GAME_DIR = 'E:\\Destiny_Sunrise';

// launch-game.ps1's own worst case is ~62s (2s kill-settle + up to 120 * 500ms polling). This
// leaves well over a minute of headroom so a slow machine doesn't trip Node's side of the timeout
// while the script itself is still legitimately waiting for the window.
const LAUNCH_TIMEOUT_MS = 180_000;

function getGameDir(): string {
  const fromEnv = process.env.SUNRISE_GAME_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_GAME_DIR;
}

function getModuleDir(): string {
  // Only ever evaluated when this module actually runs (under Windows node.exe), where
  // fileURLToPath yields a Windows-style path and path.win32 parses it correctly.
  return path.win32.dirname(fileURLToPath(import.meta.url));
}

function getLaunchScriptPath(): string {
  // dist/game.js -> ../scripts/launch-game.ps1, i.e. <repo root>/scripts/launch-game.ps1.
  return path.win32.join(getModuleDir(), '..', 'scripts', 'launch-game.ps1');
}

export function getLogPath(): string {
  return path.win32.join(getGameDir(), 'bin', 'x64', 'Sunrise', 'logs', 'sunrise.log');
}

export function getExePath(): string {
  return path.win32.join(getGameDir(), 'destiny2.exe');
}

/**
 * The Sunrise DLL's settings file — `bin\x64\Sunrise\settings.json`, *not* `bin\x64\settings.json`,
 * which nothing reads. `game_enter` needs it because one key in it (`client.hold_character_select`)
 * is read at boot and decides whether a chosen character can reach the client at all; see
 * `disableCharacterSelectHold` in character.ts.
 */
export function getSettingsPath(): string {
  return path.win32.join(getGameDir(), 'bin', 'x64', 'Sunrise', 'settings.json');
}

export interface LaunchResult {
  status: 'launched' | 'failed';
  pid?: number;
  message: string;
}

interface LaunchScriptOutput {
  ok: boolean;
  pid?: number;
  error?: string;
}

function isLaunchScriptOutput(value: unknown): value is LaunchScriptOutput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== 'boolean') return false;
  if ('pid' in record && record.pid !== undefined && typeof record.pid !== 'number') return false;
  if ('error' in record && record.error !== undefined && typeof record.error !== 'string') return false;
  return true;
}

/**
 * The script prints diagnostics plus exactly one JSON result line, via [Console]::Out.WriteLine
 * so PowerShell's success-stream formatter can't wrap it — but scan from the end for the first
 * line that actually parses as our shape anyway, rather than trusting it's strictly the last line,
 * in case something else gets appended to stdout ahead of us finding out about it.
 */
function parseLaunchOutput(stdout: string): LaunchScriptOutput | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const candidate of lines.slice().reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isLaunchScriptOutput(parsed)) return parsed;
    } catch {
      // Not JSON, or not our shape — keep scanning backwards for the real result line.
    }
  }
  return null;
}

/**
 * Starts destiny2.exe and waits for its window to appear, reusing the wait loop already written
 * in tools/capture-game.ps1 (via scripts/launch-game.ps1, which mirrors its launch+wait steps).
 * Leaves the game running: the endpoint answers from the title screen, before the player presses
 * anything, so an agent can talk to it immediately after this resolves.
 */
export function launchGame(): Promise<LaunchResult> {
  const gameDir = getGameDir();
  const scriptPath = getLaunchScriptPath();

  return new Promise<LaunchResult>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-GameDir', gameDir],
      { timeout: LAUNCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const parsed = parseLaunchOutput(stdout);
        if (parsed) {
          if (parsed.ok) {
            resolve({
              status: 'launched',
              ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
              message: 'destiny2.exe is running and its window is up. The console endpoint answers from the title screen.',
            });
          } else {
            resolve({
              status: 'failed',
              ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
              message: parsed.error ?? 'launch-game.ps1 reported failure without a message.',
            });
          }
          return;
        }

        if (error?.killed) {
          // Node gave up waiting and killed powershell.exe — but that only stops the *script*.
          // destiny2.exe was started detached from it, so it (and any window it opened) may well
          // still be alive; this tool just has no result to report. game_kill or a direct look at
          // the game window are the ways to find out what actually happened.
          resolve({
            status: 'failed',
            message:
              `launch-game.ps1 did not finish within ${LAUNCH_TIMEOUT_MS}ms and was killed. destiny2.exe was ` +
              'started detached from it and may still be running (or still opening its window) regardless — ' +
              'check with game_kill or by looking at the game directly rather than assuming it never started.',
          });
          return;
        }

        const detail = [error?.message, stderr.trim(), stdout.trim() && `stdout: ${stdout.trim()}`]
          .filter((part): part is string => Boolean(part))
          .join('\n');
        resolve({
          status: 'failed',
          message: detail || 'launch-game.ps1 produced no parseable output.',
        });
      },
    );
  });
}

export interface KillResult {
  status: 'killed' | 'notRunning' | 'failed';
  message: string;
}

/** How long to wait for a killed destiny2.exe to actually leave the process table. */
const KILL_SETTLE_TIMEOUT_MS = 15_000;

/** Gap between process-table checks while waiting for the kill to take effect. */
const KILL_SETTLE_POLL_MS = 200;

/**
 * Waits until `probe` stops reporting the game as running.
 *
 * `taskkill /F` returns as soon as Windows has *asked* for the termination, not once it has
 * happened, so its own SUCCESS line is not evidence the process is gone. Measured 2026-08-19: a
 * `game_enter` call issued 200 ms after `game_kill` reported SUCCESS still found destiny2.exe in
 * `tasklist`, took the "already running, world already loaded" branch on the strength of the dead
 * process's own log, and reported against a console endpoint that had stopped answering. Without a
 * character asked for, that path returns a plain `ok` -- i.e. the sequence `game_kill` then
 * `game_enter`, which several of this server's own failure messages tell a caller to run, could
 * answer success without the game ever having restarted.
 *
 * Exported and taking its probe as a parameter so the settle loop can be driven by a test with no
 * Windows and no game: the loop is the part with the bug in it, and `taskkill.exe` is not.
 *
 * @param probe Reads the current process state, e.g. `getGameProcessInfo`.
 * @param timeoutMs How long to keep checking before giving up.
 * @param pollMs Gap between checks.
 * @returns True once the game is observed gone; false if it was still there at the deadline.
 */
export async function waitForGameToExit(
  probe: () => Promise<{ running: boolean }>,
  timeoutMs: number = KILL_SETTLE_TIMEOUT_MS,
  pollMs: number = KILL_SETTLE_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probe()).running) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

function runTaskkill(): Promise<KillResult> {
  return new Promise<KillResult>((resolve) => {
    execFile('taskkill.exe', ['/IM', 'destiny2.exe', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (!error) {
        resolve({ status: 'killed', message: output || 'destiny2.exe was terminated.' });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : undefined;
      if (code === 128 || /not found/i.test(output)) {
        resolve({ status: 'notRunning', message: output || 'destiny2.exe was not running.' });
        return;
      }
      resolve({ status: 'failed', message: output || error.message });
    });
  });
}

/**
 * Runs `taskkill /IM destiny2.exe /F` and waits for the process to actually be gone. Treats
 * "no such process" as a clean, non-error outcome.
 *
 * The wait is what makes this tool's answer mean what it says -- see `waitForGameToExit`. A process
 * that is still there at the deadline is still reported as `killed` (the kill was accepted; only
 * the waiting ran out), but the message says so rather than leaving the caller to find out through
 * some other tool's confusing answer.
 */
export async function killGame(): Promise<KillResult> {
  const result = await runTaskkill();
  if (result.status !== 'killed') return result;
  const gone = await waitForGameToExit(getGameProcessInfo);
  return gone
    ? { status: 'killed', message: `${result.message} The process is gone from the process table.` }
    : {
        status: 'killed',
        message:
          `${result.message} It was still listed by tasklist ${KILL_SETTLE_TIMEOUT_MS}ms later, so anything ` +
          'that checks whether the game is running may still see it. Call this again, or check with tasklist, ' +
          'before relying on the game being gone.',
      };
}

export interface LogReadResult {
  path: string;
  lines: string[];
  /** True when the tail read hit its byte cap before reaching the start of the file. */
  truncated: boolean;
}

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 1000;
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Returns the last `count` lines of sunrise.log without ever loading the whole file: it opens the
 * file, seeks to at most MAX_LOG_READ_BYTES from the end, and reads only that window.
 */
async function tailLines(filePath: string, count: number): Promise<{ lines: string[]; truncated: boolean }> {
  const handle = await openFile(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) return { lines: [], truncated: false };

    const readLength = Math.min(size, MAX_LOG_READ_BYTES);
    const start = size - readLength;
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, start);

    let text = buffer.toString('utf8');
    if (start > 0) {
      // We may have started mid-line; drop everything up to (and including) the first newline,
      // since we can't tell whether it's a complete line without reading further back.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    const allLines = text.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop(); // Drop the empty entry a trailing newline produces.
    }

    return { lines: allLines.slice(-count), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Reads the tail of sunrise.log. Throws if the file doesn't exist (e.g. the game never ran). */
export async function readLog(requestedLines?: number): Promise<LogReadResult> {
  const count = clamp(requestedLines ?? DEFAULT_LOG_LINES, 1, MAX_LOG_LINES);
  const logPath = getLogPath();

  try {
    await statFile(logPath);
  } catch {
    throw new Error(`sunrise.log not found at ${logPath}. Has the game been launched at least once?`);
  }

  const { lines, truncated } = await tailLines(logPath, count);
  return { path: logPath, lines, truncated };
}
