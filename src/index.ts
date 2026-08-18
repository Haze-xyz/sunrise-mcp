#!/usr/bin/env node
/**
 * Sunrise MCP server: five tools over stdio, backed by the console endpoint client (endpoint.ts)
 * and the Windows game/log helpers (game.ts). See README.md for the WSL-vs-Windows constraint —
 * this process must be run by Windows node.exe, not WSL node.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { SunriseEndpointClient, type DescribeResponse, type RunResponse } from './endpoint.js';
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, getExePath, getLogPath, killGame, launchGame, readLog } from './game.js';

const endpoint = new SunriseEndpointClient();

// stdout is the MCP transport's wire; every diagnostic goes to stderr instead.
endpoint.on('protocolError', (err: Error) => {
  console.error(`[sunrise-mcp] endpoint protocol error: ${err.message}`);
});
endpoint.on('unmatchedResponse', (err: Error) => {
  console.error(`[sunrise-mcp] endpoint sent an unmatched (id: 0) response: ${err.message}`);
});

// game_kill tearing down the game is an expected cause of a connection error (typically
// ECONNRESET) — that is not worth surfacing as an error the model might reason about. Genuinely
// unexpected connection errors (the game crashing on its own, a network hiccup) still get logged
// normally; the distinction is the whole point, so this only ever suppresses the one error caused
// by a game_kill call this process itself just made, and only briefly.
let expectingDisconnectUntil = 0;
const EXPECT_DISCONNECT_WINDOW_MS = 5000;

function expectDisconnectBriefly(): void {
  expectingDisconnectUntil = Date.now() + EXPECT_DISCONNECT_WINDOW_MS;
}

endpoint.on('connectionError', (err: Error) => {
  if (Date.now() < expectingDisconnectUntil) {
    expectingDisconnectUntil = 0; // Consume it: only the next error is excused, not every one for the next 5s.
    return;
  }
  console.error(`[sunrise-mcp] endpoint connection error: ${err.message}`);
});

function textResult(payload: unknown): CallToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

const server = new McpServer({ name: 'sunrise-mcp', version: '0.1.0' });

server.registerTool(
  'console_run',
  {
    description:
      'Runs one line in the Sunrise in-game console over the loopback endpoint and returns the structured ' +
      'response: status (one of ok, unknownName, wrongArgumentCount, badArgument, outOfRange, refused, failed), ' +
      'a summary string, and rows of key/value pairs. The endpoint answers from the title screen, before the ' +
      'player presses anything, so this works before any load. Note: layer 1 has no key-input primitive, so the ' +
      'game currently stops at a "PRESS ENTER TO PLAY" title screen this tool cannot get past — every registry ' +
      'entry is console.*, log.*, movement.*, or player.infinite_ammo. Getting past the title screen is layer 2. ' +
      'One line only, at most ~493 bytes once wrapped as {"id":N,"line":"..."} in the 512-byte request envelope; ' +
      'longer lines are rejected locally before anything is sent.',
    inputSchema: {
      line: z.string().min(1).describe('A console line, e.g. "movement.fly_speed 55" or "movement.fly_speed".'),
    },
  },
  async ({ line }): Promise<CallToolResult> => {
    try {
      const response: RunResponse = await endpoint.runLine(line);
      return textResult(response);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  'console_describe',
  {
    description:
      'Returns the full Sunrise console registry: every command and variable, each with its name, kind, help ' +
      'text, and — for variables — type and numeric bounds. Call this to discover what console_run accepts ' +
      'before guessing at line syntax.',
  },
  async (): Promise<CallToolResult> => {
    try {
      const response: DescribeResponse = await endpoint.describe();
      return textResult(response);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  'game_launch',
  {
    description:
      `Starts destiny2.exe (from ${getExePath()}; override the game directory with the SUNRISE_GAME_DIR env ` +
      'var), killing any existing instance first, and waits for its window to appear before returning. The ' +
      'console endpoint answers as soon as this resolves, even at the title screen — no need to wait further.',
  },
  async (): Promise<CallToolResult> => {
    const result = await launchGame();
    return result.status === 'launched' ? textResult(result) : errorResult(new Error(result.message));
  },
);

server.registerTool(
  'game_kill',
  {
    description:
      'Force-terminates destiny2.exe via `taskkill /IM destiny2.exe /F`. Safe to call even if the game is not ' +
      'currently running.',
  },
  async (): Promise<CallToolResult> => {
    expectDisconnectBriefly();
    const result = await killGame();
    return result.status === 'failed' ? errorResult(new Error(result.message)) : textResult(result);
  },
);

server.registerTool(
  'log_read',
  {
    description:
      `Returns the tail of sunrise.log (from ${getLogPath()}) without ever loading the whole file into memory. ` +
      `Defaults to the last ${DEFAULT_LOG_LINES} lines; capped at ${MAX_LOG_LINES}. Throws a clear error if the ` +
      'log does not exist yet, which means the game has never been launched.',
    inputSchema: {
      lines: z
        .number()
        .int()
        .positive()
        .max(MAX_LOG_LINES)
        .optional()
        .describe(`Number of trailing lines to return (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES}).`),
    },
  },
  async ({ lines }): Promise<CallToolResult> => {
    try {
      const result = await readLog(lines);
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sunrise-mcp] connected over stdio.');
}

main().catch((err: unknown) => {
  console.error('[sunrise-mcp] fatal error during startup:', err);
  process.exitCode = 1;
});
