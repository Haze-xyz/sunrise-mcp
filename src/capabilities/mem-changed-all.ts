// src/capabilities/mem-changed-all.ts
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Capability, CapabilityContext } from './contract.js';
import type { RunResponse } from '../endpoint.js';

/**
 * The console names seven addresses an answer, and this walks the rest for the caller.
 *
 * Seven is not a number anyone chose: a console `Result` carries `kRowCapacity` = 16 rows, a
 * page-level comparison spends nine of them on its counts, and seven is what is left. The console is
 * right to page rather than to cap -- naming the eight lowest and stopping would answer nothing,
 * because the eight lowest are the same eight every time. What is wrong is making the *caller* pay
 * a round trip per seven, and that is what this file exists to stop. The window width is never
 * assumed here: each answer's own length is what advances the index, so if the console ever spends
 * a row differently this keeps working.
 */

export interface ChangedWindow {
  mode: string;
  changed: number;
  listed: number;
  addresses: bigint[];
}

/** Reads one mem.changed reply: its counts, and the changed_N addresses in window order. */
export function parseChangedWindow(response: RunResponse): ChangedWindow {
  if (response.status !== 'ok') {
    const detail = response.summary || response.rows.map((r) => `${r.key}=${String(r.value)}`).join(', ');
    throw new Error(`mem.changed answered ${response.status}: ${detail}`);
  }
  const numbered = new Map<number, bigint>();
  let mode = '';
  let changed = 0;
  let listed = 0;
  for (const row of response.rows) {
    const key = String(row.key);
    // The suffix is a position in the window, so it is compared as a number: changed_10 must not
    // sort before changed_2, which is exactly what a lexicographic key order would do.
    const at = /^changed_(\d+)$/.exec(key);
    if (at) {
      numbered.set(Number(at[1]), BigInt(String(row.value)));
      continue;
    }
    if (key === 'mode') mode = String(row.value);
    else if (key === 'changed') changed = Number(row.value);
    else if (key === 'listed') listed = Number(row.value);
  }
  const addresses = [...numbered.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { mode, changed, listed, addresses };
}

/** An address fits a JS number exactly: user-space x64 is 47 bits, well under 2^53. */
function asNumber(address: bigint): number {
  if (address > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`address ${address.toString(10)} exceeds the exact integer range`);
  }
  return Number(address);
}

export const memChangedAllCapability: Capability = {
  name: 'mem_changed_all',
  config: {
    description:
      'Runs mem.changed and pages its whole list back in ONE call, instead of one console round ' +
      'trip per seven addresses. The console answers in 16 rows and a page-level comparison spends ' +
      'nine of them on counts, so mem.changed names seven addresses at a time and a caller pages ' +
      'with an index -- a list of 148 costs 21 calls by hand. This does that loop server-side and ' +
      'returns { mode, changed, listed, returned, stoppedEarly, addresses }, where changed is what ' +
      'the comparison found, listed is what it kept for paging, and returned is what came back here. ' +
      'Take the photograph with console_run mem.watch <address> first; this does not photograph, ' +
      'it compares. ' +
      'The list comes back sorted ascending, so pass maxAddress to stop paging once the list has ' +
      'passed the range you care about -- restricting a 27470-page region to the .data prefix is ' +
      'the difference between eight calls and twenty-one, and stoppedEarly says whether it did.',
    inputSchema: {
      maxAddress: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Stop paging once an address exceeds this (decimal, or 0x-hex). The list is sorted, so ' +
            'everything after it is out of range anyway.',
        ),
    },
  },
  async run(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CallToolResult> {
    try {
      const maxAddress =
        args.maxAddress === undefined ? undefined : BigInt(String(args.maxAddress).trim());
      const collected: bigint[] = [];
      let fetched = 0;
      let stoppedEarly = false;

      const first = parseChangedWindow(await ctx.console.runLine('mem.changed'));
      const { mode, changed, listed } = first;

      let window = first.addresses;
      for (;;) {
        fetched += window.length;
        for (const address of window) {
          if (maxAddress !== undefined && address > maxAddress) {
            stoppedEarly = true;
            break;
          }
          collected.push(address);
        }
        // An empty window would otherwise loop forever against a reply that names nothing.
        if (stoppedEarly || window.length === 0 || fetched >= listed) break;
        window = parseChangedWindow(await ctx.console.runLine(`mem.changed ${fetched}`)).addresses;
      }

      const text = JSON.stringify(
        { mode, changed, listed, returned: collected.length, stoppedEarly, addresses: collected.map(asNumber) },
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


