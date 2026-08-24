/**
 * The journal: what was tried, what was found, and what crashed -- on disk, so a session that dies
 * is not a night lost.
 *
 * One rule outranks everything else in this file: a journal that cannot be written must never take
 * the server down. Every write returns a JournalWrite saying whether it landed; nothing here
 * throws. A tool that cannot journal is a tool that still works.
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getGameDir } from './game.js';

/** Where the journal lives: beside logs\, inside the artifact directory the DLL already owns. */
export interface JournalPaths {
  dir: string;
  state: string;
  calls: string;
  notes: string;
}

export function journalPaths(): JournalPaths {
  const fromEnv = process.env.SUNRISE_MCP_JOURNAL_DIR;
  const dir =
    fromEnv !== undefined && fromEnv.length > 0
      ? fromEnv
      : path.join(getGameDir(), 'bin', 'x64', 'Sunrise', 'mcp');
  return {
    dir,
    state: path.join(dir, 'state.json'),
    calls: path.join(dir, 'calls.jsonl'),
    notes: path.join(dir, 'notes.jsonl'),
  };
}

export interface CrashRecord {
  at: number;
  harvestDir: string;
}

export interface JournalState {
  /** The last game_enter that worked, so a supervisor restart can put the world back. */
  lastGameEnter: { args: Record<string, unknown>; at: number } | null;
  crashes: CrashRecord[];
  logCursor: string | null;
  goal: string | null;
}

const EMPTY_STATE: JournalState = { lastGameEnter: null, crashes: [], logCursor: null, goal: null };

export type NoteKind = 'finding' | 'goal' | 'attempt' | 'dead-end';

export interface Note {
  ts: number;
  kind: NoteKind;
  text: string;
}

export interface CallEntry {
  ts: number;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  ms: number;
}

/** Every write says whether it landed. Nothing in this module throws. */
export type JournalWrite = { status: 'ok' } | { status: 'unavailable'; reason: string };

/** Longest a serialised args blob may be before it is cut. A mem.write can carry a lot. */
const MAX_ARGS_CHARS = 500;
/** Longest a single note may be. */
const MAX_NOTE_CHARS = 1_000;
/** Roll calls.jsonl once it passes this. At one call a second over eight hours it reaches ~6 MB. */
const MAX_CALLS_BYTES = 32 * 1024 * 1024;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ensureDir(paths: JournalPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function isCrashRecord(value: unknown): value is CrashRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === 'number' &&
    Number.isFinite(record.at) &&
    typeof record.harvestDir === 'string'
  );
}

function isGameEnter(value: unknown): value is { args: Record<string, unknown>; at: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return false;
  return typeof record.args === 'object' && record.args !== null && !Array.isArray(record.args);
}

export async function readState(paths: JournalPaths): Promise<JournalState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.state, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY_STATE };
    const record = parsed as Record<string, unknown>;
    // Every field is checked against its declared type, not merely against "the file held an
    // object". A state.json half-written by a hard kill otherwise reaches buildResume intact and
    // fails quietly instead of loudly. Both measured on the unchecked version: `crashes: ["x"]`
    // made `lastCrash?.at` evaluate to String.prototype.at -- optional chaining only short-circuits
    // on null/undefined, and a string has an `.at` -- which is a function, which JSON.stringify
    // drops, so the lastCrashAt key vanished from the answer rather than reading null. And a
    // non-numeric `at` made minutesSinceLastEnter NaN, which serialises to null and reads as
    // "never entered the world". Both look like ordinary output.
    return {
      lastGameEnter: isGameEnter(record.lastGameEnter) ? record.lastGameEnter : null,
      crashes: Array.isArray(record.crashes) ? record.crashes.filter(isCrashRecord) : [],
      logCursor: typeof record.logCursor === 'string' ? record.logCursor : null,
      goal: typeof record.goal === 'string' ? record.goal : null,
    };
  } catch {
    // A journal that has never been written, or one that was corrupted by a hard kill mid-write,
    // both read as empty. Losing the journal is a cost; refusing to run is a bigger one.
    return { ...EMPTY_STATE };
  }
}

export async function writeState(paths: JournalPaths, state: JournalState): Promise<JournalWrite> {
  try {
    await ensureDir(paths);
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return { status: 'ok' };
  } catch (err) {
    return { status: 'unavailable', reason: reasonOf(err) };
  }
}

export async function appendCall(paths: JournalPaths, entry: CallEntry): Promise<JournalWrite> {
  try {
    await ensureDir(paths);
    await rollIfLarge(paths.calls);
    const args = truncate(JSON.stringify(entry.args), MAX_ARGS_CHARS);
    await appendFile(paths.calls, `${JSON.stringify({ ...entry, args })}\n`, 'utf8');
    return { status: 'ok' };
  } catch (err) {
    return { status: 'unavailable', reason: reasonOf(err) };
  }
}

export async function appendNote(paths: JournalPaths, note: Note): Promise<JournalWrite> {
  try {
    await ensureDir(paths);
    await appendFile(paths.notes, `${JSON.stringify({ ...note, text: truncate(note.text, MAX_NOTE_CHARS) })}\n`, 'utf8');
    return { status: 'ok' };
  } catch (err) {
    return { status: 'unavailable', reason: reasonOf(err) };
  }
}

async function rollIfLarge(file: string): Promise<void> {
  try {
    const { size } = await stat(file);
    if (size < MAX_CALLS_BYTES) return;
    await rename(file, `${file}.1`);
  } catch {
    // No file yet, or the roll failed. Either way, appending is still the right next move.
  }
}

export async function readNotes(paths: JournalPaths, limit: number): Promise<Note[]> {
  try {
    const text = await readFile(paths.notes, 'utf8');
    const notes: Note[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null) notes.push(parsed as Note);
      } catch {
        // One unreadable line does not invalidate the rest of the journal.
      }
    }
    return notes.slice(-limit);
  } catch {
    return [];
  }
}

/** Remembers where the last log read got to, so a resumed session does not re-read the night. */
export async function rememberLogCursor(paths: JournalPaths, cursor: string): Promise<JournalWrite> {
  const state = await readState(paths);
  return writeState(paths, { ...state, logCursor: cursor });
}

export interface ResumeBlock {
  goal: string | null;
  recentNotes: Note[];
  crashes: number;
  lastCrashAt: number | null;
  lastGameEnter: { args: Record<string, unknown>; at: number } | null;
  minutesSinceLastEnter: number | null;
  logCursor: string | null;
  hint: string;
}

/** How many notes a resume carries. It lands in somebody's context, so it stays small. */
const RESUME_NOTES = 5;

/**
 * Builds the block a returning agent is handed.
 *
 * Findings and goals outrank attempts and dead-ends: on a night with hundreds of attempts, the
 * five most recent notes would otherwise all be "tried rva 217" and carry nothing.
 */
export function buildResume(state: JournalState, notes: Note[], now: number): ResumeBlock {
  const ranked = [...notes].sort((left, right) => {
    const weight = (note: Note): number => (note.kind === 'finding' || note.kind === 'goal' ? 0 : 1);
    const byWeight = weight(left) - weight(right);
    return byWeight !== 0 ? byWeight : right.ts - left.ts;
  });
  const lastCrash = state.crashes.length > 0 ? state.crashes[state.crashes.length - 1] : undefined;
  const enteredAt = state.lastGameEnter?.at;
  return {
    goal: state.goal,
    recentNotes: ranked.slice(0, RESUME_NOTES),
    crashes: state.crashes.length,
    lastCrashAt: lastCrash?.at ?? null,
    lastGameEnter: state.lastGameEnter,
    minutesSinceLastEnter: enteredAt !== undefined ? Math.round((now - enteredAt) / 60_000) : null,
    logCursor: state.logCursor,
    hint:
      'This is where a previous session left off, read from the journal on disk. Call journal_note ' +
      'to add to it, and journal_resume again any time to see the latest.',
  };
}
