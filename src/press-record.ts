/**
 * A small durable record of the last press-title-screen action game_enter took: which pid it
 * pressed Enter for, and the log's size at that moment. This is what lets game_enter distinguish
 * "pressed once, still loading" from "never pressed" across an MCP server restart. An in-process-only
 * record (the previous round's approach, a bare module variable) is lost the instant the server
 * process itself restarts -- a crash, a client reconnect, a rebuild during iteration -- which is an
 * ordinary event, not a rare one, and the game can easily still be mid-load when it happens. The
 * original finding was never scoped to one server process's uptime, so losing the record on restart
 * is a residual version of the same bug, not a different, acceptable one.
 *
 * Deliberately does NOT try to detect a stale record by inspecting the log's *content* (e.g. looking
 * for some "process started" line): nobody has measured what sunrise.log actually contains while
 * sitting at the title screen versus while loading, and building a fix on an unmeasured assumption
 * about that is exactly the kind of guess this project has already paid for twice. The only
 * staleness check here is the log's *size*: if it is now smaller than the size recorded at press
 * time, the log was replaced (truncated or recreated) since, so the record cannot refer to the game
 * session that is running now -- ignore it. This does not fully close Windows pid reuse in the
 * specific case where the engine does not truncate sunrise.log on a fresh start AND no server ever
 * observes the intervening "not running" state to invalidate the record itself; that residual is
 * documented, not hidden -- see the fix report for the reasoning.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface PressRecord {
  pid: number;
  /** The log's byte size, captured right before the press this record is for. */
  logSizeAtPress: number;
}

/**
 * Default location: `%LOCALAPPDATA%\sunrise-mcp\press-record.json`, falling back to the OS temp
 * directory if `LOCALAPPDATA` isn't set. `LOCALAPPDATA` is the conventional place small per-user
 * application state lives on Windows -- writable without elevation, and, deliberately, nowhere near
 * the game's own install directory (`SUNRISE_GAME_DIR`): mixing this server's bookkeeping into the
 * game's files would be surprising, and could be wiped by a game reinstall/update regardless. Built
 * with `path.win32` for the same reason `getLogPath()` in game.ts is: this only meaningfully
 * resolves under Windows node.exe, and a test overrides the path explicitly rather than relying on
 * this default, the same pattern `waitForTitleScreen`'s `logPath` parameter already established.
 */
function getDefaultPressRecordPath(): string {
  const base = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.length > 0 ? process.env.LOCALAPPDATA : tmpdir();
  return path.win32.join(base, 'sunrise-mcp', 'press-record.json');
}

function isPressRecord(value: unknown): value is PressRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === 'number' && typeof record.logSizeAtPress === 'number';
}

/**
 * Reads the press record, or null if it doesn't exist, can't be read, or doesn't parse into the
 * expected shape. Never throws: a missing or corrupt record just means game_enter falls back to the
 * same "no positive record" behavior as if this file had never existed -- exactly as safe as the
 * in-process version being unset, never a reason to fail the whole tool call.
 */
export async function readPressRecord(recordPath: string = getDefaultPressRecordPath()): Promise<PressRecord | null> {
  try {
    const text = await readFile(recordPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return isPressRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes the press record, replacing whatever was there. Writes to a temp file in the same
 * directory first and renames it into place (atomic on the same filesystem), so a crash mid-write
 * can never leave a half-written, corrupt file behind. Never throws: failing to persist this is a
 * missed optimization for the *next* call, not a reason to fail a press that already happened.
 */
export async function writePressRecord(record: PressRecord, recordPath: string = getDefaultPressRecordPath()): Promise<void> {
  try {
    const dir = path.win32.dirname(recordPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${recordPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record), 'utf8');
    await rename(tmpPath, recordPath);
  } catch (err) {
    console.error(
      `[sunrise-mcp] failed to persist the press record (non-fatal, a future retry may re-press instead of ` +
        `resuming): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Deletes the press record, if any. Called once game_enter observes the game is not running, since
 * whatever was recorded can no longer refer to a currently-running session. Best-effort: never
 * throws, and a failure here just leaves a stale record for `isPressRecordFresh`'s pid/size checks
 * to catch instead.
 */
export async function clearPressRecord(recordPath: string = getDefaultPressRecordPath()): Promise<void> {
  try {
    await rm(recordPath, { force: true });
  } catch {
    // Best effort; see the doc comment above.
  }
}

/**
 * Whether `record` is positive, current evidence that `currentPid` was already pressed for the game
 * session that is running right now. Pure: no I/O, just the comparison -- `currentPid` and
 * `currentLogSize` must already have been measured by the caller, at (or after) the same moment, for
 * the staleness check below to mean anything.
 *
 * A missing record, or one for a different pid, is never fresh: game_enter has no positive evidence
 * either way, so it falls back to its normal (unanchored, whole-file) title-screen wait, which is
 * what correctly presses a game genuinely still sitting, unpressed, at the title screen.
 *
 * A record for the *same* pid is only trusted if the log has not shrunk since it was recorded:
 * sunrise.log only grows while a process is writing to it, so a smaller size than what was recorded
 * means the file was replaced (truncated or recreated) since -- most likely a relaunch that happened
 * to have destiny2.exe's pid reused by Windows, or the log rotated some other way. Either way, the
 * record no longer describes the session that's running now, and must not be trusted.
 */
export function isPressRecordFresh(record: PressRecord | null, currentPid: number, currentLogSize: number): boolean {
  if (record === null) return false;
  if (record.pid !== currentPid) return false;
  return currentLogSize >= record.logSizeAtPress;
}

/**
 * Resolves whether `currentPid` was already pressed for, checking `cachedRecord` -- an in-process,
 * first-line cache the caller (index.ts) maintains alongside the durable file -- before ever
 * touching the file at all.
 *
 * This exists because `writePressRecord` never throws: an unwritable `%LOCALAPPDATA%`, a `mkdir`
 * failure, or a transient I/O error is swallowed and only logged. Without an in-process fallback, a
 * silently failed write would mean the *next* call in the very same server process -- no restart
 * needed -- finds no record either, and re-presses. `index.ts` sets `cachedRecord` unconditionally
 * right after a successful press, before it even attempts the file write, so a broken disk write
 * cannot cost this function its answer: if the cache alone already proves freshness, the file is
 * never consulted (that's the short-circuit below), which is also what this function's own tests
 * exercise directly -- a `readRecord` that would throw if called never gets the chance to.
 *
 * The cache is gated by the exact same `isPressRecordFresh` pid+log-size check as the file, not
 * trusted merely for existing: this is what stops the two sources from disagreeing in a way that
 * resurrects a record for a session it doesn't actually belong to (e.g. a cache left over from a
 * game session this process observed end, if some future change forgot to invalidate it -- today
 * `index.ts` clears both the cache and the file the moment the game is observed not running).
 */
export async function resolvePressedThisSession(
  cachedRecord: PressRecord | null,
  currentPid: number,
  currentLogSize: number,
  readRecord: () => Promise<PressRecord | null> = readPressRecord,
): Promise<boolean> {
  if (isPressRecordFresh(cachedRecord, currentPid, currentLogSize)) return true;
  const fileRecord = await readRecord();
  return isPressRecordFresh(fileRecord, currentPid, currentLogSize);
}
