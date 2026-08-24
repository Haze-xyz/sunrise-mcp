/**
 * Waits for a log line to appear, with a deadline.
 *
 * Every effect is injected -- the reader, the liveness probe, the clock, the sleep -- so the loop
 * is testable without a game, without Windows and without waiting in real time.
 *
 * Two things this loop does that a naive one does not. It checks whether the game is still alive on
 * every turn, so a wait that can no longer be satisfied ends in a second rather than at the
 * deadline; over a night that is the difference between minutes and hours. And it treats its own
 * timeout as an ordinary answer carrying a cursor, because the MCP client -- not this server --
 * owns the request deadline (DEFAULT_REQUEST_TIMEOUT_MSEC = 60000 in the SDK), so a long wait has
 * to be a loop of short calls rather than one long call.
 */

import type { Digest, LogFilter, LogRecord } from './log-parse.js';
import { buildDigest, matchesFilter } from './log-parse.js';
import type { CursorState } from './log-cursor.js';

/** Kept under the SDK's 60s client-side request timeout, with room for the reply to travel. */
export const DEFAULT_WAIT_TIMEOUT_MS = 55_000;
export const MAX_WAIT_TIMEOUT_MS = 600_000;
export const DEFAULT_POLL_MS = 500;

/** What waitFor reads. Deliberately narrower than log-stream's own result. */
export interface WaitReadResult {
  records: LogRecord[];
  cursor: string;
  state: CursorState;
}

export interface WaitDeps {
  /** Reads everything logged since `since`, unfiltered: the digest needs the noise too. */
  readWindow(since: string | undefined): Promise<WaitReadResult>;
  isGameAlive(): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  onProgress?(waitedMs: number): void;
}

export interface WaitOptions {
  filter: LogFilter;
  /** Return on the nth match rather than the first. Default 1. */
  count?: number;
  timeoutMs: number;
  pollMs: number;
  since?: string;
}

export type WaitReason = 'timeout' | 'gameDied' | 'rotated' | 'cursorInvalid';

export interface WaitResult {
  matched: boolean;
  /** The matching line, when there is one. */
  line?: string;
  cursor: string;
  waitedMs: number;
  reason?: WaitReason;
  /** Everything seen while waiting, counted. This is why a caller can afford to wait at all. */
  digest: Digest;
}

export async function waitFor(deps: WaitDeps, options: WaitOptions): Promise<WaitResult> {
  const started = deps.now();
  const wanted = options.count ?? 1;
  const seen: LogRecord[] = [];
  let cursor = options.since;
  let matches = 0;

  const finish = (extra: { matched: boolean; line?: string; reason?: WaitReason }): WaitResult => ({
    matched: extra.matched,
    ...(extra.line !== undefined ? { line: extra.line } : {}),
    cursor: cursor ?? '',
    waitedMs: deps.now() - started,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    digest: buildDigest(seen),
  });

  for (;;) {
    const window = await deps.readWindow(cursor);
    cursor = window.cursor;

    // An invalid cursor means the caller's own bookkeeping was corrupt, so readWindow silently fell
    // back to a full scan from byte 0 of the file -- unlike a rotation, that scan can span hours of
    // history the caller has already read and acted on. Matching against it and calling the result
    // "matched" would report an old line as though it had just appeared, so this is checked, and
    // returned, BEFORE the match loop below -- the one exit reason that wins even over a match.
    if (window.state === 'invalid') return finish({ matched: false, reason: 'cursorInvalid' });

    // A rotation means the game restarted: whatever `matches` counted before this point belongs to
    // the life that just ended, and carrying it forward would let `count` be satisfied by summing
    // occurrences across two different lives of the game, one of them already gone. Reset before
    // scanning this window's own records, which are the new life's from its very first line -- a
    // match among them still wins over reporting the rotation (see below), it just cannot be topped
    // up by a count left over from before the restart.
    if (window.state === 'rotated') matches = 0;

    // The match is tested before every exit reason, rotation included, and that ordering carries
    // the correctness of this loop. A rotated read starts at the TOP of the new log, because
    // cursorState resets the offset to 0 -- so it routinely already holds the early-boot line a
    // caller is waiting for, ev=world_loaded above all. Reporting 'rotated' without testing those
    // records would drop the match and hand back a cursor pointing past it, and calling again could
    // never find it: across a game restart, the one event a caller most wants would be the one
    // event denied to it.
    for (const record of window.records) {
      seen.push(record);
      if (!matchesFilter(record, options.filter)) continue;
      matches += 1;
      if (matches >= wanted) return finish({ matched: true, line: record.raw });
    }

    if (window.state === 'rotated') return finish({ matched: false, reason: 'rotated' });

    // Checked every turn, not only at the deadline: a wait the game can no longer satisfy should
    // cost a second, not a minute.
    if (!(await deps.isGameAlive())) return finish({ matched: false, reason: 'gameDied' });

    const elapsed = deps.now() - started;
    if (elapsed >= options.timeoutMs) return finish({ matched: false, reason: 'timeout' });

    deps.onProgress?.(elapsed);
    await deps.sleep(Math.min(options.pollMs, options.timeoutMs - elapsed));
  }
}
