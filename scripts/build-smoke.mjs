// Offline checks for src/build.ts: the MSBuild verdict, the error digest, the arguments a build is
// run with, and how a Sunrise checkout is found. No MSBuild and no game are needed.
//
// Run: npm run test:build

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSucceeded, extractBuildErrors, looksLikeForkCheckout, msbuildArgs, resolveForkDir } from '../dist/build.js';

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

async function main() {
  await test('a build counts as green only when the exit code AND the banner agree', () => {
    const green = 'Sunrise.vcxproj -> steam_api64.dll\n\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n';
    assert.equal(buildSucceeded(0, green), true);
    // The known trap on this installation: /v:minimal omits the banner even on success, and an
    // agent once read that as failure. Here the reverse is enforced -- no banner, no claim.
    assert.equal(buildSucceeded(0, 'Sunrise.vcxproj -> steam_api64.dll\n'), false);
    assert.equal(buildSucceeded(1, green), false);
    assert.equal(buildSucceeded(0, 'Build succeeded with warnings.'), false);
  });

  await test('build errors are extracted, deduplicated and capped', () => {
    const log = [
      'foo.cpp(12,5): error C2065: undeclared identifier',
      'foo.cpp(12,5): error C2065: undeclared identifier',
      '  Creating library steam_api64.lib',
      'bar.cpp(3,1): error LNK2019: unresolved external symbol',
    ].join('\n');
    const errors = extractBuildErrors(log);
    assert.equal(errors.length, 2, 'the duplicate must collapse');
    assert.ok(errors[0].includes('C2065'));
    assert.ok(errors[1].includes('LNK2019'));
    assert.deepEqual(extractBuildErrors('nothing wrong here'), []);
  });

  await test('a checkout is recognized by the file the build cannot do without', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sync-smoke-'));
    assert.equal(await looksLikeForkCheckout(root), false);
    await mkdir(path.join(root, 'Sunrise'), { recursive: true });
    await writeFile(path.join(root, 'Sunrise', 'Sunrise.vcxproj'), '<Project/>', 'utf8');
    assert.equal(await looksLikeForkCheckout(root), true);
  });

  await test('the fork directory is never guessed: argument, then env, then cwd, then refuse', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'sync-smoke-real-'));
    await mkdir(path.join(real, 'Sunrise'), { recursive: true });
    await writeFile(path.join(real, 'Sunrise', 'Sunrise.vcxproj'), '<Project/>', 'utf8');
    const empty = await mkdtemp(path.join(tmpdir(), 'sync-smoke-empty-'));

    assert.equal(await resolveForkDir(real, {}, empty), path.resolve(real), 'the argument wins');
    assert.equal(
      await resolveForkDir(undefined, { SUNRISE_FORK_DIR: real }, empty),
      path.resolve(real),
      'the env var is used when there is no argument',
    );
    assert.equal(await resolveForkDir(undefined, {}, real), path.resolve(real), 'the cwd is the last resort');
    // The whole point: nothing left to try means an error naming what to set, not a default path
    // that happens to be the author's machine.
    await assert.rejects(
      () => resolveForkDir(undefined, {}, empty),
      (err) => err.message.includes('SUNRISE_FORK_DIR') && err.message.includes('--repo'),
      'refusing must say what to set',
    );
    // An argument pointing at something that is not a checkout must not silently fall through to a
    // directory that is: the caller named a place, and being wrong about it has to be visible.
    await assert.rejects(() => resolveForkDir(empty, {}, empty));
  });

  await test('a build asks for the 64-bit compiler, as upstream CI does, or big generated files run out of heap', () => {
    const args = msbuildArgs('C:\\x\\Sunrise.sln');
    assert.equal(args[0], 'C:\\x\\Sunrise.sln');
    for (const flag of ['/m', '/v:normal', '/p:Configuration=Release', '/p:Platform=x64', '/p:PreferredToolArchitecture=x64']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('build smoke test crashed:', err);
  process.exit(1);
});
