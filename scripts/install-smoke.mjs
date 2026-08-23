#!/usr/bin/env node
/**
 * Table-driven test of decideInstallVerdict / describeInstallVerdict (dist/install-verdict.js) and
 * readSettings (dist/install.js). Pure functions over plain objects and strings: no game, no
 * filesystem, no endpoint.
 *
 * Run after `npm run build`:
 *   node scripts/install-smoke.mjs
 * or as part of:
 *   npm run test:install
 *
 * The two cases worth reading before the rest, because they are the ones that would send a reader to
 * the wrong place:
 *
 * - an endpoint whose state could not be read is reported unknown, never disabled. A probe-only read
 *   of an unparseable settings file cannot see inside `console_endpoint`, and "your endpoint is off"
 *   aimed at someone whose endpoint is on is a worse error than saying nothing.
 * - one missing fork key is a settings file someone edited; *both* missing is a different build.
 *   Only the second earns `notForkBuild`.
 */

import assert from 'node:assert/strict';
import { decideInstallVerdict, describeInstallVerdict } from '../dist/install-verdict.js';
import { readSettings } from '../dist/install.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

/** A healthy install. Cases override only the fact they are about. */
const healthy = {
  gameDirResolved: true,
  gameDirFromEnv: true,
  gameDirExists: true,
  exePresent: true,
  settingsPresent: true,
  settingsUnderstood: true,
  settingsVersion: 8,
  hasConsoleEndpoint: true,
  hasHoldCharacterSelect: true,
  endpointEnabled: true,
};

const CASES = [
  { name: 'healthy install -> ok', facts: {}, expected: 'ok' },
  { name: 'no directory resolved -> gameDirNotFound', facts: { gameDirResolved: false }, expected: 'gameDirNotFound' },
  { name: 'directory does not exist -> gameDirNotFound', facts: { gameDirExists: false }, expected: 'gameDirNotFound' },
  { name: 'directory without destiny2.exe -> gameDirNotFound', facts: { exePresent: false }, expected: 'gameDirNotFound' },
  { name: 'no settings file -> settingsMissing', facts: { settingsPresent: false }, expected: 'settingsMissing' },
  {
    name: 'settings that cannot be read at all -> settingsUnreadable',
    facts: { settingsUnderstood: false },
    expected: 'settingsUnreadable',
  },
  {
    name: 'neither fork key -> notForkBuild',
    facts: { hasConsoleEndpoint: false, hasHoldCharacterSelect: false, endpointEnabled: null },
    expected: 'notForkBuild',
  },
  {
    name: 'only hold_character_select missing is an edited file, not another build',
    facts: { hasHoldCharacterSelect: false },
    expected: 'ok',
  },
  {
    name: 'only console_endpoint missing is an edited file, not another build',
    facts: { hasConsoleEndpoint: false, endpointEnabled: null },
    expected: 'ok',
  },
  {
    name: 'the fork build with the endpoint switched off -> endpointDisabled',
    facts: { endpointEnabled: false },
    expected: 'endpointDisabled',
  },
  {
    name: 'an endpoint state that could not be read is unknown, never disabled',
    facts: { endpointEnabled: null },
    expected: 'ok',
  },
];

async function main() {
  for (const testCase of CASES) {
    await test(testCase.name, () => {
      const facts = { ...healthy, ...testCase.facts };
      assert.equal(decideInstallVerdict(facts), testCase.expected);
    });
  }

  await test('a missing directory blames the setting when there is one, and this server when there is not', () => {
    const paths = { gameDir: 'E:\\Destiny_Sunrise', settingsPath: 'E:\\...\\settings.json' };
    const fromEnv = describeInstallVerdict(
      'gameDirNotFound',
      { ...healthy, gameDirExists: false, gameDirFromEnv: true },
      paths,
    );
    assert.ok(fromEnv.includes('SUNRISE_GAME_DIR points at'), fromEnv);

    const fallback = describeInstallVerdict(
      'gameDirNotFound',
      { ...healthy, gameDirExists: false, gameDirFromEnv: false },
      paths,
    );
    assert.ok(fallback.includes('is not set'), fallback);
    // The sentence that had to change: the fallback path is the author's, and the message says so
    // instead of presenting it as the reader's own configuration.
    assert.ok(fallback.includes("author's own path"), fallback);
  });

  await test('every verdict describes itself, and names a file or a key to act on', () => {
    const paths = { gameDir: 'E:\\Destiny_Sunrise', settingsPath: 'E:\\x\\settings.json' };
    for (const verdict of [
      'ok',
      'gameDirNotFound',
      'settingsMissing',
      'settingsUnreadable',
      'notForkBuild',
      'endpointDisabled',
    ]) {
      const line = describeInstallVerdict(verdict, healthy, paths);
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 40, `${verdict} described itself in ${line.length} characters`);
    }
    assert.ok(describeInstallVerdict('notForkBuild', healthy, paths).includes('steam_api64.dll'));
    assert.ok(describeInstallVerdict('endpointDisabled', healthy, paths).includes('"enabled": true'));
    assert.ok(describeInstallVerdict('settingsMissing', healthy, paths).includes('bin\\x64\\settings.json'));
  });

  await test('a real settings document is read through JSON', () => {
    const findings = readSettings(
      JSON.stringify({
        version: 8,
        client: { hold_character_select: true },
        server: { console_endpoint: { enabled: false, port: 30975 } },
      }),
    );
    assert.equal(findings.understood, true);
    assert.equal(findings.version, 8);
    assert.equal(findings.hasConsoleEndpoint, true);
    assert.equal(findings.hasHoldCharacterSelect, true);
    assert.equal(findings.endpointEnabled, false);
    assert.equal(findings.endpointPort, 30975);
    assert.equal(findings.holdCharacterSelect, true);
  });

  await test('an upstream settings document is understood, and has neither fork key', () => {
    const findings = readSettings(JSON.stringify({ version: 8, client: { hold_spawn: true }, server: { bap_port: 30974 } }));
    assert.equal(findings.understood, true);
    assert.equal(findings.hasConsoleEndpoint, false);
    assert.equal(findings.hasHoldCharacterSelect, false);
    assert.equal(decideInstallVerdict({ ...healthy, ...findings, endpointEnabled: null }), 'notForkBuild');
  });

  await test('an unparseable document still answers the build question, and stays silent on the rest', () => {
    // A trailing comma: not JSON, still obviously the fork's shape.
    const findings = readSettings('{ "version": 6, "server": { "console_endpoint": { "enabled": true }, }, }');
    assert.equal(findings.understood, true);
    assert.equal(findings.version, 6);
    assert.equal(findings.hasConsoleEndpoint, true);
    // The point of the whole case: not read, so not reported as false.
    assert.equal(findings.endpointEnabled, null);
    assert.notEqual(decideInstallVerdict({ ...healthy, ...findings }), 'endpointDisabled');
  });

  await test('a document with nothing recognizable in it is reported unreadable', () => {
    const findings = readSettings('this is not a settings file');
    assert.equal(findings.understood, false);
    assert.equal(decideInstallVerdict({ ...healthy, settingsUnderstood: false }), 'settingsUnreadable');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('install smoke test crashed:', err);
  process.exit(1);
});
