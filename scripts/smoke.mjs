#!/usr/bin/env node
// Live round trip against a running game, through the endpoint client only — no MCP layer
// involved. This is the same exchange that was first proven by hand over a raw socket; running it
// here proves the TypeScript client speaks the protocol the game actually answers, end to end.
//
// PREREQUISITES — both required, or this hangs silently instead of failing loudly:
//
//   1. The Sunrise game must already be running (via game_launch, or by hand). This is a live
//      round trip against the real console endpoint, unlike scripts/endpoint-smoke.mjs, which
//      uses a fake server and needs no game.
//   2. Must run under WINDOWS node.exe, never WSL node. WSL is NAT-mode on this machine, so its
//      127.0.0.1 is the WSL VM's own loopback, not Windows' — a WSL process cannot reach the
//      endpoint at all. Under WSL you will NOT see a connection-refused error; every request will
//      just sit until this client's own request timeout fires (10s by default). See README.md.
//
// Run (from Windows node, with the game already up):
//   npm run smoke
// or directly, after `npm run build`:
//   node.exe scripts/smoke.mjs
//
// Mutates movement.fly_speed on the running game to prove a write persists, then restores it to
// whatever value it read at the start — see the `finally` block below.

import { performance } from 'node:perf_hooks';
import { SunriseEndpointClient, EndpointRequestTooLargeError } from '../dist/endpoint.js';

let failures = 0;
function check(condition, what, detail) {
  const mark = condition ? ' ok ' : 'FAIL';
  console.log(`  [${mark}] ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!condition) { failures += 1; }
}

const client = new SunriseEndpointClient();
let originalFlySpeed; // Captured during 'read', restored in `finally` regardless of outcome.

try {
  console.log('describe');
  const registry = await client.describe();
  check(registry.status === 'ok', 'the registry answers ok', registry.status);
  check(Array.isArray(registry.entries) && registry.entries.length > 0,
        'it carries entries', `${registry.entries?.length} entries`);
  const flySpeed = registry.entries?.find((e) => e.name === 'movement.fly_speed');
  check(flySpeed !== undefined, 'movement.fly_speed is among them');
  check(flySpeed?.minimum === 1 && flySpeed?.maximum === 100,
        'its bounds come back as numbers', `${flySpeed?.minimum}..${flySpeed?.maximum}`);

  console.log('read');
  const before = await client.runLine('movement.fly_speed');
  check(before.status === 'ok', 'a read answers ok', before.status);
  const readValue = before.rows?.[0]?.value;
  check(typeof readValue === 'number', 'its value is a JSON number', String(readValue));
  if (typeof readValue === 'number') originalFlySpeed = readValue;

  console.log('write');
  const target = readValue === 42 ? 43 : 42;
  const write = await client.runLine(`movement.fly_speed ${target}`);
  check(write.status === 'ok', 'a write answers ok', write.status);
  check(write.rows?.[0]?.value === target, 'and echoes the value it set', String(write.rows?.[0]?.value));

  console.log('read back');
  const after = await client.runLine('movement.fly_speed');
  check(after.rows?.[0]?.value === target, 'the value stuck', String(after.rows?.[0]?.value));

  console.log('refusals');
  const tooBig = await client.runLine('movement.fly_speed 999');
  check(tooBig.status === 'outOfRange', 'out of range is refused by name', tooBig.status);
  const unchanged = await client.runLine('movement.fly_speed');
  check(unchanged.rows?.[0]?.value === target, 'and the refusal changed nothing',
        String(unchanged.rows?.[0]?.value));

  const unknown = await client.runLine('nope.not_a_command');
  check(unknown.status === 'unknownName', 'an unknown name is refused by name', unknown.status);
  const badArg = await client.runLine('movement.fly_speed abc');
  check(badArg.status === 'badArgument', 'a bad argument is refused by name', badArg.status);

  console.log('client-side guard');
  // Checking "some error was thrown" would also pass if the 512-byte guard were deleted and the
  // line were instead sent to the game and refused for some unrelated reason. Check the specific
  // error type, and that it came back fast (a client-side rejection is near-instant; a real round
  // trip to the game and back would not be) — both are needed to actually pin "refused locally,
  // never sent", which is the property this step exists to prove.
  const guardStart = performance.now();
  let guardError;
  try {
    await client.runLine(`movement.fly_speed ${'x'.repeat(600)}`);
  } catch (error) {
    guardError = error;
  }
  const guardElapsedMs = performance.now() - guardStart;
  check(guardError instanceof EndpointRequestTooLargeError,
        'an over-long line is refused with the client-side guard error',
        guardError ? `${guardError.constructor.name}: ${guardError.message}` : 'no error thrown');
  check(guardElapsedMs < 50,
        'and it is refused immediately, not after a round trip to the game',
        `${guardElapsedMs.toFixed(1)}ms`);

  console.log('concurrency');
  const [a, b] = await Promise.all([
    client.runLine('movement.fly_speed'),
    client.runLine('movement.distance'),
  ]);
  check(a.rows?.[0]?.key === 'movement.fly_speed', 'two in flight resolve to their own requests',
        a.rows?.[0]?.key);
  check(b.rows?.[0]?.key === 'movement.distance', 'both of them', b.rows?.[0]?.key);
} catch (error) {
  console.log(`  [FAIL] threw: ${error?.constructor?.name}: ${error?.message}`);
  failures += 1;
} finally {
  if (typeof originalFlySpeed === 'number') {
    console.log('restore');
    try {
      const restore = await client.runLine(`movement.fly_speed ${originalFlySpeed}`);
      check(restore.status === 'ok' && restore.rows?.[0]?.value === originalFlySpeed,
            'restored movement.fly_speed to what it read at the start',
            String(restore.rows?.[0]?.value));
    } catch (error) {
      check(false, 'restored movement.fly_speed to what it read at the start',
            `threw: ${error?.constructor?.name}: ${error?.message}`);
    }
  }
  await client.close();
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILURES'} (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
