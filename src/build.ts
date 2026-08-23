/**
 * Compiling the Sunrise solution, and saying honestly whether it worked.
 *
 * Split out of sync.ts so an agent can build on demand -- edit the C++, build, deploy, restart --
 * without the merge machinery around it. Same code either way: the daily sync and a one-off build
 * ask the same question and get the same answer.
 */

import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { BUILD_MAX_BUFFER, run } from './run-command.js';

/** An explicit MSBuild path, for a machine where vswhere is absent or the wrong install wins. */
const MSBUILD_VAR = 'SUNRISE_MSBUILD';
/** vswhere ships with every Visual Studio installer, at a fixed path. */
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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

export interface BuildResult {
  /** False when no MSBuild could be found, which is "unproven", not "broken". */
  attempted: boolean;
  succeeded: boolean;
  /** Where the full log was written, when a build ran. */
  logPath: string | null;
  /** Compiler error lines, capped, when it failed. */
  errors: readonly string[];
  message: string;
}

/**
 * Builds a solution in Release x64 and reports what MSBuild said.
 *
 * `/v:normal` and not `/v:minimal`: the verdict below wants the "Build succeeded." banner, and
 * minimal is known to omit it on at least one installation even on success.
 */
export async function buildSolution(solutionPath: string): Promise<BuildResult> {
  const msbuild = await findMsbuild();
  if (!msbuild) {
    return {
      attempted: false,
      succeeded: false,
      logPath: null,
      errors: [],
      message:
        'No MSBuild was found on this machine, so nothing was compiled and nothing can be claimed ' +
        `about the code. Point ${MSBUILD_VAR} at an MSBuild.exe.`,
    };
  }
  const solution = await toWindowsPath(solutionPath);
  const built = await run(
    msbuild,
    [solution, '/m', '/v:normal', '/p:Configuration=Release', '/p:Platform=x64'],
    undefined,
    BUILD_MAX_BUFFER,
  );
  const log = `${built.stdout}\n${built.stderr}`;
  const logPath = path.join(tmpdir(), `sunrise-build-${process.pid}.log`);
  await writeFile(logPath, log, 'utf8');
  const succeeded = buildSucceeded(built.code, log);
  const errors = succeeded ? [] : extractBuildErrors(log);
  return {
    attempted: true,
    succeeded,
    logPath,
    errors,
    message: succeeded
      ? `${solution} compiled. Full log at ${logPath}.`
      : `${solution} did not compile (${errors.length} error line(s) captured). Full log at ${logPath}.`,
  };
}
