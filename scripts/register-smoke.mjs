// scripts/register-smoke.mjs
import assert from 'node:assert/strict';
import { registerCapabilities } from '../dist/capabilities/register.js';
import { CAPABILITIES } from '../dist/capabilities/index.js';

// The barrel carries struct_read.
assert.ok(CAPABILITIES.some((c) => c.name === 'struct_read'), 'struct_read should be in CAPABILITIES');

// registerCapabilities calls server.registerTool(name, config, handler) once per capability,
// and the handler forwards to cap.run with the given ctx.
const registered = [];
const fakeServer = { registerTool: (name, config, handler) => registered.push({ name, config, handler }) };
const fakeCtx = { tag: 'CTX' };
let ranWith = null;
const caps = [{
  name: 'probe', config: { description: 'x' },
  run: async (args, ctx) => { ranWith = { args, ctx }; return { content: [{ type: 'text', text: 'ok' }] }; },
}];

registerCapabilities(fakeServer, fakeCtx, caps);
assert.equal(registered.length, 1);
assert.equal(registered[0].name, 'probe');
await registered[0].handler({ a: 1 });
assert.deepEqual(ranWith, { args: { a: 1 }, ctx: fakeCtx });

console.log('register-smoke: OK');
