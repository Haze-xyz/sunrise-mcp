/**
 * Parsing, filtering and summarising sunrise.log lines. Pure: no filesystem, no game, no clock.
 *
 * A line is a channel followed by key=value fields:
 *   client level=info t=113672 ev=shutdown result=ok
 * `text=` is emitted last by the C++ sink and its value may contain spaces, so it runs to the end
 * of the line; every other value stops at the next space.
 */

/** One parsed line. `raw` is kept because the digest hands lines back verbatim. */
export interface LogRecord {
  raw: string;
  /** First token, when it is not itself a key=value pair. '' when the line has no channel. */
  channel: string;
  /** 'error' | 'warn' | 'info' | 'debug', or '' when the line carries no readable level. */
  level: string;
  /** Milliseconds since the sink opened, or null. Resets to 0 when the game restarts. */
  t: number | null;
  /** The event name, or '' when absent. The digest groups on this and nothing else. */
  ev: string;
  fields: Record<string, string>;
}

/** Severity order, most severe first. A level outside this table is treated as unknown. */
const LEVEL_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Every field is optional; an absent field constrains nothing. */
export interface LogFilter {
  ev?: string[];
  /** A threshold, not an equality: 'info' keeps error, warn and info. */
  level?: LogLevel;
  channel?: string[];
  /** Case-insensitive substring of the whole raw line. */
  text?: string;
}

export function parseLogLine(raw: string): LogRecord {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const fields: Record<string, string> = {};
  let channel = '';
  let index = 0;

  const firstSpace = trimmed.indexOf(' ');
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (head.length > 0 && !head.includes('=')) {
    channel = head;
    index = firstSpace === -1 ? trimmed.length : firstSpace + 1;
  }

  while (index < trimmed.length) {
    const equals = trimmed.indexOf('=', index);
    if (equals === -1) break;
    const key = trimmed.slice(index, equals);
    if (key === 'text') {
      // The sink emits text last precisely because its value may contain spaces.
      fields.text = trimmed.slice(equals + 1);
      break;
    }
    let end = trimmed.indexOf(' ', equals + 1);
    if (end === -1) end = trimmed.length;
    fields[key] = trimmed.slice(equals + 1, end);
    index = end + 1;
  }

  const stamp = fields.t;
  return {
    raw: trimmed,
    channel,
    level: fields.level ?? '',
    t: stamp !== undefined && /^\d+$/.test(stamp) ? Number(stamp) : null,
    ev: fields.ev ?? '',
    fields,
  };
}

export function matchesFilter(record: LogRecord, filter: LogFilter): boolean {
  if (filter.ev !== undefined && !filter.ev.includes(record.ev)) return false;
  if (filter.channel !== undefined && !filter.channel.includes(record.channel)) return false;
  if (filter.level !== undefined) {
    const want = LEVEL_ORDER[filter.level];
    const have = LEVEL_ORDER[record.level];
    // An unreadable level is never filtered out: a malformed line may be the interesting one.
    if (want !== undefined && have !== undefined && have > want) return false;
  }
  if (filter.text !== undefined && !record.raw.toLowerCase().includes(filter.text.toLowerCase())) {
    return false;
  }
  return true;
}

/** An `ev` seen at most this many times is signal, and is handed back verbatim. */
export const DEFAULT_RARE_THRESHOLD = 5;

export interface DigestRow {
  ev: string;
  count: number;
  firstT: number | null;
  lastT: number | null;
}

export interface Digest {
  /** Frequent events, one row each, most frequent first. */
  rows: DigestRow[];
  /** Rare events and every warn/error, in the order they were logged. */
  verbatim: string[];
  /** How many records went in. */
  total: number;
}

/**
 * Summarises records by counting the frequent and keeping the rare.
 *
 * Grouped by `ev` ALONE. Sub-grouping ev=retail by site= was measured on the checked-in fixture and
 * is much worse: it turns one 422-line bucket into dozens of singletons, which are then all kept
 * verbatim, and the reduction falls from 96.1% (34 lines out) to 77.0% (203 lines out). The smoke
 * test asserts both numbers so this cannot be "improved" by accident.
 *
 * A warn or error line is kept verbatim even when its `ev` is frequent, and it also counts towards
 * that ev's row: the row says how often the event happened, the verbatim line says what went wrong.
 */
export function buildDigest(records: LogRecord[], rareThreshold: number = DEFAULT_RARE_THRESHOLD): Digest {
  const counts = new Map<string, DigestRow>();
  for (const record of records) {
    const row = counts.get(record.ev);
    if (row === undefined) {
      counts.set(record.ev, { ev: record.ev, count: 1, firstT: record.t, lastT: record.t });
      continue;
    }
    row.count += 1;
    if (row.firstT === null) row.firstT = record.t;
    if (record.t !== null) row.lastT = record.t;
  }

  const rows: DigestRow[] = [];
  const rare = new Set<string>();
  for (const row of counts.values()) {
    if (row.count <= rareThreshold) rare.add(row.ev);
    else rows.push(row);
  }
  rows.sort((left, right) => right.count - left.count);

  const verbatim = records
    .filter((record) => rare.has(record.ev) || record.level === 'warn' || record.level === 'error')
    .map((record) => record.raw);

  return { rows, verbatim, total: records.length };
}
