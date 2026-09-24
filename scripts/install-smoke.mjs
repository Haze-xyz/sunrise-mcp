#!/usr/bin/env node
/**
 * Table-driven test of decideInstallVerdict / describeInstallVerdict (dist/install-verdict.js) and
 * readMcpConfig / dllHasMcpLayer (dist/install.js). Pure functions over plain objects, strings and
 * buffers: no game, no filesystem, no endpoint.
 *
 * Run after `npm run build`:
 *   node scripts/install-smoke.mjs
 * or as part of:
 *   npm run test:install
 *
 * The two cases worth reading before the rest, because they are the ones that would send a reader to
 * the wrong place:
 *
 * - mcp.json is read with the DLL's own rules. A file the DLL would reject leaves the endpoint off in
 *   the game, so this server must call it invalid too, and never report "on" from a document the
 *   game ignored.
 * - the build is told from the DLL itself. Sunrise's settings.json no longer carries any key of this
 *   layer, so nothing in it can say whether the MCP layer was compiled in.
 */

import assert from 'node:assert/strict';
import { decideInstallVerdict, describeBootSettings, describeInstallVerdict } from '../dist/install-verdict.js';
import { dllHasMcpLayer, readMcpConfig } from '../dist/install.js';

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
  dllPresent: true,
  dllHasMcpLayer: true,
  mcpConfigPresent: true,
  mcpConfigValid: true,
  endpointEnabled: true,
  fileSink: true,
};

const CASES = [
  { name: 'healthy install -> ok', facts: {}, expected: 'ok' },
  { name: 'no directory resolved -> gameDirNotFound', facts: { gameDirResolved: false }, expected: 'gameDirNotFound' },
  { name: 'directory does not exist -> gameDirNotFound', facts: { gameDirExists: false }, expected: 'gameDirNotFound' },
  { name: 'directory without destiny2.exe -> gameDirNotFound', facts: { exePresent: false }, expected: 'gameDirNotFound' },
  { name: 'no steam_api64.dll -> notMcpBuild', facts: { dllPresent: false, dllHasMcpLayer: null }, expected: 'notMcpBuild' },
  { name: 'a DLL without the layer -> notMcpBuild', facts: { dllHasMcpLayer: false }, expected: 'notMcpBuild' },
  {
    name: 'a DLL that could not be read is unknown, and does not block the rest',
    facts: { dllHasMcpLayer: null },
    expected: 'ok',
  },
  { name: 'no mcp.json -> mcpConfigMissing', facts: { mcpConfigPresent: false, mcpConfigValid: false, endpointEnabled: false }, expected: 'mcpConfigMissing' },
  { name: 'an mcp.json the DLL would reject -> mcpConfigInvalid', facts: { mcpConfigValid: false, endpointEnabled: false }, expected: 'mcpConfigInvalid' },
  { name: 'endpoint off in mcp.json -> endpointDisabled', facts: { endpointEnabled: false }, expected: 'endpointDisabled' },
  { name: 'review I2: the log file switched off -> logFileOff, not ok', facts: { fileSink: false }, expected: 'logFileOff' },
  { name: 'a log setting that could not be read does not block', facts: { fileSink: null }, expected: 'ok' },
  { name: 'the endpoint question comes before the log one', facts: { endpointEnabled: false, fileSink: false }, expected: 'endpointDisabled' },
  {
    name: 'the build question comes before the config one',
    facts: { dllHasMcpLayer: false, mcpConfigPresent: false, mcpConfigValid: false, endpointEnabled: false },
    expected: 'notMcpBuild',
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
    const paths = { gameDir: 'E:\\Destiny_Sunrise', mcpConfigPath: 'E:\\x\\mcp.json', dllPath: 'E:\\x\\steam_api64.dll' };
    const fromEnv = describeInstallVerdict('gameDirNotFound', { ...healthy, gameDirExists: false, gameDirFromEnv: true }, paths);
    assert.ok(fromEnv.includes('SUNRISE_GAME_DIR points at'), fromEnv);
    const fallback = describeInstallVerdict('gameDirNotFound', { ...healthy, gameDirExists: false, gameDirFromEnv: false }, paths);
    assert.ok(fallback.includes('is not set'), fallback);
    assert.ok(fallback.includes("author's own path"), fallback);
  });

  await test('every verdict describes itself, and names a file or a key to act on', () => {
    const paths = { gameDir: 'E:\\Destiny_Sunrise', mcpConfigPath: 'E:\\x\\mcp.json', dllPath: 'E:\\x\\steam_api64.dll' };
    for (const verdict of ['ok', 'gameDirNotFound', 'notMcpBuild', 'mcpConfigMissing', 'mcpConfigInvalid', 'endpointDisabled', 'logFileOff']) {
      const line = describeInstallVerdict(verdict, healthy, paths);
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 40, `${verdict} described itself in ${line.length} characters`);
    }
    assert.ok(describeInstallVerdict('notMcpBuild', healthy, paths).includes('steam_api64.dll'));
    assert.ok(describeInstallVerdict('notMcpBuild', healthy, paths).includes('mcp'));
    const logOff = describeInstallVerdict('logFileOff', healthy, { ...paths, settingsPath: 'E:\\x\\settings.json' });
    assert.ok(logOff.includes('E:\\x\\settings.json') && logOff.includes('"file_sink": true'), logOff);
    for (const verdict of ['mcpConfigMissing', 'mcpConfigInvalid', 'endpointDisabled']) {
      const line = describeInstallVerdict(verdict, healthy, paths);
      assert.ok(line.includes('E:\\x\\mcp.json'), `${verdict} must name the file: ${line}`);
      assert.ok(line.includes('{"endpoint":{"enabled":true}}'), `${verdict} must show the fix: ${line}`);
    }
  });

  await test('mcp.json is read with the DLL rules: enabled, port, unknown keys skipped, BOM accepted', () => {
    assert.deepEqual(readMcpConfig('{"endpoint":{"enabled":true,"port":31000}}'), { valid: true, endpointEnabled: true, endpointPort: 31000 });
    assert.deepEqual(readMcpConfig('{}'), { valid: true, endpointEnabled: false, endpointPort: 30975 });
    assert.deepEqual(readMcpConfig('\uFEFF{"x":[1],"endpoint":{"enabled":true}}'), { valid: true, endpointEnabled: true, endpointPort: 30975 });
  });

  await test('an mcp.json the DLL rejects is invalid here too, with the endpoint off', () => {
    for (const text of [
      '',
      '[]',
      '{"endpoint":',
      '{"endpoint":{"enabled":"yes"}}',
      '{"endpoint":{"enabled":true,"port":70000}}',
      '{"endpoint":{"enabled":true,"port":0}}',
      '{"endpoint":{"enabled":true,"port":1.5}}',
      '{"endpoint":[]}',
    ]) {
      const read = readMcpConfig(text);
      assert.equal(read.valid, false, `accepted ${JSON.stringify(text)}`);
      assert.equal(read.endpointEnabled, false, `reported on from ${JSON.stringify(text)}`);
    }
  });

  await test('review I3: the TS reader agrees with the DLL reader on the cases where they used to differ', () => {
    // Rejected by the DLL (mcp_settings_parse.cpp), so the endpoint is off in the game.
    for (const text of [
      '{"endpoint":{"enabled":true,"port":30975.0}}',
      '{"endpoint":{"enabled":true,"port":1e4}}',
      '{"endpoint":{"enabled":null}}',
      '{"endpoint":{"enabled":true,"port":null}}',
      `{"x":${'['.repeat(20)}${']'.repeat(20)},"endpoint":{"enabled":true}}`,
    ]) {
      const read = readMcpConfig(text);
      assert.equal(read.valid, false, `accepted ${text}`);
      assert.equal(read.endpointEnabled, false, `reported on from ${text}`);
    }
    // Accepted by the DLL, so this server must not call it invalid (and ensureEndpointEnabled must
    // not replace a file the game is happily reading).
    assert.deepEqual(readMcpConfig('{"endpoint":{"enabled":true,"port":0080}}'), { valid: true, endpointEnabled: true, endpointPort: 80 });
    assert.deepEqual(readMcpConfig('{"other":+5,"endpoint":{"enabled":true}}'), { valid: true, endpointEnabled: true, endpointPort: 30975 });
    // Keys are compared as written, escapes undecoded, exactly as the DLL does: this is not "endpoint".
    assert.deepEqual(readMcpConfig('{"\\u0065ndpoint":{"enabled":true}}'), { valid: true, endpointEnabled: false, endpointPort: 30975 });
  });

  await test('the MCP layer is recognised in a DLL by the menu page it registers', () => {
    assert.equal(dllHasMcpLayer(Buffer.from('xx\0mcp.console\0yy', 'latin1')), true);
    assert.equal(dllHasMcpLayer(Buffer.from('xx\0core.logs\0yy', 'latin1')), false);
  });

  await test('the endpoint note names the port when it is on, and says what off costs', () => {
    const on = describeBootSettings({ endpointEnabled: true, endpointPort: 30975 }).join('\n');
    assert.ok(on.includes('30975'), on);
    const off = describeBootSettings({ endpointEnabled: false, endpointPort: 30975 }).join('\n');
    assert.ok(off.includes('refused'), off);
  });

  await test('a log file switched off is named, because log_read and wait_for then see nothing', () => {
    const off = describeBootSettings({ endpointEnabled: true, endpointPort: 30975, fileSink: false }).join('\n');
    assert.ok(off.includes('file_sink'), off);
    assert.ok(off.includes('wait_for'), off);
    const on = describeBootSettings({ endpointEnabled: true, endpointPort: 30975, fileSink: true }).join('\n');
    assert.ok(!on.includes('file_sink": false'), on);
    const unknown = describeBootSettings({ endpointEnabled: true, endpointPort: 30975, fileSink: null }).join('\n');
    assert.ok(unknown.includes('file_sink'), unknown);
  });

  await test('every set of notes says the values are boot-time', () => {
    for (const enabled of [true, false]) {
      const notes = describeBootSettings({ endpointEnabled: enabled, endpointPort: 30975 });
      assert.ok(notes[0].includes('restart'), notes[0]);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('install smoke test crashed:', err);
  process.exit(1);
});
