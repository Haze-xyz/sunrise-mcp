// scripts/context-smoke.mjs
import assert from 'node:assert/strict';
import { buildContext } from '../dist/capabilities/context.js';

// A fake endpoint: buildContext must delegate console.runLine to it verbatim.
const seen = [];
const fakeEndpoint = {
  runLine: async (line) => { seen.push(line); return { id: 1, status: 'ok', summary: '', rows: [] }; },
  describe: async () => ({ id: 1, status: 'ok', entries: [] }),
};

const ctx = buildContext(fakeEndpoint);
assert.equal(typeof ctx.console.runLine, 'function');
assert.equal(typeof ctx.mem.read, 'function');
assert.equal(typeof ctx.game.launch, 'function');
assert.equal(typeof ctx.game.kill, 'function');
assert.equal(typeof ctx.game.processInfo, 'function');
assert.equal(typeof ctx.game.paths.log, 'function');
assert.equal(typeof ctx.log, 'function');

// Delegation is real, not a stub.
await ctx.console.runLine('console.version');
assert.deepEqual(seen, ['console.version']);

// The mem façade is wired onto the same console (a read issues a mem.read line).
await ctx.mem.read(0x1000n, 1).catch(() => {}); // fake returns no rows -> may reject; we only assert the line went out.
assert.ok(seen.some((l) => l.startsWith('mem.read ')), 'mem.read line should have been issued');

console.log('context-smoke: OK');
