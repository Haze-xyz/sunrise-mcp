/**
 * Running a child process and getting its exit code back instead of an exception.
 *
 * Every caller here treats a non-zero exit as information -- MSBuild says "does not compile" that
 * way, vswhere says "not installed" that way -- so the one thing this must not do is throw on it.
 */

import { execFile } from 'node:child_process';

/** A git command's output fits comfortably; a full MSBuild log does not (~1.5 MB of text). */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;
export const BUILD_MAX_BUFFER = 64 * 1024 * 1024;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command, resolving with its exit code rather than rejecting on a non-zero one. */
export function run(
  file: string,
  args: readonly string[],
  cwd?: string,
  maxBuffer = GIT_MAX_BUFFER,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** git, in a working directory. */
export const git = (args: readonly string[], cwd: string): Promise<RunResult> => run('git', args, cwd);
