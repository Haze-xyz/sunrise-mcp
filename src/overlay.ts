/**
 * Putting the fork's capability into somebody else's Sunrise checkout, without making them merge
 * the fork.
 *
 * What the overlay is: the fork's entire difference from upstream -- 45 files that exist nowhere
 * else, and 88 hunks inside 34 files upstream also has. Applied as one squashed change, so the
 * receiver gains the console endpoint, mem.*, character.* and the rest without taking someone
 * else's 60 commits into their history. That is the whole advantage over `git merge`, and it is
 * worth saying plainly rather than dressing up: this is a merge with the history left out.
 *
 * Two things make it possible at all, and both are worth knowing before reading the code:
 *
 * - **The added files and the modified ones are the same diff.** `git diff base..fork` carries
 *   both, so there is no "copy these 45, then patch those 34" -- there is one patch.
 * - **`git apply --3way` needs the pre-image blobs**, which is why the fork is fetched into the
 *   target repository first. Measured: with the blobs present it never fails outright, it produces
 *   ordinary conflict markers. Without them it degrades to a plain apply, which at eight days of
 *   drift loses a third of its hunks with nothing but `.rej` files to show for it.
 *
 * The decision of what a run concluded is in overlay-decision.ts, with no I/O.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { git } from './run-command.js';
import { looksLikeForkCheckout } from './sync.js';
import {
  decideOverlayOutcome,
  describeOverlayOutcome,
  type OverlayObservation,
  type OverlayOutcome,
} from './overlay-decision.js';

const DEFAULT_FORK_URL = 'https://github.com/Haze-xyz/Sunrise-mcp-fork.git';
const DEFAULT_FORK_REF = 'layer2-entry';
const DEFAULT_UPSTREAM_URL = 'https://github.com/stanuwu/Sunrise.git';
const DEFAULT_UPSTREAM_BRANCH = 'master';

/** Refs written into the target repository. Named, not FETCH_HEAD, which is per worktree. */
const FORK_REF = 'refs/sunrise-overlay/fork';
const UPSTREAM_REF = 'refs/sunrise-overlay/upstream';

export interface OverlayOptions {
  /** The checkout to apply the overlay to. */
  targetDir: string;
  forkUrl?: string;
  forkRef?: string;
  upstreamUrl?: string;
  upstreamBranch?: string;
  /** Apply even when the target is behind upstream. Measured to cost hunks; off by default. */
  allowDrift?: boolean;
  log?: (line: string) => void;
}

export interface OverlayRun {
  outcome: OverlayOutcome;
  observation: OverlayObservation;
  /** The upstream commit the overlay is expressed against. */
  base: string | null;
  /** The fork commit the overlay was taken from. */
  forkCommit: string | null;
  /** Files the overlay adds, and files of upstream's it changes. Counted from the patch itself. */
  filesAdded: number;
  filesModified: number;
  message: string;
}

/** Counts what a patch does, so the report states a size rather than implying one. */
export function countPatch(patch: string): { added: number; modified: number } {
  let added = 0;
  let modified = 0;
  const files = patch.split(/^diff --git /m).slice(1);
  for (const file of files) {
    if (/^new file mode /m.test(file)) added += 1;
    else modified += 1;
  }
  return { added, modified };
}

/**
 * Applies the fork's overlay to a checkout.
 *
 * @returns What was observed and what was done. Expected stops -- not a checkout, dirty, drifted --
 *          come back as outcomes; only git failing in a way that has no meaning throws.
 */
export async function applyOverlay(options: OverlayOptions): Promise<OverlayRun> {
  const targetDir = options.targetDir;
  const forkUrl = options.forkUrl ?? DEFAULT_FORK_URL;
  const forkRef = options.forkRef ?? DEFAULT_FORK_REF;
  const upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
  const upstreamBranch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;
  const allowDrift = options.allowDrift ?? false;
  const log = options.log ?? (() => {});

  const observation: OverlayObservation = {
    isCheckout: await looksLikeForkCheckout(targetDir),
    workingTreeClean: false,
    commitsBehindUpstream: 0,
    driftAccepted: allowDrift,
    applyAttempted: false,
    conflictedFiles: [],
    applyError: null,
  };
  const stop = (base: string | null, forkCommit: string | null, added = 0, modified = 0): OverlayRun => {
    const outcome = decideOverlayOutcome(observation);
    return {
      outcome,
      observation,
      base,
      forkCommit,
      filesAdded: added,
      filesModified: modified,
      message: describeOverlayOutcome(outcome),
    };
  };

  if (!observation.isCheckout) return stop(null, null);

  const status = await git(['status', '--porcelain'], targetDir);
  if (status.code !== 0) throw new Error(`${targetDir} is not a git checkout: ${status.stderr.trim()}`);
  observation.workingTreeClean = status.stdout.trim().length === 0;
  if (!observation.workingTreeClean) return stop(null, null);

  // Anonymous for upstream (public); the fork is private, so whatever credentials the caller's git
  // is configured with are used -- there is no way around needing access to it.
  log(`fetching upstream ${upstreamUrl} ${upstreamBranch}`);
  const upstream = await git(
    ['-c', 'credential.helper=', 'fetch', upstreamUrl, `+refs/heads/${upstreamBranch}:${UPSTREAM_REF}`],
    targetDir,
  );
  if (upstream.code !== 0) throw new Error(`fetching upstream failed: ${upstream.stderr.trim()}`);

  log(`fetching the fork ${forkUrl} ${forkRef}`);
  const fork = await git(['fetch', forkUrl, `+refs/heads/${forkRef}:${FORK_REF}`], targetDir);
  if (fork.code !== 0) {
    throw new Error(
      `fetching the fork failed: ${fork.stderr.trim()}. That repository is private; this needs ` +
        'credentials with access to it.',
    );
  }

  const behind = await git(['rev-list', '--count', `HEAD..${UPSTREAM_REF}`], targetDir);
  const parsed = Number.parseInt(behind.stdout.trim(), 10);
  observation.commitsBehindUpstream = Number.isFinite(parsed) ? parsed : -1;
  log(`this checkout is ${observation.commitsBehindUpstream} commit(s) behind upstream`);

  const baseResult = await git(['merge-base', FORK_REF, UPSTREAM_REF], targetDir);
  if (baseResult.code !== 0) throw new Error(`no common history between the fork and upstream: ${baseResult.stderr.trim()}`);
  const base = baseResult.stdout.trim();
  const forkCommit = (await git(['rev-parse', FORK_REF], targetDir)).stdout.trim();

  if (observation.commitsBehindUpstream !== 0 && !allowDrift) return stop(base, forkCommit);
  if (observation.commitsBehindUpstream < 0) return stop(base, forkCommit);

  const patchResult = await git(['diff', `${base}..${FORK_REF}`], targetDir);
  if (patchResult.code !== 0) throw new Error(`could not produce the overlay diff: ${patchResult.stderr.trim()}`);
  const { added, modified } = countPatch(patchResult.stdout);
  log(`overlay: ${added} file(s) added, ${modified} of upstream's changed`);

  const scratch = await mkdtemp(path.join(tmpdir(), 'sunrise-overlay-'));
  const patchPath = path.join(scratch, 'overlay.patch');
  try {
    await writeFile(patchPath, patchResult.stdout, 'utf8');
    const applied = await git(['apply', '--3way', '--whitespace=nowarn', patchPath], targetDir);
    observation.applyAttempted = true;

    const conflicted = await git(['diff', '--name-only', '--diff-filter=U'], targetDir);
    observation.conflictedFiles = conflicted.stdout.trim().split(/\r?\n/).filter((l) => l.length > 0);

    // A non-zero exit with conflicts is the ordinary --3way outcome, not a failure. Without any
    // conflicted file it means git refused the patch, and saying "applied" then would be a claim
    // the tree does not support.
    if (applied.code !== 0 && observation.conflictedFiles.length === 0) {
      observation.applyError = `${applied.stderr.trim() || applied.stdout.trim()} (git exit ${applied.code})`;
    }
    if (observation.conflictedFiles.length > 0) {
      log(`conflict markers left in ${observation.conflictedFiles.length} file(s)`);
    }
    return stop(base, forkCommit, added, modified);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
