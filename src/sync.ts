/**
 * Keeping the Sunrise fork current with upstream, unattended.
 *
 * The fork is this server's dependency: every tool here talks to a DLL built from it, so a fork six
 * days behind upstream is a server that answers about a game nobody else is running. Measured on
 * 2026-08-23, six days of drift was 43 commits, 352 files and 3 conflicting ones -- half an hour of
 * work. The same drift left for three months is a project. The point of this module is that the
 * half-hour version happens by itself and the three-month version never exists.
 *
 * Two rules it never breaks, because breaking either makes it worse than doing nothing:
 *
 * - **It never resolves a conflict.** A merge that guesses is the silent overwrite this whole
 *   design exists to avoid. Conflicts stop the run and name their files.
 * - **It never touches the caller's checkout until the result compiles.** The merge happens in a
 *   throwaway worktree; the real branch is fast-forwarded onto it only once MSBuild is green, and
 *   pushed only when asked. A failed run leaves the checkout exactly as it found it.
 *
 * The decision of *which* outcome a run reached lives in sync-decision.ts, with no I/O, so it can be
 * tested against a table. This file only gathers the facts and carries them out.
 */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BUILD_MAX_BUFFER, git, run } from './run-command.js';
import {
  decideSyncOutcome,
  describeOutcome,
  mayPublish,
  type SyncObservation,
  type SyncOutcome,
} from './sync-decision.js';

/** Upstream, over HTTPS on purpose: the repository is public, so this needs no key and no account. */
const DEFAULT_UPSTREAM_URL = 'https://github.com/stanuwu/Sunrise.git';
const DEFAULT_UPSTREAM_BRANCH = 'master';
/** Where a successful result is pushed, when pushing was asked for. */
const DEFAULT_REMOTE = 'backup';
/**
 * How a push authenticates by default.
 *
 * On the machine this was written for, a plain push answers `Repository not found` whenever the
 * wrong GitHub account is active, so the gh helper is asked for by name. On a CI runner there is no
 * gh and no account: `actions/checkout` has already configured a token on the checkout, and forcing
 * a helper that does not exist would break the one push that matters. Hence `null` -- meaning "do
 * not inject anything, use whatever the checkout is already configured with" -- is a supported
 * value, not an oversight.
 */
const DEFAULT_CREDENTIAL_HELPER = '!gh auth git-credential';
/**
 * Where the fetched upstream tip is parked.
 *
 * NOT `FETCH_HEAD`: that ref is per worktree, so a tip fetched in the checkout is simply absent in
 * the scratch worktree where the merge runs, and git fails there with exit 128 and no conflicts.
 * An ordinary ref under `refs/` is shared by every worktree of the repository, which is the whole
 * reason this one exists. It is left behind on purpose -- it records what upstream was at the last
 * run, and costs 41 bytes.
 */
const UPSTREAM_REF = 'refs/sunrise-sync/upstream';
/** The env var that names the fork checkout, so nothing here has a machine's path built into it. */
const FORK_DIR_VAR = 'SUNRISE_FORK_DIR';
/** An explicit MSBuild path, for a machine where vswhere is absent or the wrong install wins. */
const MSBUILD_VAR = 'SUNRISE_MSBUILD';
/** vswhere ships with every Visual Studio installer, at a fixed path. */
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';


export interface SyncOptions {
  /** The fork checkout to update. */
  forkDir: string;
  upstreamUrl?: string;
  upstreamBranch?: string;
  /** Whether to compile the merged result. Off leaves the outcome `mergedNotBuilt`, never `ready`. */
  build?: boolean;
  /** Whether to fast-forward the checkout's branch onto a green result. */
  publish?: boolean;
  /** Whether to push the published branch. Requires `publish`. */
  push?: boolean;
  /** Which remote to push to. */
  remote?: string;
  /** Credential helper for the push. `null` uses the checkout's existing configuration (CI). */
  credentialHelper?: string | null;
  log?: (line: string) => void;
}

export interface SyncRun {
  outcome: SyncOutcome;
  observation: SyncObservation;
  /** The branch the checkout was on. */
  branch: string;
  /** The merged commit in the throwaway worktree, when a merge produced one. */
  mergedCommit: string | null;
  /** Whether the checkout's branch was actually moved onto the merged commit. */
  published: boolean;
  /** Whether the branch was pushed. */
  pushed: boolean;
  /** Where the MSBuild log was written, when a build ran. */
  buildLogPath: string | null;
  /** Compiler error lines, when the build failed. */
  buildErrors: readonly string[];
}


async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Whether this directory is a Sunrise checkout, by the one file the build cannot do without. */
export async function looksLikeForkCheckout(dir: string): Promise<boolean> {
  return exists(path.join(dir, 'Sunrise', 'Sunrise.vcxproj'));
}

/**
 * Decides which checkout to work on: an explicit argument, then `SUNRISE_FORK_DIR`, then the current
 * directory *only if it actually looks like one*.
 *
 * There is deliberately no built-in default path. A default that points at one machine is the exact
 * defect this server was told about -- it turns "you have not configured me" into an error message
 * about the game.
 *
 * @throws When nothing resolves, with a message naming what to set.
 */
export async function resolveForkDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const candidates: Array<{ dir: string; source: string }> = [];
  if (explicit) candidates.push({ dir: path.resolve(explicit), source: 'the --repo argument' });
  const fromEnv = env[FORK_DIR_VAR];
  if (fromEnv) candidates.push({ dir: path.resolve(fromEnv), source: `${FORK_DIR_VAR}` });
  candidates.push({ dir: path.resolve(cwd), source: 'the current directory' });

  for (const candidate of candidates) {
    if (await looksLikeForkCheckout(candidate.dir)) return candidate.dir;
  }
  const tried = candidates.map((c) => `${c.dir} (${c.source})`).join('; ');
  throw new Error(
    `No Sunrise fork checkout found. Tried: ${tried}. None of them holds Sunrise/Sunrise.vcxproj. ` +
      `Pass --repo <path>, or set ${FORK_DIR_VAR}. Nothing was guessed on purpose: a default path ` +
      'belongs to whoever wrote it, not to whoever runs this.',
  );
}

/** Finds MSBuild, or reports null so the run says "unproven" instead of pretending it built. */
export async function findMsbuild(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env[MSBUILD_VAR];
  if (explicit && (await exists(explicit))) return explicit;

  const vswhere = process.platform === 'win32' ? VSWHERE : `/mnt/c/${VSWHERE.slice(3).replace(/\\/g, '/')}`;
  if (!(await exists(vswhere))) return null;
  const found = await run(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.Component.MSBuild',
    '-property',
    'installationPath',
  ]);
  const installRoot = found.stdout.trim().split(/\r?\n/)[0];
  if (found.code !== 0 || !installRoot) return null;

  const msbuild = `${installRoot}\\MSBuild\\Current\\Bin\\MSBuild.exe`;
  const local =
    process.platform === 'win32' ? msbuild : `/mnt/${msbuild[0]?.toLowerCase()}/${msbuild.slice(3).replace(/\\/g, '/')}`;
  return (await exists(local)) ? local : null;
}

/**
 * The path to hand to a Windows MSBuild, which is not the path this process uses when it runs under
 * WSL -- there, a Linux path has to become a `\\wsl.localhost\...` UNC one. `wslpath` does that
 * conversion correctly for every mount layout, which hand-built string surgery does not.
 */
async function toWindowsPath(target: string): Promise<string> {
  if (process.platform === 'win32') return target;
  const converted = await run('wslpath', ['-w', target]);
  if (converted.code !== 0) throw new Error(`wslpath could not convert ${target}: ${converted.stderr.trim()}`);
  return converted.stdout.trim();
}

/** Compiler error lines, which are the only part of a 1500-line build log worth putting in a message. */
export function extractBuildErrors(log: string): string[] {
  const seen = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    if (/\berror [A-Z]+\d+\b/.test(line)) seen.add(line.trim());
    if (seen.size >= 20) break;
  }
  return [...seen];
}

/**
 * MSBuild's own verdict.
 *
 * The exit code alone is not enough here: this project is built through a wrapper often enough that
 * the banner is the thing people read, and `/v:minimal` is known to omit it on this installation
 * even on success. So both are required to agree -- a zero exit *and* the banner -- and anything
 * else counts as a failure worth a human's attention rather than a pass.
 */
export function buildSucceeded(code: number, log: string): boolean {
  return code === 0 && /^Build succeeded\.$/m.test(log);
}

/**
 * Fetches upstream, merges it in a throwaway worktree, builds, and publishes only a green result.
 *
 * @returns Everything the run observed and did. Errors from git itself are thrown; every *expected*
 *          stop (dirty tree, conflicts, red build) comes back as an outcome, not an exception.
 */
export async function runSync(options: SyncOptions): Promise<SyncRun> {
  const forkDir = options.forkDir;
  const upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
  const upstreamBranch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;
  const wantBuild = options.build ?? true;
  const wantPublish = options.publish ?? true;
  const wantPush = options.push ?? false;
  const remote = options.remote ?? DEFAULT_REMOTE;
  const credentialHelper =
    options.credentialHelper === undefined ? DEFAULT_CREDENTIAL_HELPER : options.credentialHelper;
  const log = options.log ?? (() => {});

  const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], forkDir);
  if (branchResult.code !== 0) throw new Error(`${forkDir} is not a git checkout: ${branchResult.stderr.trim()}`);
  const branch = branchResult.stdout.trim();
  if (branch === 'HEAD') {
    throw new Error(`${forkDir} is on a detached HEAD, so there is no branch to update. Check one out first.`);
  }
  log(`branch: ${branch}`);

  const status = await git(['status', '--porcelain'], forkDir);
  const workingTreeClean = status.stdout.trim().length === 0;
  log(`working tree: ${workingTreeClean ? 'clean' : 'has uncommitted changes'}`);

  // Anonymous on purpose: upstream is public, and borrowing whatever account happens to be active
  // is how a fetch fails with "Repository not found" instead of a permission error.
  log(`fetching ${upstreamUrl} ${upstreamBranch}`);
  const fetched = await git(
    ['-c', 'credential.helper=', 'fetch', upstreamUrl, `+refs/heads/${upstreamBranch}:${UPSTREAM_REF}`],
    forkDir,
  );
  if (fetched.code !== 0) throw new Error(`fetching upstream failed: ${fetched.stderr.trim()}`);

  const ahead = await git(['rev-list', '--count', `HEAD..${UPSTREAM_REF}`], forkDir);
  if (ahead.code !== 0) throw new Error(`counting upstream commits failed: ${ahead.stderr.trim()}`);
  const upstreamCommitsAhead = Number.parseInt(ahead.stdout.trim(), 10);
  log(`upstream commits ahead: ${upstreamCommitsAhead}`);

  const observation: SyncObservation = {
    workingTreeClean,
    upstreamCommitsAhead: Number.isFinite(upstreamCommitsAhead) ? upstreamCommitsAhead : -1,
    mergeAttempted: false,
    conflictedFiles: [],
    mergeError: null,
    buildSucceeded: null,
  };
  const stop = (): SyncRun => ({
    outcome: decideSyncOutcome(observation),
    observation,
    branch,
    mergedCommit: null,
    published: false,
    pushed: false,
    buildLogPath: null,
    buildErrors: [],
  });

  if (observation.upstreamCommitsAhead <= 0 || !workingTreeClean) return stop();

  const worktree = await mkdtemp(path.join(tmpdir(), 'sunrise-sync-'));
  let mergedCommit: string | null = null;
  let buildLogPath: string | null = null;
  let buildErrors: readonly string[] = [];
  try {
    const added = await git(['worktree', 'add', '--detach', worktree, 'HEAD'], forkDir);
    if (added.code !== 0) throw new Error(`could not create a scratch worktree: ${added.stderr.trim()}`);
    log(`merging in a scratch worktree: ${worktree}`);

    const merged = await git(['merge', '--no-edit', '--no-ff', UPSTREAM_REF], worktree);
    observation.mergeAttempted = true;
    if (merged.code !== 0) {
      const conflicted = await git(['diff', '--name-only', '--diff-filter=U'], worktree);
      observation.conflictedFiles = conflicted.stdout.trim().split(/\r?\n/).filter((l) => l.length > 0);
      if (observation.conflictedFiles.length > 0) {
        log(`conflicts in ${observation.conflictedFiles.length} file(s); nothing was touched`);
      } else {
        // git refused for something other than a conflict. Reported as its own stop: treating it as
        // "no conflicts, therefore fine" is how a merge that never ran gets announced as a success.
        observation.mergeError = `${merged.stderr.trim() || merged.stdout.trim()} (git exit ${merged.code})`;
        log(`merge failed without conflicts: ${observation.mergeError}`);
      }
      await git(['merge', '--abort'], worktree);
      return stop();
    }
    mergedCommit = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    log(`merge clean: ${mergedCommit.slice(0, 7)}`);

    if (wantBuild) {
      const msbuild = await findMsbuild();
      if (!msbuild) {
        log('no MSBuild found, so the merge stays unproven (set SUNRISE_MSBUILD to point at one)');
      } else {
        const solution = await toWindowsPath(path.join(worktree, 'Sunrise.sln'));
        log(`building ${solution}`);
        const built = await run(
          msbuild,
          [solution, '/m', '/v:normal', '/p:Configuration=Release', '/p:Platform=x64'],
          undefined,
          BUILD_MAX_BUFFER,
        );
        const buildLog = `${built.stdout}\n${built.stderr}`;
        buildLogPath = path.join(worktree, '..', `sunrise-sync-build-${process.pid}.log`);
        await writeFile(buildLogPath, buildLog, 'utf8');
        observation.buildSucceeded = buildSucceeded(built.code, buildLog);
        buildErrors = observation.buildSucceeded ? [] : extractBuildErrors(buildLog);
        log(`build: ${observation.buildSucceeded ? 'succeeded' : 'FAILED'} (log at ${buildLogPath})`);
      }
    }

    const outcome = decideSyncOutcome(observation);
    let published = false;
    let pushed = false;
    if (mayPublish(outcome) && wantPublish) {
      const forwarded = await git(['merge', '--ff-only', mergedCommit], forkDir);
      if (forwarded.code !== 0) throw new Error(`could not fast-forward ${branch}: ${forwarded.stderr.trim()}`);
      published = true;
      log(`${branch} moved to ${mergedCommit.slice(0, 7)}`);
      if (wantPush) {
        const pushArgs = credentialHelper === null
          ? ['push', remote, branch]
          : ['-c', `credential.helper=${credentialHelper}`, 'push', remote, branch];
        const pushedResult = await git(pushArgs, forkDir);
        if (pushedResult.code !== 0) throw new Error(`push to ${remote} failed: ${pushedResult.stderr.trim()}`);
        pushed = true;
        log(`pushed to ${remote}`);
      }
    }

    return { outcome, observation, branch, mergedCommit, published, pushed, buildLogPath, buildErrors };
  } finally {
    // Removed whatever happened: a scratch worktree left behind would be found by the next run's
    // `git worktree list` and quietly consume the branch it was created from.
    await git(['worktree', 'remove', '--force', worktree], forkDir);
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

/** The message a human gets: the one-line verdict, plus the errors when there are any. */
export function summarize(runResult: SyncRun): string {
  const lines = [`[sunrise-mcp] fork sync on ${runResult.branch}: ${describeOutcome(runResult.outcome)}`];
  if (runResult.published) lines.push(`Branch moved to ${runResult.mergedCommit?.slice(0, 7) ?? '?'}.`);
  if (runResult.pushed) lines.push('Pushed.');
  if (runResult.buildErrors.length > 0) {
    lines.push('', 'First compiler errors:', ...runResult.buildErrors.slice(0, 10));
  }
  if (runResult.buildLogPath && runResult.outcome.kind === 'buildFailed') {
    lines.push('', `Full build log: ${runResult.buildLogPath}`);
  }
  return lines.join('\n');
}
