/**
 * The opaque cursor a caller carries between log reads, and the two independent tests that catch
 * the game having rotated its log underneath us.
 *
 * Pure: it is handed a stat's worth of numbers, never a path. The rotation it defends against is
 * log.cpp:116 -- MoveFileExW(log, log.old, MOVEFILE_REPLACE_EXISTING) followed by CREATE_ALWAYS --
 * which the game performs at every single start. After it, a byte offset from the previous life
 * points into unrelated bytes, and `t=` has reset to zero as well.
 */

/** What a log read needs to know about the file it is about to read. */
export interface FileIdentity {
  /** "<ino>:<birthtimeMs>". Measured to change across a rotation: see scripts/log-identity-probe.mjs. */
  id: string;
  size: number;
}

/**
 * Builds the identity from a stat.
 *
 * Every field accepts a bigint, and every caller MUST stat with `{ bigint: true }`. A Windows NTFS
 * file id routinely runs past Number.MAX_SAFE_INTEGER -- the one measured by
 * scripts/log-identity-probe.mjs was 15481123719086430, well beyond 2^53 -- and above that
 * threshold a double cannot hold every integer. Two genuinely different ids then land on the same
 * number: 15481123719086431 and 15481123719086433 both become 15481123719086432.
 *
 * The failure has one direction and it is the bad one. It can only ever make two different files
 * look like the same file, never the reverse -- so a rotated log would read as resumable and the
 * next read would walk into unrelated bytes, which is the exact thing this cursor exists to stop.
 */
export function fileIdentity(stat: {
  ino: number | bigint;
  birthtimeMs: number | bigint;
  size: number | bigint;
}): FileIdentity {
  const birth =
    typeof stat.birthtimeMs === 'bigint' ? stat.birthtimeMs : BigInt(Math.trunc(stat.birthtimeMs));
  return { id: `${stat.ino}:${birth}`, size: Number(stat.size) };
}

export interface Cursor {
  v: 1;
  id: string;
  off: number;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** @returns The cursor, or null when the string is not one this version can read. */
export function decodeCursor(encoded: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  if (typeof record.off !== 'number' || !Number.isInteger(record.off) || record.off < 0) return null;
  return { v: 1, id: record.id, off: record.off };
}

export type CursorState =
  /** No cursor was supplied; the caller decides where to start. */
  | 'fresh'
  /** The cursor belongs to this file and points inside it. */
  | 'resumable'
  /** The file is not the one the cursor was taken from. */
  | 'rotated'
  /** The string is not a cursor this version can read. */
  | 'invalid';

/**
 * Decides where a read should start.
 *
 * Two independent rotation tests, and both are load-bearing. The identity test catches the ordinary
 * case. The size test catches the case the identity test cannot: Windows may hand back a recycled
 * file index, and then only "the file is smaller than my offset" says anything at all.
 *
 * `offset` is 0 for every state but `resumable`; what to do with a fresh or rotated read is the
 * caller's decision, not this function's.
 */
export function cursorState(
  encoded: string | undefined,
  identity: FileIdentity,
): { state: CursorState; offset: number } {
  if (encoded === undefined) return { state: 'fresh', offset: 0 };
  const cursor = decodeCursor(encoded);
  if (cursor === null) return { state: 'invalid', offset: 0 };
  if (cursor.id !== identity.id) return { state: 'rotated', offset: 0 };
  if (cursor.off > identity.size) return { state: 'rotated', offset: 0 };
  return { state: 'resumable', offset: cursor.off };
}
