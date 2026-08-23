/**
 * Reads sunrise.log forward from a cursor, in chunks, applying the filter as it goes.
 *
 * This is deliberately not a tail. The tail in game.ts caps at 2 MB, and the log was measured at
 * 0.26 to 2.42 MB an hour, so a tail stops being able to reach the start of the night somewhere
 * between the first hour and the seventh. A forward read from a cursor has no such horizon.
 */

import { open as openFile, stat as statFile } from 'node:fs/promises';

import type { LogFilter, LogRecord } from './log-parse.js';
import { matchesFilter, parseLogLine } from './log-parse.js';
import type { CursorState, FileIdentity } from './log-cursor.js';
import { cursorState, encodeCursor, fileIdentity } from './log-cursor.js';

/** Most records one call hands back before it starts saying what it left behind. */
export const MAX_OUTPUT_LINES = 400;
/** Most bytes of raw line one call hands back. Whichever cap is reached first wins. */
export const MAX_OUTPUT_BYTES = 128 * 1024;
/** How much is pulled off the disk per read syscall. */
const CHUNK_BYTES = 256 * 1024;

export interface ReadWindowOptions {
  since?: string;
  filter?: LogFilter;
  maxLines?: number;
  maxBytes?: number;
}

export interface ReadWindowResult {
  records: LogRecord[];
  /** Feed this back as `since` on the next call. */
  cursor: string;
  state: CursorState;
  /** Matching lines this call could not fit. The cursor points at the first of them. */
  dropped: number;
  /** Complete lines read off the disk, matching or not. */
  scanned: number;
}

/**
 * @param logPath Path to the log, in the running platform's own form (it goes to fs).
 * @throws If the file does not exist -- which means the game has never run.
 */
export async function readWindow(logPath: string, options: ReadWindowOptions): Promise<ReadWindowResult> {
  let identity: FileIdentity;
  try {
    // {bigint: true} is load-bearing, not tidiness: see fileIdentity's comment in log-cursor.ts.
    identity = fileIdentity(await statFile(logPath, { bigint: true }));
  } catch {
    throw new Error(`sunrise.log not found at ${logPath}. Has the game been launched at least once?`);
  }

  const maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const filter = options.filter;
  const { state, offset } = cursorState(options.since, identity);

  const records: LogRecord[] = [];
  let scanned = 0;
  let dropped = 0;
  let emittedBytes = 0;
  /** Byte offset of the first matching line this call could not fit, once it exists. */
  let resumeAt: number | null = null;

  const handle = await openFile(logPath, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = offset;
    /** Bytes of a line already seen but not yet terminated by a newline. */
    let pending = '';
    /** Byte offset at which `pending` starts. */
    let pendingAt = offset;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      let text = pending + buffer.toString('utf8', 0, bytesRead);
      let lineStart = pendingAt;
      for (;;) {
        const newline = text.indexOf('\n');
        if (newline === -1) break;
        const line = text.slice(0, newline);
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        text = text.slice(newline + 1);
        scanned += 1;

        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (trimmed.length > 0) {
          const record = parseLogLine(trimmed);
          if (filter === undefined || matchesFilter(record, filter)) {
            const full = records.length >= maxLines || emittedBytes + trimmed.length > maxBytes;
            if (full) {
              dropped += 1;
              if (resumeAt === null) resumeAt = lineStart;
            } else {
              records.push(record);
              emittedBytes += trimmed.length;
            }
          }
        }
        lineStart += lineBytes;
      }
      pending = text;
      pendingAt = lineStart;
      if (bytesRead < CHUNK_BYTES) break;
    }

    // `pendingAt` is where the last complete line ended, so a half-written record -- the game is
    // still emitting it -- is left for the next call rather than parsed in two halves.
    const nextOffset = resumeAt ?? pendingAt;
    return {
      records,
      cursor: encodeCursor({ v: 1, id: identity.id, off: nextOffset }),
      state,
      dropped,
      scanned,
    };
  } finally {
    await handle.close();
  }
}
