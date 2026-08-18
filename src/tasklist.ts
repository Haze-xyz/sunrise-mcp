/**
 * Querying whether destiny2.exe is running, and its pid, via `tasklist`. Split out from index.ts so
 * the pure parsing logic (`parseTasklistCsv`) can be imported directly by a test without pulling in
 * index.ts's module-load side effect of connecting an MCP stdio transport.
 */

import { execFile } from 'node:child_process';

export interface GameProcessInfo {
  running: boolean;
  /** null when not running, or when running but the pid couldn't be parsed out of tasklist's output. */
  pid: number | null;
}

/**
 * Parses `tasklist /FI "IMAGENAME eq destiny2.exe" /FO CSV /NH`'s stdout. A match looks like
 * `"destiny2.exe","47400","Console","5","166,456 K"` (verified against a real Windows `tasklist.exe`
 * during Task 3's second review round); no match prints a plain, non-CSV, non-quoted
 * `INFO: No tasks are running which match the specified criteria.` line instead -- checking for the
 * leading `"` is what tells the two apart.
 */
export function parseTasklistCsv(stdout: string): GameProcessInfo {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  if (!firstLine.startsWith('"')) {
    return { running: false, pid: null }; // the "INFO: No tasks..." line, or nothing at all.
  }
  const fields = firstLine.split(',').map((field) => field.trim().replace(/^"|"$/g, ''));
  const imageName = fields[0] ?? '';
  if (!/^destiny2\.exe$/i.test(imageName)) return { running: false, pid: null };
  const pid = Number(fields[1]);
  return { running: true, pid: Number.isFinite(pid) ? pid : null };
}

/** Checks for a running destiny2.exe (and its pid) via `tasklist`, so `game_enter` (src/index.ts)
 *  only launches when it needs to, rather than unconditionally killing and restarting a game that
 *  may already be past the title screen (launchGame() itself always kills any existing instance
 *  first). The pid is what lets game_enter tell "never pressed" apart from "already pressed, still
 *  loading" -- see game-enter-decision.ts. */
export function getGameProcessInfo(): Promise<GameProcessInfo> {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq destiny2.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
      resolve(error ? { running: false, pid: null } : parseTasklistCsv(stdout));
    });
  });
}
