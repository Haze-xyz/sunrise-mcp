/**
 * Noticing that the game has died, keeping the evidence, and putting the world back.
 *
 * The decision is pure and the effects are injected, because the part worth getting right is an
 * ordering, and an ordering is exactly what a test with a recorder can prove and a test with a real
 * game cannot.
 */

import type { CrashRecord } from './journal.js';

export type SupervisorPolicy = 'restart' | 'report' | 'off';

export interface SupervisorObservation {
  gameAlive: boolean;
  now: number;
  /** Crashes already recorded, oldest first. */
  crashes: CrashRecord[];
}

export type SupervisorAction =
  /** The game is up, or the supervisor is off. Do the call. */
  | 'proceed'
  /** Keep the evidence, then start the game again. */
  | 'harvestAndRestart'
  /** Keep the evidence and stop restarting: this is a crash loop. */
  | 'harvestAndStop'
  /** The game is down and the policy says only to report it. */
  | 'refuse';

/** How far back a crash still counts towards the loop test. */
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** Crashes inside the window that end the restarting. The third crash stops. */
export const CRASH_LIMIT = 3;

export function readPolicy(): SupervisorPolicy {
  const raw = process.env.SUNRISE_MCP_SUPERVISOR;
  if (raw === 'report' || raw === 'off' || raw === 'restart') return raw;
  // The default restarts, because "any AI" includes one that will not notice a refusal and act on it.
  return 'restart';
}

export function decideSupervisorAction(
  observation: SupervisorObservation,
  policy: SupervisorPolicy,
): SupervisorAction {
  if (policy === 'off') return 'proceed';
  if (observation.gameAlive) return 'proceed';
  if (policy === 'report') return 'refuse';

  // elapsed >= 0 guards against a crash timestamped in the future: one backward clock step (an NTP
  // correction, a resumed VM) is enough to produce one, and a negative elapsed satisfies
  // `<= CRASH_WINDOW_MS` on its own -- without this guard such a crash would count as recent until
  // the clock caught up, and two of them would wedge the supervisor into harvestAndStop for good.
  const recent = observation.crashes.filter((crash) => {
    const elapsed = observation.now - crash.at;
    return elapsed >= 0 && elapsed <= CRASH_WINDOW_MS;
  });
  // The crash about to be recorded is the one we are handling, so it counts.
  return recent.length + 1 >= CRASH_LIMIT ? 'harvestAndStop' : 'harvestAndRestart';
}

/** The effects a harvest performs, injected so their order can be asserted. */
export interface HarvestIo {
  copyLog(harvestDir: string): Promise<void>;
  copyOldLog(harvestDir: string): Promise<void>;
  writeMeta(harvestDir: string, meta: unknown): Promise<void>;
  restart(): Promise<void>;
}

export interface HarvestPlan {
  harvestDir: string;
  /**
   * True only for the first harvest THIS SERVER PROCESS performs: sunrise.log.old still holds the
   * life before it. Every later crash in the same process duplicates a life already captured
   * directly by an earlier crash's own copyLog, so once per process is not a shortcut -- it is
   * complete.
   *
   * Must be driven by an in-process flag, not by anything read back from the journal on disk:
   * state.crashes persists across nights, and using its length here (an earlier version's bug)
   * means .old is captured only on the very first crash a journal has EVER recorded, and never
   * again on the first crash of any later night -- which is exactly when .old holds a life nothing
   * else in this session has captured yet.
   */
  includeOld: boolean;
  meta: unknown;
}

/**
 * Keeps the evidence, and only then starts the game again.
 *
 * The order is the whole function. open_log_file (log.cpp:116) does
 * MoveFileExW(sunrise.log, sunrise.log.old, MOVEFILE_REPLACE_EXISTING) before the new life writes
 * its first line, and it keeps exactly one previous file -- so a restart performed before the
 * harvest overwrites the previous crash with the current one, and at the second crash of a night
 * the first has been destroyed. It cannot be recovered afterwards, which is why a failed harvest
 * rejects rather than restarting anyway: a game that is down stays down and says so, and that is
 * recoverable.
 */
export async function harvestThenRestart(io: HarvestIo, plan: HarvestPlan): Promise<void> {
  await io.copyLog(plan.harvestDir);
  if (plan.includeOld) await io.copyOldLog(plan.harvestDir);
  await io.writeMeta(plan.harvestDir, plan.meta);
  await io.restart();
}
