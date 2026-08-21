#!/usr/bin/env node
/**
 * Live end-to-end check of the struct_read capability against the RUNNING game.
 * MUST run under Windows node (WSL cannot reach the game's loopback socket). It opens the ONE
 * endpoint connection, so nothing else (the session's MCP server) may hold it while this runs.
 *
 * Proves: struct_read, given the image base, decodes the PE header's e_magic = 0x5A4D ("MZ").
 * Throwaway driver — not part of the committed test suite.
 */
import assert from 'node:assert/strict';
import { SunriseEndpointClient } from '../dist/endpoint.js';
import { buildContext } from '../dist/capabilities/context.js';
import { structReadCapability } from '../dist/capabilities/struct-read.js';

const endpoint = new SunriseEndpointClient({ requestTimeoutMs: 30000 });
try {
  // 1) Get the main image base from the live process.
  const mod = await endpoint.runLine('mem.module');
  if (mod.status !== 'ok') throw new Error(`mem.module answered ${mod.status}: ${mod.summary}`);
  const baseHex = mod.rows.find((r) => r.key === 'base_hex')?.value;
  if (typeof baseHex !== 'string') throw new Error(`no base_hex row: ${JSON.stringify(mod.rows)}`);
  console.log(`image base = 0x${baseHex}`);

  // 2) Run the REAL struct_read capability against live memory: decode the PE header.
  const ctx = buildContext(endpoint);
  const res = await structReadCapability.run(
    {
      address: `0x${baseHex}`,
      fields: [
        { name: 'e_magic', offset: 0, type: 'u16' },
        { name: 'e_lfanew', offset: 60, type: 'u32' },
      ],
    },
    ctx,
  );
  console.log(res.content[0].text);
  if (res.isError) throw new Error(`struct_read reported error: ${res.content[0].text}`);
  const payload = JSON.parse(res.content[0].text);

  // 3) Assert e_magic decodes to 0x5A4D ("MZ", little-endian) — the end-to-end proof.
  assert.equal(payload.fields.e_magic, 0x5a4d, `e_magic should be 0x5A4D (MZ), got ${payload.fields.e_magic}`);
  console.log(
    `\nstruct-read-live: OK — e_magic = 0x${payload.fields.e_magic.toString(16).toUpperCase()} (MZ), ` +
      `e_lfanew = ${payload.fields.e_lfanew} (PE header offset)`,
  );
} finally {
  await endpoint.close();
}
