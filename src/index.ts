#!/usr/bin/env node
/**
 * Sunrise MCP server: six tools over stdio, backed by the console endpoint client (endpoint.ts),
 * the Windows game/log helpers (game.ts), the title-screen key-press helpers (keys.ts), game_enter's
 * pure branch-selection logic (game-enter-decision.ts), destiny2.exe process lookup (tasklist.ts),
 * and its durable press record (press-record.ts). See README.md for the WSL-vs-Windows constraint —
 * this process must be run by Windows node.exe, not WSL node.
 */

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
import { decideGameEnterAction } from './game-enter-decision.js';
import { getGameProcessInfo } from './tasklist.js';
import { clearPressRecord, resolvePressedThisSession, writePressRecord, type PressRecord } from './press-record.js';

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

/** In-process first-line cache of the last successful press, alongside the durable file
 *  press-record.ts keeps. A plain assignment cannot fail the way a file write can, so this is what
 *  keeps a same-process retry safe even if writePressRecord's disk write silently fails (it never
 *  throws -- see its doc comment). Gated by the same pid+log-size freshness check as the file
 *  (resolvePressedThisSession applies it to both), so it can never resurrect a record for a game
 *  session it doesn't belong to just by existing; cleared alongside the file the moment the game is
 *  observed not running. */
let cachedPressRecord: PressRecord | null = null;

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
      'right after game_launch resolves does nothing), brings the game window to the foreground and confirms it ' +
      'got there, presses Enter as an OS-level SendInput keystroke (the one place in this whole project that is ' +
      'legitimate, because the title screen precedes every key hook the DLL installs, and this engine reads the ' +
      'keyboard below the window message queue so nothing posted at its window reaches it), then waits for the ' +
      'log line marking the world finishing loading. The response names the route the press actually took ' +
      '(sendInput, or the postMessage fallback used when the foreground could not be taken). Safe to call repeatedly ' +
      'against an already-running game -- including after this MCP server itself restarts -- e.g. as a ' +
      'precondition before other tools: if a world has already loaded, it reports ok without pressing anything; ' +
      'if Enter was already pressed for this exact game process and the world is still loading, it resumes ' +
      'waiting without pressing again rather than risking a second keystroke into whatever the game is currently ' +
      'showing; if it cannot tell whether the game has already been pressed (an ambiguous or undeterminable ' +
      'state), it declines to press at all. Leaves the game ' +
      'at the character-selection screen for now -- choosing a character is a separate tool not yet built. On ' +
      'failure, the response names which stage it stopped at (launch, titleScreen, keyPress, worldLoad, or ' +
      'ambiguous) so a caller knows what actually went wrong rather than just that something did.',
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
      const logPath = getLogPath();
      const proc = await getGameProcessInfo();
      // Invalidate both records: whatever either one recorded no longer applies.
      if (!proc.running) {
        cachedPressRecord = null;
        await clearPressRecord();
      }

      // See game-enter-decision.ts for the branch-selection logic itself and why each of these
      // observations is exactly what's needed (no more, no less) to decide what to do next.
      const worldMarkerPresent = proc.running ? await waitForLogMarker(WORLD_LOADED_MARKER, 0, logPath) : false;
      const titleMarkerPresent =
        proc.running && !worldMarkerPresent ? await waitForLogMarker(TITLE_SCREEN_MARKER, 0, logPath) : false;

      // Checks the in-process cache before ever touching the durable file (see press-record.ts's
      // resolvePressedThisSession and cachedPressRecord's doc comment above for why both exist: the
      // cache survives a failed disk write within this process, the file survives this process
      // restarting).
      let pressedThisSession = false;
      if (proc.running && proc.pid !== null) {
        const logSizeNow = await currentLogSize(logPath);
        pressedThisSession = await resolvePressedThisSession(cachedPressRecord, proc.pid, logSizeNow);
      }

      const decision = decideGameEnterAction({
        running: proc.running,
        pidKnown: proc.pid !== null,
        worldMarkerPresent,
        titleMarkerPresent,
        pressedThisSession,
      });

      let currentPid = proc.pid;
      // Whole-file offset (0) unless a fresh launch below anchors it instead: WORLD_LOADED_MARKER's
      // absence (already checked above, since decision !== 'shortCircuitOk'/'resumeWorldWait' here)
      // proves no full pass has completed in this log yet, so an existing TITLE_SCREEN_MARKER is
      // legitimate current evidence, not a stale leftover -- e.g. the game was started by a direct
      // game_launch call and is genuinely still sitting at the title screen, unpressed.
      let titleWaitOffset = 0;

      switch (decision.kind) {
        case 'decline':
          return fail('ambiguous', decision.reason);

        case 'shortCircuitOk':
          return textResult({
            status: 'ok',
            message: 'The game was already past the title screen with a world loaded; nothing to press.',
          });

        case 'resumeWorldWait': {
          // The cache or the durable record (or both) shows Enter was already pressed for this exact
          // pid -- pressing again would risk a second, spurious keystroke into whatever the game is
          // currently showing. Resume waiting for the world to finish loading instead; no fresh
          // offset needed here since WORLD_LOADED_MARKER was just proven absent above, so anything
          // that satisfies this wait from here on is unambiguously new.
          stage = 'worldLoad';
          const enteredWorld = await waitForLogMarker(WORLD_LOADED_MARKER, WORLD_LOAD_TIMEOUT_MS, logPath);
          if (!enteredWorld) {
            return fail(
              stage,
              `Timed out waiting for "${WORLD_LOADED_MARKER}" in sunrise.log (Enter was already pressed for this ` +
                'game process, so it was not pressed again).',
            );
          }
          return textResult({
            status: 'ok',
            message: 'The game reached the character-selection screen (Enter had already been pressed for this game process).',
          });
        }

        case 'launch': {
          const launch = await launchGame();
          if (launch.status !== 'launched') return fail(stage, launch.message);
          // launchGame()'s own PowerShell script normally reports the pid directly, but fall back to
          // asking tasklist (the same mechanism getGameProcessInfo() already uses) if it didn't, so a
          // rare parsing gap on the launch side doesn't quietly cost this the press record written
          // below -- that record is the only thing that later stops a retry from re-pressing.
          currentPid = launch.pid ?? (await getGameProcessInfo()).pid;
          // launchGame() kills any existing process and starts a new one, but reuses the same
          // sunrise.log path. If the engine doesn't truncate that file on a fresh start, whatever
          // the previous process already wrote (including a stale TITLE_SCREEN_MARKER or even
          // WORLD_LOADED_MARKER) is still sitting in it. Anchoring to the log's size right after
          // this launch means only a marker THIS new process actually writes can satisfy the wait
          // below.
          titleWaitOffset = await currentLogSize(logPath);
          break;
        }

        case 'proceed':
          break; // titleWaitOffset stays 0 -- see the comment above the switch.
      }

      stage = 'titleScreen';
      const sawTitleScreen = await waitForTitleScreen(undefined, logPath, titleWaitOffset);
      if (!sawTitleScreen) {
        return fail(stage, `Timed out waiting for "${TITLE_SCREEN_MARKER}" in sunrise.log. The game may still be booting.`);
      }

      stage = 'keyPress';
      // Anchor the world-load wait to right before the press: this is what proves the marker found
      // below was produced by THIS press, not a stale one already sitting in the log.
      const preKeyPressOffset = await currentLogSize(logPath);
      const press = await pressTitleScreenKey();
      if (press.status !== 'sent') return fail(stage, press.message);
      // Which route delivered the press is what a reader needs first when this next breaks, so it
      // travels with every outcome from here on -- the ok below and the worldLoad timeout alike.
      const pressRoute = press.route ?? 'unknown';
      // Record that we pressed for this pid, keyed to the log's size right now (before this press's
      // own effects land): the in-process cache first, unconditionally -- a plain assignment cannot
      // fail, so a same-process retry is safe even if the file write right after it does -- then the
      // durable file, best-effort, so a retry after this server restarts can recognize the same
      // still-running session too. If the pid still couldn't be determined even after the launch-path
      // fallback above, this degrades to a real (if narrow) residual risk rather than a fabricated
      // safe one: a later retry, if tasklist manages to determine the pid by then, would find no
      // matching record (in the cache or the file) and re-press. There is no way to close that
      // without a positive record to check against, which is exactly what's missing in this corner.
      if (currentPid !== null) {
        const record: PressRecord = { pid: currentPid, logSizeAtPress: preKeyPressOffset };
        cachedPressRecord = record;
        await writePressRecord(record);
      }

      stage = 'worldLoad';
      const enteredWorld = await waitForLogMarker(WORLD_LOADED_MARKER, WORLD_LOAD_TIMEOUT_MS, logPath, preKeyPressOffset);
      if (!enteredWorld) {
        // Naming the route, and the way out, matters more here than anywhere else in this tool: a
        // press the OS accepted but the game ignored looks identical to a slow load from here. The
        // press record now says this pid was pressed, so calling game_enter again will resume
        // waiting rather than press a second time (deliberately -- see the repeat-call finding in
        // README.md); game_kill first is what clears that record and allows a fresh attempt.
        return fail(
          stage,
          `Timed out waiting for "${WORLD_LOADED_MARKER}" in sunrise.log after pressing Enter via the ` +
            `${pressRoute} route. ${press.message} If the game is still sitting on the title screen, the ` +
            'keystroke was accepted by the OS but not by the game; call game_kill and then game_enter again, ' +
            'since a bare game_enter retry will resume waiting instead of pressing again.',
        );
      }

      return textResult({
        status: 'ok',
        route: pressRoute,
        message: 'The game reached the character-selection screen.',
      });
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
