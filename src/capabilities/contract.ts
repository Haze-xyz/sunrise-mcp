// src/capabilities/contract.ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import type { RunResponse, DescribeResponse } from '../endpoint.js';
import type { LaunchResult, KillResult, LogReadResult } from '../game.js';
import type { GameProcessInfo } from '../tasklist.js';

/** The console transport a capability composes: exactly runLine + describe. */
export interface SunriseConsole {
  runLine(line: string): Promise<RunResponse>;
  describe(): Promise<DescribeResponse>;
}

/**
 * Typed façade over the mem.* console entries. Only the methods a capability
 * actually needs live here; more are added when a capability needs them.
 */
export interface MemFacade {
  /**
   * Reads `length` bytes starting at `address`. Chunks into <=256-byte
   * mem.read calls (probe::kMaxReadBytes) and reassembles. Rejects if the
   * range is unreadable, carrying the endpoint's failure summary.
   */
  read(address: bigint, length: number): Promise<Uint8Array>;
}

/** OS/process helpers, the same ones the base tools already use. */
export interface GameFacade {
  launch(): Promise<LaunchResult>;
  kill(): Promise<KillResult>;
  readLog(lines?: number): Promise<LogReadResult>;
  processInfo(): Promise<GameProcessInfo>;
  paths: { log(): string; exe(): string; settings(): string };
}

/** What every capability's run() receives. Primitives are injected, not imported. */
export interface CapabilityContext {
  console: SunriseConsole;
  mem: MemFacade;
  game: GameFacade;
  log(message: string): void;
}

/** One enfichable capability = one MCP tool. */
export interface Capability {
  /** The MCP tool name. */
  name: string;
  /** What registerTool expects: a rich description and an optional Zod input shape. */
  config: { description: string; inputSchema?: ZodRawShape };
  /** The implementation. Receives validated args and the injected context. */
  run(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CallToolResult>;
}
