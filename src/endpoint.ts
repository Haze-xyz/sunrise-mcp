/**
 * Client for the Sunrise console endpoint.
 *
 * This file knows nothing about MCP. It opens a TCP socket to the endpoint the Sunrise game DLL
 * exposes on loopback, writes one JSON object per line, and resolves the matching promise when a
 * reply carrying the same `id` comes back. That is the whole contract, which is what makes it
 * testable with a ten-line fake server instead of the real game (see scripts/endpoint-smoke.mjs).
 *
 * Wire protocol (proven against the live game, see task-7-brief.md):
 *   -> {"id":1,"line":"movement.fly_speed 55"}
 *   <- {"id":1,"status":"ok","summary":"","rows":[{"key":"movement.fly_speed","value":55}]}
 *
 *   -> {"id":2,"describe":true}
 *   <- {"id":2,"status":"ok","entries":[{"name":"...","kind":"...","help":"..."}]}
 *
 * `status` is always a name (ok, unknownName, wrongArgumentCount, badArgument, outOfRange,
 * refused, failed), never a number. A response never contains a newline, so `\n` is a reliable
 * frame delimiter, even though a `describe` reply can be up to ~128 KB and arrive split across
 * many TCP segments.
 *
 * Endpoint constraints this client has to respect (see task-7-brief.md for how each was learned):
 *   - Only one connection is accepted at a time; a second is accepted then immediately closed.
 *   - `id` must be a non-zero JSON number. Zero means "absent".
 *   - The endpoint never times out a request on its own, so this client enforces its own
 *     per-request timeout and rejects the pending promise when it fires.
 *   - The maximum request envelope is 512 bytes. An over-long request is rejected client-side
 *     with a clear error instead of being sent and coming back as an uncorrelatable `id: 0`.
 *   - Two classes of failure answer on `id: 0`: an over-long envelope, and a request so malformed
 *     no id could even be parsed. Such a reply can never be matched to a pending request, so it is
 *     surfaced as an `unmatchedResponse` event rather than dropped or misapplied to some other
 *     pending call.
 *   - Reconnecting immediately after a connection closes can race the endpoint's own reaping of
 *     the old connection slot, producing `stage=accept result=busy` on the game side. This client
 *     waits a minimum gap after any close, and backs off further after repeated connect failures.
 *
 * Retry policy (a request-level concern, not just a connection-level one): a request whose
 * connection attempt fails, or whose connection is closed before the socket has ever completed a
 * single full round trip, is retried on a fresh connection until the request's own timeout is
 * exhausted. This is what lets `console_run` recover from being called the instant after
 * `game_launch` resolves, before the endpoint's listener is necessarily bound yet, and from the
 * endpoint's busy-connection-slot race — in both cases nothing could have reached the game, so
 * re-sending is safe. Once a connection has proven itself with at least one real response, a
 * later drop is NOT retried automatically: the game may already have processed that request, and
 * silently re-sending a console line risks running it twice. That failure is surfaced immediately
 * instead.
 */

import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

export type EndpointStatus =
  | 'ok'
  | 'unknownName'
  | 'wrongArgumentCount'
  | 'badArgument'
  | 'outOfRange'
  | 'refused'
  | 'failed';

const KNOWN_STATUSES: ReadonlySet<string> = new Set<EndpointStatus>([
  'ok',
  'unknownName',
  'wrongArgumentCount',
  'badArgument',
  'outOfRange',
  'refused',
  'failed',
]);

/** Validates a wire status string against the known set, rather than casting it unchecked. */
function toEndpointStatus(value: string): EndpointStatus {
  return KNOWN_STATUSES.has(value) ? (value as EndpointStatus) : 'failed';
}

export interface RunRow {
  key: string;
  value: unknown;
}

export interface RunResponse {
  id: number;
  status: EndpointStatus;
  summary: string;
  rows: RunRow[];
}

export interface DescribeEntry {
  name: string;
  kind: string;
  help: string;
  [extra: string]: unknown;
}

export interface DescribeResponse {
  id: number;
  status: EndpointStatus;
  entries: DescribeEntry[];
}

/** A decoded line from the endpoint that at least has a numeric id and a status name. */
interface RawFrame {
  id: number;
  status: string;
  [extra: string]: unknown;
}

function isRawFrame(value: unknown): value is RawFrame {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'number' && typeof record.status === 'string';
}

export interface SunriseEndpointOptions {
  /** Defaults to the SUNRISE_ENDPOINT_HOST env var, then 127.0.0.1. */
  host?: string;
  /** Defaults to the SUNRISE_ENDPOINT_PORT env var, then 30975. */
  port?: number;
  /** Per-request timeout in milliseconds, and the retry budget described above. The endpoint itself never times out a request. */
  requestTimeoutMs?: number;
  /** Matches the endpoint's own envelope limit; requests over this are rejected client-side. */
  maxRequestBytes?: number;
  /** Minimum gap, in ms, enforced between a connection closing and the next connect attempt. */
  minReconnectDelayMs?: number;
  /** Backoff schedule, in ms, applied after consecutive connect failures. The last value repeats. */
  reconnectBackoffMs?: number[];
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 30975;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 512;
const DEFAULT_MIN_RECONNECT_DELAY_MS = 250;
const DEFAULT_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000];

export class EndpointConnectionError extends Error {
  override readonly name = 'EndpointConnectionError';
  constructor(message: string, override readonly cause?: Error) {
    super(message);
  }
}

export class EndpointTimeoutError extends Error {
  override readonly name = 'EndpointTimeoutError';
  constructor(readonly requestId: number, readonly timeoutMs: number) {
    super(`Request ${requestId} to the Sunrise endpoint timed out after ${timeoutMs}ms.`);
  }
}

export class EndpointRequestTooLargeError extends Error {
  override readonly name = 'EndpointRequestTooLargeError';
  constructor(readonly byteLength: number, readonly maxBytes: number) {
    super(
      `Request envelope is ${byteLength} bytes, which exceeds the endpoint's ${maxBytes}-byte limit. ` +
        'Rejected client-side rather than sent, since an over-long envelope comes back as an uncorrelatable id: 0.',
    );
  }
}

/** Returned once `close()` has been called; the client is terminal from that point on. */
export class EndpointClosedError extends Error {
  override readonly name = 'EndpointClosedError';
  constructor(message = 'The endpoint client was closed.') {
    super(message);
  }
}

/** An id: 0 reply, or a line so malformed no id could be parsed. Cannot be matched to a request. */
export class EndpointUnmatchedResponseError extends Error {
  override readonly name = 'EndpointUnmatchedResponseError';
  constructor(message: string, readonly frame?: RawFrame) {
    super(message);
  }
}

interface PendingRequest {
  resolve: (frame: RawFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maintains a single persistent connection to the Sunrise console endpoint, reconnecting on
 * demand when the connection has dropped. Emits `protocolError` and `unmatchedResponse` for
 * traffic that cannot be attached to any pending request; emits `connectionError` for socket-level
 * errors on an already-established connection. None of these events have listeners required —
 * they exist so a host (e.g. the MCP server) can log them without the client throwing on the
 * network's own timeline.
 *
 * `close()` is terminal: once called, the client never reconnects again. Construct a new instance
 * if you need the endpoint again.
 */
export class SunriseEndpointClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly minReconnectDelayMs: number;
  private readonly reconnectBackoffMs: number[];

  private socket: Socket | null = null;
  private connectPromise: Promise<Socket> | null = null;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();
  private idCounter = 0;
  private lastCloseAt = 0;
  private reconnectFailures = 0;
  /** True once the *current* connection has completed at least one full request/response round trip. */
  private connectionHasSucceeded = false;
  private closed = false;

  constructor(options: SunriseEndpointOptions = {}) {
    super();
    this.host = options.host ?? process.env.SUNRISE_ENDPOINT_HOST ?? DEFAULT_HOST;
    const envPort = process.env.SUNRISE_ENDPOINT_PORT;
    this.port = options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.minReconnectDelayMs = options.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_DELAY_MS;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
  }

  /** Sends a console line and resolves with its structured response. */
  async runLine(line: string): Promise<RunResponse> {
    const frame = await this.sendRequest({ line });
    return {
      id: frame.id,
      status: toEndpointStatus(frame.status),
      summary: typeof frame.summary === 'string' ? frame.summary : '',
      rows: Array.isArray(frame.rows) ? (frame.rows as RunRow[]) : [],
    };
  }

  /** Fetches the full command/variable registry. */
  async describe(): Promise<DescribeResponse> {
    const frame = await this.sendRequest({ describe: true });
    return {
      id: frame.id,
      status: toEndpointStatus(frame.status),
      entries: Array.isArray(frame.entries) ? (frame.entries as DescribeEntry[]) : [],
    };
  }

  /**
   * Terminal shutdown: closes the connection (and cancels any connect attempt in progress, even
   * one still waiting out its reconnect delay), and rejects every request still waiting on a
   * reply. No further reconnects happen after this resolves.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.failAllPending(new EndpointClosedError());

    // A connect may be in flight (mid-backoff-delay, mid-handshake, or holding a fresh socket
    // that hasn't been assigned to `this.socket` yet). Let it settle — connectNow() and its
    // onConnect handler both check `this.closed` and self-destroy rather than adopting a socket
    // once it's set — before checking what, if anything, is actually still live.
    const pendingConnect = this.connectPromise;
    if (pendingConnect) {
      await pendingConnect.catch(() => undefined);
    }

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
    });
  }

  private nextRequestId(): number {
    do {
      this.idCounter = (this.idCounter % 0x7fffffff) + 1;
    } while (this.pending.has(this.idCounter));
    return this.idCounter;
  }

  private sendRequest(fields: Record<string, unknown>): Promise<RawFrame> {
    const id = this.nextRequestId();
    const text = JSON.stringify({ id, ...fields });
    const byteLength = Buffer.byteLength(text, 'utf8') + 1; // +1 for the trailing newline.
    if (byteLength > this.maxRequestBytes) {
      return Promise.reject(new EndpointRequestTooLargeError(byteLength, this.maxRequestBytes));
    }

    return new Promise<RawFrame>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        this.pending.delete(id);
        fn();
      };

      const overallTimer = setTimeout(() => {
        finish(() => reject(new EndpointTimeoutError(id, this.requestTimeoutMs)));
      }, this.requestTimeoutMs);

      // See the class-level "Retry policy" doc comment for the reasoning behind this condition.
      const onAttemptFailure = (err: Error): void => {
        if (settled) return;
        if (this.closed || err instanceof EndpointClosedError || this.connectionHasSucceeded) {
          finish(() => reject(err));
          return;
        }
        attempt();
      };

      const attempt = (): void => {
        if (settled) return;

        this.pending.set(id, {
          resolve: (frame) => finish(() => resolve(frame)),
          reject: onAttemptFailure,
          timer: overallTimer,
        });

        this.ensureConnected()
          .then((socket) => {
            if (settled) return;
            socket.write(`${text}\n`, 'utf8', (err) => {
              if (!err || settled) return;
              this.pending.delete(id);
              onAttemptFailure(new EndpointConnectionError(`Failed to write request ${id}: ${err.message}`, err));
            });
          })
          .catch((err: unknown) => {
            this.pending.delete(id);
            onAttemptFailure(err instanceof Error ? err : new EndpointConnectionError(String(err)));
          });
      };

      attempt();
    });
  }

  private ensureConnected(): Promise<Socket> {
    if (this.closed) {
      return Promise.reject(new EndpointClosedError());
    }
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectNow().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async connectNow(): Promise<Socket> {
    const gapNeeded = this.lastCloseAt === 0 ? 0 : this.minReconnectDelayMs - (Date.now() - this.lastCloseAt);
    const backoff = this.reconnectFailures > 0 ? this.backoffDelay() : 0;
    const waitMs = Math.max(gapNeeded, backoff, 0);
    if (waitMs > 0) {
      await delay(waitMs);
    }
    if (this.closed) {
      throw new EndpointClosedError();
    }

    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });

      const onConnect = () => {
        socket.off('error', onInitialError);
        if (this.closed) {
          socket.destroy();
          reject(new EndpointClosedError());
          return;
        }
        this.reconnectFailures = 0;
        this.attachSocket(socket);
        resolve(socket);
      };
      const onInitialError = (err: Error) => {
        socket.off('connect', onConnect);
        this.reconnectFailures += 1;
        reject(new EndpointConnectionError(`Could not connect to ${this.host}:${this.port}: ${err.message}`, err));
      };

      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
    });
  }

  private backoffDelay(): number {
    const idx = Math.min(this.reconnectFailures - 1, this.reconnectBackoffMs.length - 1);
    return this.reconnectBackoffMs[Math.max(idx, 0)] ?? 0;
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.recvBuffer = Buffer.alloc(0);
    this.connectionHasSucceeded = false;

    socket.on('data', (chunk: Buffer) => this.onData(chunk));

    socket.on('error', (err: Error) => {
      this.emit('connectionError', err);
    });

    socket.once('close', () => {
      this.lastCloseAt = Date.now();
      if (this.socket === socket) {
        this.socket = null;
      }
      this.failAllPending(
        new EndpointConnectionError('The connection to the Sunrise endpoint closed while this request was pending.'),
      );
    });
  }

  private onData(chunk: Buffer): void {
    this.recvBuffer = this.recvBuffer.length === 0 ? chunk : Buffer.concat([this.recvBuffer, chunk]);

    let newlineIndex: number;
    // Scanning raw bytes for 0x0A (ASCII \n) is safe even mid-multi-byte-UTF-8-sequence: in valid
    // UTF-8, 0x0A never appears as a continuation byte, only ever as a standalone ASCII newline.
    while ((newlineIndex = this.recvBuffer.indexOf(0x0a)) !== -1) {
      const lineBuf = this.recvBuffer.subarray(0, newlineIndex);
      this.recvBuffer = this.recvBuffer.subarray(newlineIndex + 1);
      this.handleLine(lineBuf.toString('utf8'));
    }
  }

  private handleLine(text: string): void {
    if (text.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.emit(
        'protocolError',
        new EndpointUnmatchedResponseError(
          `Received a non-JSON line from the endpoint: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    if (!isRawFrame(parsed)) {
      this.emit(
        'protocolError',
        new EndpointUnmatchedResponseError('Received a line without a numeric id and status from the endpoint.'),
      );
      return;
    }

    if (parsed.id === 0) {
      // Either the request envelope was over-long, or so malformed no id could be parsed. Either
      // way this can never be matched to a specific pending request.
      this.emit(
        'unmatchedResponse',
        new EndpointUnmatchedResponseError(
          `The endpoint replied on id: 0 (status ${parsed.status}), which cannot be matched to a request.`,
          parsed,
        ),
      );
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      this.emit(
        'protocolError',
        new EndpointUnmatchedResponseError(`Received a response for unknown or already-settled request id ${parsed.id}.`),
      );
      return;
    }

    // A real, complete round trip on this connection: from here on, a drop is no longer safe to
    // silently retry, since the game may have processed whatever's still pending.
    this.connectionHasSucceeded = true;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  private failAllPending(err: Error): void {
    // Snapshot and clear first: a rejected entry's onAttemptFailure may retry synchronously,
    // re-populating `this.pending` for the same id. Deleting after the fact (as a naive
    // for-of-then-delete would) would remove that fresh retry entry instead of the stale one.
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(err);
    }
  }
}
