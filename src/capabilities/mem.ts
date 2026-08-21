// src/capabilities/mem.ts
import type { SunriseConsole, MemFacade } from './contract.js';
import type { RunResponse } from '../endpoint.js';

const MAX_READ_BYTES = 256; // probe::kMaxReadBytes — mem.read's declared count max.

/** Parses one mem.read row value ("48 8B D9" — space-separated uppercase hex pairs) into bytes. */
function parseLineBytes(value: unknown): number[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const b = Number.parseInt(pair, 16);
      if (!Number.isInteger(b) || b < 0 || b > 0xff) {
        throw new Error(`mem.read returned a non-byte hex pair: ${JSON.stringify(pair)}`);
      }
      return b;
    });
}

/** Reassembles one mem.read response (rows keyed by line address) into a contiguous byte array. */
function reassemble(response: RunResponse, start: bigint, count: number): Uint8Array {
  if (response.status !== 'ok') {
    const detail = response.summary || response.rows.map((r) => `${r.key}=${String(r.value)}`).join(', ');
    throw new Error(`mem.read ${start.toString(10)} ${count} answered ${response.status}: ${detail}`);
  }
  // Sort rows by their line address (16-hex key, no 0x) so out-of-order rows still concatenate right.
  const lines = response.rows
    .map((row) => ({ addr: BigInt(`0x${String(row.key)}`), bytes: parseLineBytes(row.value) }))
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
  const out: number[] = [];
  for (const line of lines) out.push(...line.bytes);
  if (out.length < count) {
    throw new Error(`mem.read ${start.toString(10)} ${count} returned only ${out.length} bytes`);
  }
  return Uint8Array.from(out.slice(0, count));
}

export function createMemFacade(console: SunriseConsole): MemFacade {
  return {
    async read(address: bigint, length: number): Promise<Uint8Array> {
      if (length <= 0) return new Uint8Array(0);
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const chunk = Math.min(MAX_READ_BYTES, length - done);
        const start = address + BigInt(done);
        // Address MUST be decimal: the console parser rejects hex and >18-digit tokens.
        const response = await console.runLine(`mem.read ${start.toString(10)} ${chunk}`);
        out.set(reassemble(response, start, chunk), done);
        done += chunk;
      }
      return out;
    },
  };
}
