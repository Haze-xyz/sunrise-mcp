#!/usr/bin/env node
/**
 * Measures the one assumption the log cursor rests on: does a file's identity, as Node reports it
 * on Windows/NTFS, change across the rotation the game performs at every start?
 *
 * log.cpp:116 does MoveFileExW(log, log.old, MOVEFILE_REPLACE_EXISTING) and then
 * CreateFileW(log, ..., CREATE_ALWAYS). Node's fs.rename is that same MoveFileExW, and opening
 * with 'w' is that same CREATE_ALWAYS -- so this reproduces the rotation without destiny2.exe.
 *
 * Must run under Windows node on the volume the game actually logs to. WSL's filesystem answers a
 * different question, so a pass here under WSL proves nothing.
 *
 *   /mnt/c/nvm4w/nodejs/node.exe scripts/log-identity-probe.mjs [dir]
 */

import { stat, rename, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_DIR = 'E:\\Destiny_Sunrise\\bin\\x64\\Sunrise\\logs';

function identity(s) {
  return { ino: String(s.ino), birthtimeMs: Math.trunc(s.birthtimeMs), size: s.size };
}

async function main() {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  await mkdir(dir, { recursive: true });
  const live = path.join(dir, 'identity-probe.log');
  const old = `${live}.old`;

  await rm(live, { force: true });
  await rm(old, { force: true });

  await writeFile(live, 'first life\r\n'.repeat(40), 'utf8');
  const before = identity(await stat(live));

  // The rotation, byte for byte what open_log_file does.
  await rename(live, old);
  await writeFile(live, 'second life\r\n', 'utf8');
  const after = identity(await stat(live));

  const inoChanged = before.ino !== after.ino;
  const birthChanged = before.birthtimeMs !== after.birthtimeMs;
  const shrank = after.size < before.size;

  console.log(`dir              ${dir}`);
  console.log(`before           ino=${before.ino} birthtimeMs=${before.birthtimeMs} size=${before.size}`);
  console.log(`after            ino=${after.ino} birthtimeMs=${after.birthtimeMs} size=${after.size}`);
  console.log(`ino changed      ${inoChanged}`);
  console.log(`birthtime changed ${birthChanged}`);
  console.log(`file shrank      ${shrank}   (the second, independent rotation test)`);

  await rm(live, { force: true });
  await rm(old, { force: true });

  if (inoChanged || birthChanged) {
    console.log('\nVERDICT ok: the id "<ino>:<birthtimeMs>" distinguishes the two lives.');
    process.exit(0);
  }
  console.log('\nVERDICT failed: identity is unchanged across a rotation. log-cursor.ts cannot');
  console.log('rely on it; only the size test survives, and it misses a rotation into a file that');
  console.log('has already grown past the old size. Stop and revise the spec.');
  process.exit(1);
}

main().catch((err) => {
  console.error('log-identity-probe crashed:', err);
  process.exit(1);
});
