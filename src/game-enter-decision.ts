/**
 * The branch-selection logic behind the `game_enter` MCP tool (see src/index.ts), pulled out into a
 * pure function with no I/O -- no file reads, no process checks, no SendInput -- so it can be tested
 * directly with a plain table of cases, rather than only being reasoned about against index.ts's
 * actual wiring, which needs a real running game to exercise end to end.
 *
 * This exists because a Task 3 review round found a real, non-hypothetical gap: a second game_enter
 * call against a game that is past the title screen but not yet in orbit (still loading, or a prior
 * call that timed out waiting for the world to load) produces an identical two-marker log signature
 * to a game that was never pressed at all -- TITLE_SCREEN_MARKER present, WORLD_LOADED_MARKER
 * absent, in both cases. The log alone cannot tell them apart, so re-checking it harder is not a
 * fix. See task-3-report.md's second fix report for the finding and how this closes it.
 */

/** The facts game_enter actually has available when deciding what to do next. */
export interface GameEnterObservation {
  /** Whether destiny2.exe is currently running. */
  running: boolean;
  /** Whether the running process's pid could be determined. Always false when `running` is false. */
  pidKnown: boolean;
  /** Whether WORLD_LOADED_MARKER appears anywhere in the current sunrise.log (whole-file). Only
   *  meaningful when `running` is true. */
  worldMarkerPresent: boolean;
  /** Whether TITLE_SCREEN_MARKER appears anywhere in the current sunrise.log (whole-file). Only
   *  meaningful when `running` is true and `worldMarkerPresent` is false. Does not currently change
   *  which action is chosen -- see decideGameEnterAction's doc comment for why -- but is accepted as
   *  an explicit input anyway, both to match the full observation an agent might reasonably expect
   *  this decision to consider, and so the test table can pin that "doesn't matter here" invariant
   *  explicitly instead of leaving it unstated. */
  titleMarkerPresent: boolean;
  /** Whether THIS server process has a positive record of already pressing Enter for the exact pid
   *  that is currently running (see index.ts's `pressedForPid`). Only meaningful when `running` and
   *  `pidKnown` are both true. */
  pressedThisSession: boolean;
}

export type GameEnterAction =
  | { kind: 'launch' }
  | { kind: 'shortCircuitOk' }
  | { kind: 'proceed' }
  | { kind: 'resumeWorldWait' }
  | { kind: 'decline'; reason: string };

/**
 * Decides what game_enter should do next, from nothing but the facts above.
 *
 * The rule this enforces, per the review: game_enter may fire SendInput only when it can positively
 * justify that the game is sitting, unpressed, at the title screen. Absence of evidence that it has
 * moved on (WORLD_LOADED_MARKER missing) is NOT that justification by itself -- see the module doc
 * comment for why the log alone is ambiguous here. The only thing that can actually tell the
 * never-pressed case apart from the already-pressed-and-still-loading case is whether THIS server
 * already knows it pressed for this exact process (`pressedThisSession`): if so, the honest action
 * is to resume waiting for the world to load without pressing again ('resumeWorldWait'), never to
 * re-press. If the game's pid can't even be determined, there is no way to consult that memory at
 * all, so the honest action is to decline rather than guess ('decline') -- this is a defensive case
 * beyond the ones the review traced by hand, guarding against e.g. a `tasklist` output this code
 * fails to parse, where guessing wrong risks the exact spurious keystroke this whole function exists
 * to prevent.
 *
 * `titleMarkerPresent` deliberately does not change the outcome on the `proceed` branch: whether or
 * not the marker happens to be there yet, the same next step applies -- wait for it (which is a
 * no-op wait if it's already present) and then press. Splitting that into two actions would only
 * duplicate the same downstream behavior under two names.
 */
export function decideGameEnterAction(obs: GameEnterObservation): GameEnterAction {
  if (!obs.running) return { kind: 'launch' };

  if (!obs.pidKnown) {
    return {
      kind: 'decline',
      reason:
        'destiny2.exe is running but its process id could not be determined, so it cannot be verified whether ' +
        'this server already pressed Enter for it. Declining to press rather than risk a second keystroke into ' +
        'whatever the game is currently showing.',
    };
  }

  if (obs.worldMarkerPresent) return { kind: 'shortCircuitOk' };

  if (obs.pressedThisSession) return { kind: 'resumeWorldWait' };

  return { kind: 'proceed' };
}
