// scripts/mem-facade-smoke.mjs
import assert from 'node:assert/strict';
import { createMemFacade } from '../dist/capabilities/mem.js';

// A fake console that answers mem.read deterministically: byte at absolute
// address A has value (A & 0xff). Mirrors the wire shape exactly: one row per
// 16-byte line, key = 16-uppercase-hex line address (no 0x), value = space-
// separated uppercase hex byte pairs.
function fakeConsole() {
  const calls = [];
  return {
    calls,
    describe: async () => ({ id: 1, status: 'ok', entries: [] }),
    runLine: async (line) => {
      const m = /^mem\.read (\d+) (\d+)$/.exec(line);
      assert.ok(m, `unexpected line: ${line}`);
      const start = BigInt(m[1]);
      const count = Number(m[2]);
      assert.ok(count >= 1 && count <= 256, `count out of range: ${count}`);
      calls.push({ start, count });
      const rows = [];
      for (let lineOff = 0; lineOff < count; lineOff += 16) {
        const lineAddr = start + BigInt(lineOff);
        const n = Math.min(16, count - lineOff);
        const pairs = [];
        for (let i = 0; i < n; i++) {
          const b = Number((lineAddr + BigInt(i)) & 0xffn);
          pairs.push(b.toString(16).toUpperCase().padStart(2, '0'));
        }
        rows.push({ key: lineAddr.toString(16).toUpperCase().padStart(16, '0'), value: pairs.join(' ') });
      }
      return { id: 1, status: 'ok', summary: '', rows };
    },
  };
}

// 1) A simple read within one call reassembles in address order.
{
  const con = fakeConsole();
  const mem = createMemFacade(con);
  const base = 0x140000000n;
  const bytes = await mem.read(base, 20);
  assert.equal(bytes.length, 20);
  for (let i = 0; i < 20; i++) assert.equal(bytes[i], Number((base + BigInt(i)) & 0xffn), `byte ${i}`);
  assert.equal(con.calls.length, 1);
  assert.deepEqual(con.calls[0], { start: base, count: 20 });
}

// 2) A read longer than 256 chunks into 256 + remainder and concatenates in order.
{
  const con = fakeConsole();
  const mem = createMemFacade(con);
  const base = 0x7ff600000000n;
  const bytes = await mem.read(base, 300);
  assert.equal(bytes.length, 300);
  for (let i = 0; i < 300; i++) assert.equal(bytes[i], Number((base + BigInt(i)) & 0xffn), `byte ${i}`);
  assert.equal(con.calls.length, 2);
  assert.deepEqual(con.calls[0], { start: base, count: 256 });
  assert.deepEqual(con.calls[1], { start: base + 256n, count: 44 });
}

// 3) A non-ok status rejects with the endpoint's summary in the message.
{
  const con = {
    describe: async () => ({ id: 1, status: 'ok', entries: [] }),
    runLine: async () => ({ id: 1, status: 'failed', summary: 'only 8 of 16 bytes readable',
      rows: [{ key: 'readable_bytes', value: 8 }] }),
  };
  const mem = createMemFacade(con);
  await assert.rejects(() => mem.read(0x1000n, 16), /only 8 of 16 bytes readable/);
}

console.log('mem-facade-smoke: OK');
