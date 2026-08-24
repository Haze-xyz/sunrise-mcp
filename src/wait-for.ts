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

export type WaitReason = 'timeout' | 'gameDied' | 'rotated';

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
    if (window.state === 'rotated') {
      seen.push(...window.records);
      return finish({ matched: false, reason: 'rotated' });
    }
    for (const record of window.records) {
      seen.push(record);
      if (!matchesFilter(record, options.filter)) continue;
      matches += 1;
      if (matches >= wanted) return finish({ matched: true, line: record.raw });
    }

    // Checked every turn, not only at the deadline: a wait the game can no longer satisfy should
    // cost a second, not a minute.
    if (!(await deps.isGameAlive())) return finish({ matched: false, reason: 'gameDied' });

    const elapsed = deps.now() - started;
    if (elapsed >= options.timeoutMs) return finish({ matched: false, reason: 'timeout' });

    deps.onProgress?.(elapsed);
    await deps.sleep(Math.min(options.pollMs, options.timeoutMs - elapsed));
  }
}
