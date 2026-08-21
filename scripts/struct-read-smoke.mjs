// scripts/struct-read-smoke.mjs
import assert from 'node:assert/strict';
import { decodeStruct, structReadCapability } from '../dist/capabilities/struct-read.js';

// Little-endian buffer: u32=0x11223344 at +0, f32=1.5 at +8, u64=0xDEADBEEFCAFEBABE at +16, i8=-2 at +24.
const buf = new Uint8Array(32);
const dv = new DataView(buf.buffer);
dv.setUint32(0, 0x11223344, true);
dv.setFloat32(8, 1.5, true);
dv.setBigUint64(16, 0xdeadbeefcafebaben, true);
dv.setInt8(24, -2);

// 1) decodeStruct is pure: bytes + fields -> decoded values.
{
  const fields = [
    { name: 'a', offset: 0, type: 'u32' },
    { name: 'f', offset: 8, type: 'f32' },
    { name: 'p', offset: 16, type: 'ptr' },
    { name: 's', offset: 24, type: 'i8' },
  ];
  const out = decodeStruct(buf, fields);
  assert.equal(out.a, 0x11223344);
  assert.equal(out.f, 1.5);
  assert.equal(out.p, '0xDEADBEEFCAFEBABE');
  assert.equal(out.s, -2);
}

// 2) The capability reads exactly the covering span in one mem.read and reports decoded fields.
{
  const reads = [];
  const ctx = {
    mem: {
      read: async (address, length) => {
        reads.push({ address, length });
        // Serve the covering span [min=0 .. max=25]; return the 32-byte buf sliced.
        return buf.slice(Number(address - 0x140000000n), Number(address - 0x140000000n) + length);
      },
    },
    console: { runLine: async () => ({}), describe: async () => ({}) },
    game: {}, log: () => {},
  };
  const res = await structReadCapability.run(
    { address: '0x140000000', fields: [
      { name: 'a', offset: 0, type: 'u32' },
      { name: 's', offset: 24, type: 'i8' },
    ] },
    ctx,
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.fields.a, 0x11223344);
  assert.equal(payload.fields.s, -2);
  // One read covering offset 0..25 (i8 at 24 ends at 25).
  assert.equal(reads.length, 1);
  assert.equal(reads[0].address, 0x140000000n);
  assert.equal(reads[0].length, 25);
}

// 3) Tool name and schema shape.
assert.equal(structReadCapability.name, 'struct_read');
assert.ok(structReadCapability.config.inputSchema.address);
assert.ok(structReadCapability.config.inputSchema.fields);

console.log('struct-read-smoke: OK');
