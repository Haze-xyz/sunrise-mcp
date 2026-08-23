/**
 * What a fork-sync run should conclude, as a pure function over the facts it gathered -- no git, no
 * MSBuild, no network. The I/O that produces those facts lives in sync.ts; this file exists so the
 * part that is easy to get subtly wrong (which outcome wins over which, and which ones are worth
 * waking a human for) can be tested with a plain table instead of against a real repository.
 *
 * The rule the whole module serves: a sync never resolves a conflict and never pushes a red build.
 * Its job is to be right about which of five situations it is in, and to be silent in the only one
 * that deserves silence.
 */

/** The facts a sync run has once its steps have run (or been skipped). */
export interface SyncObservation {
  /** Whether the fork checkout had no uncommitted changes when the run started. */
  workingTreeClean: boolean;
  /** Commits upstream has that the fork branch does not. Zero means there was nothing to do. */
  upstreamCommitsAhead: number;
  /** Whether a merge was actually attempted. False when an earlier gate stopped the run. */
  mergeAttempted: boolean;
  /** Paths git reported as conflicted. Empty when the merge applied cleanly. Only meaningful when
   *  `mergeAttempted` is true. */
  conflictedFiles: readonly string[];
  /** Git's own complaint when the merge command failed for a reason that is *not* a conflict -- a
   *  ref it could not read, a locked index, a hook refusing. `null` when it did not fail that way.
   *
   *  This field exists because of a real defect, not a hypothetical one: `FETCH_HEAD` is per
   *  worktree, so a merge run in a scratch worktree against a ref fetched in another one failed with
   *  exit 128 and *zero* conflicted files -- and the first version of this decision read that as a
   *  clean merge and reported success for a merge that never happened. An outcome must never be
   *  derivable from the absence of conflicts alone. */
  mergeError: string | null;
  /** Whether MSBuild reported success. `null` when no build was attempted -- either because the
   *  caller asked for none, or because no MSBuild could be found on this machine. Not the same as
   *  `false`, and reported differently on purpose: an unbuilt merge is unproven, not broken. */
  buildSucceeded: boolean | null;
}

export type SyncOutcome =
  /** Nothing upstream. The only outcome that is not worth a message. */
  | { kind: 'upToDate' }
  /** The checkout carries uncommitted work, so nothing was touched. */
  | { kind: 'dirty'; commits: number }
  /** The merge needs a human. Nothing was pushed and the checkout was left as it was. */
  | { kind: 'conflict'; commits: number; files: readonly string[] }
  /** The merge applied but the result does not compile. */
  | { kind: 'buildFailed'; commits: number }
  /** The merge applied and was not compiled, so it is unproven. */
  | { kind: 'mergedNotBuilt'; commits: number }
  /** The merge applied and the result compiles. The only outcome that may be published. */
  | { kind: 'ready'; commits: number }
  /** The observation contradicts itself. Defensive: reported rather than guessed at. */
  | { kind: 'aborted'; reason: string };

/**
 * Decides what a sync run concluded.
 *
 * Gate order, and why it is this order:
 *
 * 1. Nothing upstream wins over everything, including a dirty checkout. A dirty tree only matters
 *    when something was going to be done to it; complaining about it on a day when upstream did not
 *    move would train the reader to ignore the messages.
 * 2. A dirty checkout stops the run before any merge, because a merge on top of uncommitted work
 *    leaves nothing to go back to.
 * 3. Conflicts before the build, because a conflicted tree cannot be built at all -- and a merge
 *    that failed *without* conflicting is its own stop, never a silent pass. See `mergeError`.
 * 4. A failed build before a successful one, obviously; and an *absent* build is its own outcome
 *    rather than being folded into either -- see `buildSucceeded`.
 */
export function decideSyncOutcome(observation: SyncObservation): SyncOutcome {
  const {
    workingTreeClean,
    upstreamCommitsAhead,
    mergeAttempted,
    conflictedFiles,
    buildSucceeded,
  } = observation;

  if (upstreamCommitsAhead < 0) {
    return { kind: 'aborted', reason: `upstreamCommitsAhead was ${upstreamCommitsAhead}` };
  }
  if (upstreamCommitsAhead === 0) return { kind: 'upToDate' };
  if (!workingTreeClean) return { kind: 'dirty', commits: upstreamCommitsAhead };

  if (!mergeAttempted) {
    return {
      kind: 'aborted',
      reason:
        `${upstreamCommitsAhead} commits were waiting and the checkout was clean, but no merge was ` +
        'attempted. Nothing can be concluded about them.',
    };
  }
  if (conflictedFiles.length > 0) {
    return { kind: 'conflict', commits: upstreamCommitsAhead, files: conflictedFiles };
  }
  // Checked after conflicts, because git also exits non-zero on an ordinary conflict: reaching here
  // means it failed for some other reason entirely, and nothing was merged.
  if (observation.mergeError !== null) {
    return {
      kind: 'aborted',
      reason: `the merge failed without conflicting on anything: ${observation.mergeError}`,
    };
  }
  if (buildSucceeded === null) return { kind: 'mergedNotBuilt', commits: upstreamCommitsAhead };
  if (!buildSucceeded) return { kind: 'buildFailed', commits: upstreamCommitsAhead };
  return { kind: 'ready', commits: upstreamCommitsAhead };
}

/**
 * Whether this outcome should reach a human.
 *
 * A message is sent only when the run needs someone: nothing to do and it worked are both silent.
 *
 * The obvious objection is that a job which says nothing on the days it worked cannot be told from
 * one that has been broken for a month. What answers it is that this is not the only channel --
 * every run leaves a green or red entry in the Actions history, and a failed one is mailed by
 * GitHub on its own. Telegram is for the thing those two do not do well: putting the reason in
 * front of someone who is not looking at a dashboard. Spending it on "nothing happened" is how it
 * stops being read, which would cost more than the case it guards against.
 *
 * `mergedNotBuilt` does notify, and is the one that looks like a success. It means the result was
 * never compiled -- which on the scheduled job can only happen if MSBuild went missing from the
 * runner, i.e. the build stopped being proof and nobody would otherwise find out.
 */
export function shouldNotify(outcome: SyncOutcome): boolean {
  return outcome.kind !== 'upToDate' && outcome.kind !== 'ready';
}

/** Whether the fork branch may be moved onto the merged result. Success only. */
export function mayPublish(outcome: SyncOutcome): boolean {
  return outcome.kind === 'ready';
}

/** One line for a human, naming what happened and what it now needs from them. */
export function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case 'upToDate':
      return 'Up to date with upstream. Nothing to do.';
    case 'dirty':
      return (
        `${outcome.commits} upstream commit(s) waiting, but the checkout has uncommitted changes, ` +
        'so nothing was touched. Commit or stash them, then run this again.'
      );
    case 'conflict':
      return (
        `${outcome.commits} upstream commit(s) merged with conflicts in ${outcome.files.length} ` +
        `file(s), so nothing was published and the checkout was left as it was: ` +
        `${outcome.files.join(', ')}. This needs you.`
      );
    case 'buildFailed':
      return (
        `${outcome.commits} upstream commit(s) merged cleanly, but the result does not compile, so ` +
        'nothing was published. This needs you.'
      );
    case 'mergedNotBuilt':
      return (
        `${outcome.commits} upstream commit(s) merged cleanly. No build was run, so the result is ` +
        'unproven and nothing was published.'
      );
    case 'ready':
      return `${outcome.commits} upstream commit(s) merged cleanly and the result compiles.`;
    case 'aborted':
      return `Sync stopped without a conclusion: ${outcome.reason}`;
  }
}
