#!/usr/bin/env node
/**
 * Sunrise MCP server: six tools over stdio, backed by the console endpoint client (endpoint.ts),
 * the Windows game/log helpers (game.ts), and the title-screen key-press helpers (keys.ts). See
 * README.md for the WSL-vs-Windows constraint — this process must be run by Windows node.exe, not
 * WSL node.
 */

import { execFile } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { SunriseEndpointClient, type DescribeResponse, type RunResponse } from './endpoint.js';
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, getExePath, getLogPath, killGame, launchGame, readLog } from './game.js';
import {
  TITLE_SCREEN_MARKER,
  WORLD_LOADED_MARKER,
  currentLogSize,
  pressTitleScreenKey,
  waitForLogMarker,
  waitForTitleScreen,
} from './keys.js';

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

/** True once the world-load line lands in sunrise.log; not measured precisely, so this leaves a lot
 *  of headroom rather than pretending to a number that hasn't actually been timed. */
const WORLD_LOAD_TIMEOUT_MS = 120_000;

/** Checks for a running destiny2.exe via `tasklist`, so `game_enter` only launches when it needs to
 *  rather than unconditionally killing and restarting a game that may already be past the title
 *  screen (launchGame() itself always kills any existing instance first). */
function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq destiny2.exe', '/NH'], { windowsHide: true }, (error, stdout) => {
      resolve(!error && /destiny2\.exe/i.test(stdout));
    });
  });
}

const server = new McpServer({ name: 'sunrise-mcp', version: '0.1.0' });

server.registerTool(
  'console_run',
  {
    description:
      'Runs one line in the Sunrise in-game console over the loopback endpoint and returns the structured ' +
      'response: status (one of ok, unknownName, wrongArgumentCount, badArgument, outOfRange, refused, failed), ' +
      'a summary string, and rows of key/value pairs. The endpoint answers from the title screen, before the ' +
      'player presses anything, so this works before any load. Note: this tool has no key-input primitive of its ' +
      'own, so it cannot by itself get past a "PRESS ENTER TO PLAY" title screen or later loading screens -- use ' +
      'game_enter for that; console_run\'s own registry is console.*, log.*, movement.*, and player.infinite_ammo. ' +
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

server.registerTool(
  'game_enter',
  {
    description:
      'Gets the game from wherever it is (not running, sitting at the title screen, or already past it) to the ' +
      'character-selection screen: launches destiny2.exe if it is not already running, waits for sunrise.log\'s ' +
      `"${TITLE_SCREEN_MARKER}" line (the earliest reliable readiness signal -- game_launch itself returns ` +
      'roughly 40s before the title screen can actually accept input, so calling console_run or pressing a key ' +
      'right after game_launch resolves does nothing), presses Enter as an OS-level SendInput keystroke (the ' +
      'one place in this whole project that is legitimate, because the title screen precedes every key hook the ' +
      'DLL installs), then waits for the log line marking the world finishing loading. If the game is already ' +
      'running and has already loaded a world in this session, this is a safe no-op that reports ok without ' +
      'pressing anything again -- safe to call repeatedly, e.g. as a precondition before other tools. Leaves the ' +
      'game at the character-selection screen for now -- choosing a character is a separate tool not yet built. ' +
      'On failure, the response names which stage it stopped at (launch, titleScreen, keyPress, or worldLoad) so ' +
      'a caller knows what actually went wrong rather than just that something did.',
  },
  async (): Promise<CallToolResult> => {
    // Which stage failed is the whole point of this tool's error reporting (see its description),
    // so every failure -- expected (a stage's own bad outcome) or not (an exception thrown while
    // in it) -- goes through this one path, tagged with whichever stage was running at the time.
    // isError: true matches every other tool in this file that reports failure (game_launch,
    // game_kill, log_read), rather than leaving a caller to notice a 'failed' status buried in text.
    const fail = (stage: string, message: string): CallToolResult => ({
      content: [{ type: 'text', text: JSON.stringify({ stage, status: 'failed', message }, null, 2) }],
      isError: true,
    });

    let stage = 'launch';
    try {
      const running = await isGameRunning();
      // Whole-file offset (0): nothing could be stale yet on this path, since a fresh launch's own
      // wait is anchored below instead, and the not-yet-past-title-screen path (see the else branch)
      // hasn't completed a pass in this log at all.
      let titleWaitOffset = 0;

      if (!running) {
        const launch = await launchGame();
        if (launch.status !== 'launched') return fail(stage, launch.message);
        // launchGame() kills any existing process and starts a new one, but reuses the same
        // sunrise.log path. If the engine doesn't truncate that file on a fresh start, whatever the
        // previous process already wrote (including a stale TITLE_SCREEN_MARKER or even
        // WORLD_LOADED_MARKER) is still sitting in it. Anchoring to the log's size right after this
        // launch means only a marker THIS new process actually writes can satisfy the wait below.
        titleWaitOffset = await currentLogSize(getLogPath());
      } else {
        // The game was already running, so no launch (and no fresh-launch offset) happened above.
        // sunrise.log is append-only: once a marker is written it stays for the rest of that
        // process's life, so a whole-file check can't tell "just reached this state" from "reached
        // it once, a while ago, and hasn't moved since". WORLD_LOADED_MARKER only ever appears after
        // a press has already worked, so if it's anywhere in the log, a full pass already happened
        // in this session -- a repeat call must not press Enter again into whatever the game is
        // showing now (menu, character select, mid-gameplay) or claim a fresh 'ok' for work it
        // didn't do. waitForLogMarker(..., 0) with timeoutMs 0 is a single immediate check, not a
        // wait: the deadline is already now, so the loop below checks once and returns.
        const alreadyPastTitleScreen = await waitForLogMarker(WORLD_LOADED_MARKER, 0, getLogPath());
        if (alreadyPastTitleScreen) {
          return textResult({
            status: 'ok',
            message: 'The game was already past the title screen with a world loaded; nothing to press.',
          });
        }
        // Falls through with titleWaitOffset still 0 (whole-file): WORLD_LOADED_MARKER's absence
        // just proved no full pass has completed in this log yet, so an existing TITLE_SCREEN_MARKER
        // here is legitimate current evidence, not stale leftovers -- e.g. the game was started by a
        // direct game_launch call and is genuinely still sitting at the title screen, unpressed.
      }

      stage = 'titleScreen';
      const sawTitleScreen = await waitForTitleScreen(undefined, getLogPath(), titleWaitOffset);
      if (!sawTitleScreen) {
        return fail(stage, `Timed out waiting for "${TITLE_SCREEN_MARKER}" in sunrise.log. The game may still be booting.`);
      }

      stage = 'keyPress';
      // Anchor the world-load wait to right before the press: this is what proves the marker found
      // below was produced by THIS press, not a stale one already sitting in the log -- the same
      // finding this whole block guards against, applied to the second marker.
      const preKeyPressOffset = await currentLogSize(getLogPath());
      const press = await pressTitleScreenKey();
      if (press.status !== 'sent') return fail(stage, press.message);

      stage = 'worldLoad';
      const enteredWorld = await waitForLogMarker(WORLD_LOADED_MARKER, WORLD_LOAD_TIMEOUT_MS, getLogPath(), preKeyPressOffset);
      if (!enteredWorld) {
        return fail(stage, `Timed out waiting for "${WORLD_LOADED_MARKER}" in sunrise.log after pressing Enter.`);
      }

      return textResult({ status: 'ok', message: 'The game reached the character-selection screen.' });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return fail(stage, message);
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
