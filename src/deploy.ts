/**
 * Putting a freshly built `steam_api64.dll` into the game.
 *
 * This is the step that was missing for an agent to close its own loop: it could already edit the
 * C++, compile it, kill the game and start it again, and the endpoint client reconnects on its own
 * when the game comes back. What no code did was carry the binary the twenty centimetres from
 * `build\x64\Release` to `bin\x64` -- so every overnight iteration stopped there and waited for a
 * person.
 *
 * One hard ordering constraint, and it is Windows', not a policy: a running `destiny2.exe` holds an
 * open handle on the DLL, so the copy fails while the game is up. `game_kill` already waits for the
 * process to actually leave the process table rather than for taskkill to return, which is exactly
 * what makes "kill, deploy, launch" work as three calls in a row.
 */

import { access, copyFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { getGameProcessInfo } from './tasklist.js';

/**
 * Where MSBuild leaves it, and where the game loads it from -- the latter being `bin\x64`, not the
 * game root, because that is where the loader looks.
 *
 * Joined with `path.join` and not `path.win32.join`, unlike the display paths elsewhere in this
 * server: these are handed to `copyFile`, so they have to be the running platform's own, and on the
 * Windows node this actually deploys from, `path.join` *is* `path.win32.join`.
 */
const BUILT_DLL = ['build', 'x64', 'Release', 'steam_api64.dll'];
const DEPLOYED_DLL = ['bin', 'x64', 'steam_api64.dll'];

export interface DeployResult {
  status: 'deployed' | 'refused';
  source: string;
  target: string;
  /** Bytes and SHA-256 of what is now in place, so a caller can prove which build is loaded. */
  bytes: number | null;
  sha256: string | null;
  /** Where the DLL that was there first was kept. Written once, never overwritten. */
  backupPath: string | null;
  message: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Identifies a binary in a way a message can carry. */
async function fingerprint(file: string): Promise<{ bytes: number; sha256: string }> {
  const [info, contents] = await Promise.all([stat(file), readFile(file)]);
  return { bytes: info.size, sha256: createHash('sha256').update(contents).digest('hex').slice(0, 16) };
}

/** Where the pre-existing DLL is kept, once. */
export function deployBackupPath(target: string): string {
  return `${target}.sunrise-mcp-backup`;
}

/**
 * Copies the fork's built DLL into the game.
 *
 * @param forkDir The Sunrise checkout MSBuild ran in.
 * @param gameDir The game install, the folder holding destiny2.exe.
 * @returns What was done, or `refused` with the reason and what to do about it. Never throws for a
 *          condition a caller can fix.
 */
export async function deployDll(forkDir: string, gameDir: string): Promise<DeployResult> {
  const source = path.join(forkDir, ...BUILT_DLL);
  const target = path.join(gameDir, ...DEPLOYED_DLL);
  const refuse = (message: string): DeployResult => ({
    status: 'refused',
    source,
    target,
    bytes: null,
    sha256: null,
    backupPath: null,
    message,
  });

  if (!(await exists(source))) {
    return refuse(
      `No built DLL at ${source}. Build the solution first (Release x64); nothing was copied.`,
    );
  }

  // Checked before anything is written. A running game holds the file open, so the copy would fail
  // partway and leave the install with a DLL that is neither the old one nor the new one.
  const process_ = await getGameProcessInfo();
  if (process_.running) {
    return refuse(
      `destiny2.exe is running${process_.pid === undefined ? '' : ` (pid ${process_.pid})`}, and it ` +
        'holds an open handle on the DLL, so it cannot be replaced. Call game_kill first -- it waits ' +
        'for the process to actually leave the process table -- then deploy, then launch. Nothing ' +
        'was copied.',
    );
  }

  const backupPath = deployBackupPath(target);
  const hadTarget = await exists(target);
  let backedUp: string | null = null;
  try {
    // Written once and never again, like the settings backup: the point of it is the state before
    // this server ever touched the install, which a backup refreshed on every deploy would destroy
    // on the second one.
    if (hadTarget && !(await exists(backupPath))) {
      await copyFile(target, backupPath);
      backedUp = backupPath;
    } else if (hadTarget) {
      backedUp = backupPath;
    }
    await copyFile(source, target);
  } catch (err) {
    return refuse(
      `Copying ${source} to ${target} failed (${err instanceof Error ? err.message : String(err)}). ` +
        'The install may be untouched or half-written; check it before launching.',
    );
  }

  const { bytes, sha256 } = await fingerprint(target);
  return {
    status: 'deployed',
    source,
    target,
    bytes,
    sha256,
    backupPath: backedUp,
    message:
      `Deployed ${bytes} bytes (sha256 ${sha256}...) to ${target}` +
      `${backedUp === null ? ', where there was no DLL before' : `; the original is at ${backedUp}`}. ` +
      'The game loads it at startup, so this takes effect on the next launch.',
  };
}
