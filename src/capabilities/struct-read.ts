// src/capabilities/struct-read.ts
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Capability, CapabilityContext } from './contract.js';

const FIELD_TYPES = ['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'ptr'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

export interface StructField {
  name: string;
  offset: number;
  type: FieldType;
}

const SIZES: Record<FieldType, number> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, ptr: 8,
};

/** Little-endian (x64) decode of one field out of an already-read byte span. */
function decodeField(dv: DataView, at: number, type: FieldType): number | string {
  switch (type) {
    case 'u8': return dv.getUint8(at);
    case 'i8': return dv.getInt8(at);
    case 'u16': return dv.getUint16(at, true);
    case 'i16': return dv.getInt16(at, true);
    case 'u32': return dv.getUint32(at, true);
    case 'i32': return dv.getInt32(at, true);
    case 'f32': return dv.getFloat32(at, true);
    case 'f64': return dv.getFloat64(at, true);
    case 'i64': return dv.getBigInt64(at, true).toString(10);
    case 'u64':
    case 'ptr': return `0x${dv.getBigUint64(at, true).toString(16).toUpperCase().padStart(16, '0')}`;
  }
}

/** Pure: decode every field out of `bytes` (the span already read at the covering base). */
export function decodeStruct(bytes: Uint8Array, fields: StructField[]): Record<string, number | string> {
  const minOffset = Math.min(...fields.map((f) => f.offset));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, number | string> = {};
  for (const f of fields) out[f.name] = decodeField(dv, f.offset - minOffset, f.type);
  return out;
}

/** Accepts "0x…" hex or plain decimal. */
function parseAddress(text: string): bigint {
  return BigInt(text.trim());
}

export const structReadCapability: Capability = {
  name: 'struct_read',
  config: {
    description:
      'Reads a struct out of the live game process and decodes its fields. Give a base address ' +
      '(decimal or 0x-hex) and a list of fields, each with a name, a byte offset, and a type ' +
      `(one of ${FIELD_TYPES.join(', ')} — all little-endian x64; ptr and u64 come back as 0x-hex ` +
      'strings to keep 64-bit precision, i64 as a decimal string, the rest as numbers). It reads the ' +
      'single covering span in one mem.read (chunked internally past 256 bytes) and returns ' +
      '{ address, fields: { name: value } }. This is the reverse-engineering aid for inspecting any ' +
      'object once you know its address and a partial layout; for a raw hexdump use console_run mem.read.',
    inputSchema: {
      address: z.string().min(1).describe('Base address of the struct: decimal, or 0x-prefixed hex.'),
      fields: z
        .array(
          z.object({
            name: z.string().min(1),
            offset: z.number().int().nonnegative(),
            type: z.enum(FIELD_TYPES),
          }),
        )
        .min(1)
        .describe('The fields to decode, each { name, offset, type }.'),
    },
  },
  async run(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CallToolResult> {
    try {
      const address = parseAddress(String(args.address));
      const fields = args.fields as StructField[];
      const minOffset = Math.min(...fields.map((f) => f.offset));
      const maxEnd = Math.max(...fields.map((f) => f.offset + SIZES[f.type]));
      const bytes = await ctx.mem.read(address + BigInt(minOffset), maxEnd - minOffset);
      const decoded = decodeStruct(bytes, fields);
      const text = JSON.stringify(
        { address: `0x${address.toString(16).toUpperCase().padStart(16, '0')}`, fields: decoded },
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
