// src/capabilities/mem-read-range.ts
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Capability, CapabilityContext } from './contract.js';

/**
 * Zero bytes that may sit inside a run rather than splitting it.
 *
 * A struct with an empty field in the middle should read as one run, not as one run per field. Eight
 * is a pointer, so a single null field never splits its neighbours apart.
 */
const DEFAULT_JOIN = 8;

export interface SpanRun {
  address: string;
  hex: string;
}

export interface CompressedSpan {
  allZero: boolean;
  zeroBytes: number;
  runs: SpanRun[];
}

function formatAddress(address: bigint): string {
  return `0x${address.toString(16).toUpperCase().padStart(16, '0')}`;
}

/**
 * Pure: turns a byte span into the islands of it that carry anything, each with its own address.
 *
 * The point is what it does NOT return. A 4096-byte page of zeros is sixteen mem.read calls and
 * 256 rows of "00 00 00 ..." read literally; here it is one boolean. Measured on the real game:
 * page rva 0x02F30000 was exactly that, and reading it cost sixteen calls to learn one fact.
 */
export function compressSpan(
  bytes: Uint8Array,
  baseAddress: bigint,
  joinDistance: number = DEFAULT_JOIN,
): CompressedSpan {
  const runs: SpanRun[] = [];
  let inRun = 0;
  let start = -1;
  let lastNonZero = -1;

  const flush = (): void => {
    if (start < 0) return;
    const slice = bytes.subarray(start, lastNonZero + 1);
    runs.push({
      address: formatAddress(baseAddress + BigInt(start)),
      hex: [...slice].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
    });
    inRun += lastNonZero + 1 - start;
    start = -1;
    lastNonZero = -1;
  };

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) continue;
    // A gap of at least joinDistance ends the previous run; anything shorter stays inside it.
    if (start >= 0 && i - lastNonZero > joinDistance) flush();
    if (start < 0) start = i;
    lastNonZero = i;
  }
  flush();

  return { allZero: runs.length === 0, zeroBytes: bytes.length - inRun, runs };
}

export const memReadRangeCapability: Capability = {
  name: 'mem_read_range',
  config: {
    description:
      'Reads a span of the game process and returns only the parts of it that carry anything. ' +
      'mem.read answers 256 bytes a call because a console Result holds 16 rows of 16 bytes, so a ' +
      '4096-byte page costs sixteen calls and gives back 256 hexdump rows whether or not any of ' +
      'them are non-zero -- and the pages worth looking at in this game are mostly zero. This ' +
      'reads the whole span (chunked internally) and returns { address, length, allZero, ' +
      'zeroBytes, runs }, where each run is one island of non-zero bytes with its own address. An ' +
      'all-zero page comes back as allZero:true and no rows at all, which is the single fact you ' +
      'were asking for. Use console_run mem.read when you want the literal hexdump of a known ' +
      'small range, and this when you are mapping what a page even contains.',
    inputSchema: {
      address: z.string().min(1).describe('Start of the span: decimal, or 0x-prefixed hex.'),
      length: z.number().int().positive().describe('Bytes to read. Chunked into 256-byte reads internally.'),
      joinDistance: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          `Zero bytes allowed inside a run before it is split in two (default ${DEFAULT_JOIN}, one pointer).`,
        ),
    },
  },
  async run(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CallToolResult> {
    try {
      const address = BigInt(String(args.address).trim());
      const length = Number(args.length);
      const joinDistance =
        args.joinDistance === undefined ? DEFAULT_JOIN : Number(args.joinDistance);
      const bytes = await ctx.mem.read(address, length);
      const span = compressSpan(bytes, address, joinDistance);
      const text = JSON.stringify(
        { address: formatAddress(address), length, ...span },
        null,
        2,
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  },
};
