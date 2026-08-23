#!/usr/bin/env node
/**
 * Tests deployDll (dist/deploy.js) against throwaway directories: a fake fork checkout holding a
 * fake built DLL, and a fake game install. Real files, no game, no MSBuild -- the same no-mock
 * pattern character-smoke.mjs uses for the settings file.
 *
 * What it cannot cover, stated rather than implied: the refusal while destiny2.exe is running.
 * That path calls the real tasklist and needs a real running game, so these cases all run with the
 * game absent. The refusal itself is one branch reading one boolean; what is untested here is
 * whether Windows would really have failed the copy, which is the reason the branch exists.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deployDll, deployBackupPath } from '../dist/deploy.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

async function makeFork(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-fork-'));
  await mkdir(path.join(dir, 'build', 'x64', 'Release'), { recursive: true });
  await writeFile(path.join(dir, 'build', 'x64', 'Release', 'steam_api64.dll'), contents);
  return dir;
}

async function makeGame(existing) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-game-'));
  await mkdir(path.join(dir, 'bin', 'x64'), { recursive: true });
  if (existing !== undefined) await writeFile(path.join(dir, 'bin', 'x64', 'steam_api64.dll'), existing);
  return dir;
}

async function main() {
  await test('no built DLL -> refused, naming what to do, nothing copied', async () => {
    const fork = await mkdtemp(path.join(tmpdir(), 'deploy-empty-'));
    const game = await makeGame('old');
    const result = await deployDll(fork, game);
    assert.equal(result.status, 'refused');
    assert.ok(result.message.includes('Build the solution first'), result.message);
    assert.equal(await readFile(path.join(game, 'bin', 'x64', 'steam_api64.dll'), 'utf8'), 'old');
  });

  await test('it lands in bin\\x64, not the game root', async () => {
    const fork = await makeFork('new-build');
    const game = await makeGame('old-build');
    const result = await deployDll(fork, game);
    assert.equal(result.status, 'deployed');
    assert.equal(await readFile(path.join(game, 'bin', 'x64', 'steam_api64.dll'), 'utf8'), 'new-build');
    await assert.rejects(() => stat(path.join(game, 'steam_api64.dll')), 'the game root must stay empty');
  });

  await test('the DLL that was there first is kept, once, and never overwritten after', async () => {
    const game = await makeGame('the-original');
    const backup = deployBackupPath(path.join(game, 'bin', 'x64', 'steam_api64.dll'));

    const first = await deployDll(await makeFork('build-one'), game);
    assert.equal(first.status, 'deployed');
    assert.equal(await readFile(backup, 'utf8'), 'the-original');

    // The point: a backup refreshed on every deploy would destroy the pre-server state on the
    // second call, which is the only state it exists to preserve.
    const second = await deployDll(await makeFork('build-two'), game);
    assert.equal(second.status, 'deployed');
    assert.equal(await readFile(backup, 'utf8'), 'the-original', 'the backup must still be the FIRST original');
    assert.equal(await readFile(path.join(game, 'bin', 'x64', 'steam_api64.dll'), 'utf8'), 'build-two');
  });

  await test('an install with no DLL at all is deployed to, and says there was nothing to keep', async () => {
    const game = await makeGame();
    const result = await deployDll(await makeFork('first-ever'), game);
    assert.equal(result.status, 'deployed');
    assert.equal(result.backupPath, null);
    assert.ok(result.message.includes('no DLL before'), result.message);
  });

  await test('what landed is identified by size and hash, not asserted', async () => {
    const result = await deployDll(await makeFork('0123456789'), await makeGame('x'));
    assert.equal(result.bytes, 10);
    assert.equal(typeof result.sha256, 'string');
    assert.equal(result.sha256.length, 16);
    assert.ok(result.message.includes('10 bytes'), result.message);
    // A deploy changes nothing about the process already running, and the message has to say so.
    assert.ok(result.message.includes('next launch'), result.message);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('deploy smoke crashed:', err);
  process.exit(1);
});
