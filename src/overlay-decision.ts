/**
 * What applying the fork's overlay to somebody else's checkout should conclude, decided from facts
 * and nothing else. overlay.ts does the git work; this file says what it means.
 *
 * The overlay is the fork's whole difference from upstream: 45 files that exist nowhere else and 88
 * hunks inside 34 files upstream also has. It is applied as one squashed change rather than merged,
 * so a collaborator gains the capability without taking 60 commits of someone else's history into
 * their own -- that, and nothing grander, is what this buys over `git merge`.
 *
 * The number that governs everything here was measured on 2026-08-23, applying the real 88-hunk
 * patch to a bare upstream checkout at four distances:
 *
 *   upstream tip     88/88 hunks, 0 conflicts
 *   -10 commits      83/88, 2 files conflicting under --3way
 *   -20 commits      72/88, 5 files
 *   -43 commits      57/88, 12 files
 *
 * Eight days of upstream drift costs a third of the patch. So being behind upstream is not a detail
 * to mention afterwards -- it is the single thing that decides whether this works, and the default
 * is to stop and say so rather than to hand back a tree full of conflict markers.
 */

/** What the target checkout looks like before anything is applied. */
export interface OverlayObservation {
  /** Whether the target is a Sunrise checkout at all. */
  isCheckout: boolean;
  /** Whether it has no uncommitted changes. Applying over dirty work leaves nothing to go back to. */
  workingTreeClean: boolean;
  /** How many commits upstream has that the target does not. The predictor of pain. */
  commitsBehindUpstream: number;
  /** Whether the caller accepted applying onto a drifted target anyway. */
  driftAccepted: boolean;
  /** Whether the patch was applied at all. False when an earlier gate stopped it. */
  applyAttempted: boolean;
  /** Files git left conflict markers in. Empty when everything applied cleanly. */
  conflictedFiles: readonly string[];
  /** Git's complaint when the apply failed outright rather than conflicting. */
  applyError: string | null;
}

export type OverlayOutcome =
  | { kind: 'notACheckout' }
  | { kind: 'dirty' }
  /** Behind upstream, so most of the patch would miss. Refused by default; see `driftAccepted`. */
  | { kind: 'drifted'; behind: number }
  /** Applied whole. The tree now carries the overlay and nothing else changed. */
  | { kind: 'applied'; behind: number }
  /** Applied, with conflict markers left for a human in the named files. */
  | { kind: 'appliedWithConflicts'; behind: number; files: readonly string[] }
  /** Git refused the patch outright. Nothing useful is in the tree. */
  | { kind: 'failed'; reason: string }
  /** The observation contradicts itself. Reported rather than guessed at. */
  | { kind: 'aborted'; reason: string };

/**
 * Decides what an overlay run concluded.
 *
 * Gate order is the order the facts stop mattering in: something that is not a checkout has no
 * working tree to be clean, a dirty tree must not be written over whatever the drift is, and drift
 * is checked before applying because that is the whole point of checking it.
 */
export function decideOverlayOutcome(observation: OverlayObservation): OverlayOutcome {
  if (!observation.isCheckout) return { kind: 'notACheckout' };
  if (!observation.workingTreeClean) return { kind: 'dirty' };
  if (observation.commitsBehindUpstream < 0) {
    return { kind: 'aborted', reason: `commitsBehindUpstream was ${observation.commitsBehindUpstream}` };
  }
  if (observation.commitsBehindUpstream > 0 && !observation.driftAccepted) {
    return { kind: 'drifted', behind: observation.commitsBehindUpstream };
  }
  if (!observation.applyAttempted) {
    return { kind: 'aborted', reason: 'every gate passed and the patch was never applied' };
  }
  if (observation.applyError !== null) return { kind: 'failed', reason: observation.applyError };
  if (observation.conflictedFiles.length > 0) {
    return {
      kind: 'appliedWithConflicts',
      behind: observation.commitsBehindUpstream,
      files: observation.conflictedFiles,
    };
  }
  return { kind: 'applied', behind: observation.commitsBehindUpstream };
}

/** Whether the tree now holds something worth committing -- markers included, which a human resolves. */
export function leftChanges(outcome: OverlayOutcome): boolean {
  return outcome.kind === 'applied' || outcome.kind === 'appliedWithConflicts';
}

/** What to tell the caller: what happened, and the one next thing to do. */
export function describeOverlayOutcome(outcome: OverlayOutcome): string {
  switch (outcome.kind) {
    case 'notACheckout':
      return 'That path is not a Sunrise checkout: it holds no Sunrise/Sunrise.vcxproj. Nothing was done.';
    case 'dirty':
      return (
        'The checkout has uncommitted changes. Commit or stash them first -- this writes to tracked ' +
        'files, and there would be nothing to go back to. Nothing was done.'
      );
    case 'drifted':
      return (
        `This checkout is ${outcome.behind} commit(s) behind upstream, and the overlay is built ` +
        'against upstream\'s tip. Measured: eight days of drift costs a third of the patch, and ' +
        'every hunk that misses becomes a conflict you resolve by hand for no reason. Bring it up ' +
        'to date first -- `npm run sync-fork -- --repo <this checkout>` does exactly that -- then ' +
        'run this again. Pass --allow-drift to apply anyway. Nothing was done.'
      );
    case 'applied':
      return (
        'The overlay applied whole: every file the fork adds is now in the tree, and every change it ' +
        'makes to upstream files is in place. Nothing is committed -- review it, then commit. Build ' +
        'before trusting it.'
      );
    case 'appliedWithConflicts':
      return (
        `The overlay applied, leaving conflict markers in ${outcome.files.length} file(s): ` +
        `${outcome.files.join(', ')}. Those are places this checkout and the fork changed the same ` +
        'lines; both sides are in the file and a human picks. Everything else is in place. Nothing ' +
        'is committed.'
      );
    case 'failed':
      return `The overlay could not be applied and the tree was left alone: ${outcome.reason}`;
    case 'aborted':
      return `Stopped without a conclusion: ${outcome.reason}`;
  }
}
