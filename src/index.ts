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
import {
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  getExePath,
  getLogPath,
  getSettingsPath,
  killGame,
  launchGame,
  readLog,
} from './game.js';
import {
  CHARACTER_CLASSES,
  CHARACTER_ENTERED_MARKER,
  HOLD_HOOK_MARKER,
  HOLD_SETTING_KEY,
  describeRoster,
  disableCharacterSelectHold,
  normalizeCharacterRequest,
  parseRoster,
  parseSelectAnswer,
  type HoldSettingResult,
  type ResolvedCharacterRequest,
  type Roster,
  type SelectAnswer,
} from './character.js';
import {
  TITLE_SCREEN_MARKER,
  WORLD_LOADED_MARKER,
  currentLogSize,
  pressTitleScreenKey,
  waitForLogMarker,
  waitForTitleScreen,
  type PressResult,
} from './keys.js';
import { decideGameEnterAction } from './game-enter-decision.js';
import { getGameProcessInfo } from './tasklist.js';
import { clearPressRecord, resolvePressedThisSession, writePressRecord, type PressRecord } from './press-record.js';
import { createSerializer } from './serialize.js';
import { setTimeout as sleep } from 'node:timers/promises';

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

/**
 * What the title-screen press did to the window stack, folded into a `window` object for
 * `game_enter`'s response. Taking the foreground means minimizing the game window, which pushes
 * whatever the user was looking at behind it, and nothing puts it back -- so a caller that caused
 * that should be able to report it rather than have it end its life in a subprocess's stdout.
 * Returns `{}` when the script said nothing about it (e.g. the game was not running), so the field
 * is absent rather than present-and-empty.
 */
function pressWindowReport(press: PressResult): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  if (press.foregroundBefore !== undefined) window.foregroundBefore = press.foregroundBefore;
  if (press.minimized !== undefined) window.minimized = press.minimized;
  if (press.restoredIconicAtEntry !== undefined) window.restoredIconicAtEntry = press.restoredIconicAtEntry;
  return Object.keys(window).length > 0 ? { window } : {};
}

/** In-process first-line cache of the last successful press, alongside the durable file
 *  press-record.ts keeps. A plain assignment cannot fail the way a file write can, so this is what
 *  keeps a same-process retry safe even if writePressRecord's disk write silently fails (it never
 *  throws -- see its doc comment). Gated by the same pid+log-size freshness check as the file
 *  (resolvePressedThisSession applies it to both), so it can never resurrect a record for a game
 *  session it doesn't belong to just by existing; cleared alongside the file the moment the game is
 *  observed not running. */
let cachedPressRecord: PressRecord | null = null;

/** Runs game_enter calls one at a time. See serialize.ts for why the whole call, not the record. */
const serializeGameEnter = createSerializer();

// ---------------------------------------------------------------------------
// game_enter's optional `character` argument. See character.ts's header for the measurement that
// fixes the ordering below -- in particular why the pick goes in as early as the endpoint answers
// rather than at the title screen, which is only ~1s ahead of the deadline.
// ---------------------------------------------------------------------------

/** How long to keep asking the console endpoint for the roster after a launch. The endpoint
 *  answered 15s after launch in the 2026-08-19 run; this leaves room for a much slower boot before
 *  giving up, the same way LAUNCH_TIMEOUT_MS does over its own measured worst case. */
const CHARACTER_ENDPOINT_TIMEOUT_MS = 90_000;

/** Gap between roster attempts while the endpoint is not up yet. */
const CHARACTER_ENDPOINT_POLL_MS = 500;

/** How long to wait for CHARACTER_ENTERED_MARKER. Measured 4s after the world-load marker on the
 *  2026-08-19 run; a client that has not left the character step within this has parked on it, which
 *  is what the failure at this stage says. */
const CHARACTER_ENTER_TIMEOUT_MS = 90_000;

type RosterAttempt = { ok: true; roster: Roster } | { ok: false; message: string };

/** One `character.list` round trip, with every not-ok answer turned into a sentence a caller can act
 *  on. Throws only what `runLine` throws (i.e. the endpoint being unreachable), which is what the
 *  poll below retries. */
async function readRosterOnce(): Promise<RosterAttempt> {
  const response = await endpoint.runLine('character.list');
  if (response.status === 'unknownName') {
    return {
      ok: false,
      message:
        'The running game has no character.list console entry, so it cannot be told which character ' +
        'to play. The deployed Sunrise DLL predates the character console; deploy a build that ' +
        'publishes character.list and character.select, or call game_enter without a character.',
    };
  }
  if (response.status !== 'ok') {
    return { ok: false, message: `character.list answered ${response.status}: ${response.summary}` };
  }
  const roster = parseRoster(response.rows);
  if (roster === null) {
    return {
      ok: false,
      message:
        'character.list answered ok but without the count and selected_index rows this server reads, ' +
        `so the roster could not be understood: ${JSON.stringify(response.rows)}`,
    };
  }
  return { ok: true, roster };
}

/**
 * Polls `character.list` until the console endpoint answers it, which is also this tool's readiness
 * signal for "the pick can be made now". Deliberately not the title-screen marker: that arrives
 * about a second before the deadline for a pick (see character.ts), while the endpoint answers about
 * seven seconds before the marker itself.
 *
 * @param timeoutMs How long to keep trying.
 * @returns The roster, or the reason it could not be read.
 */
async function waitForRoster(timeoutMs: number): Promise<RosterAttempt> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'the endpoint was never reached';
  for (;;) {
    try {
      return await readRosterOnce();
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        message:
          `The game's console endpoint did not answer character.list within ${timeoutMs}ms, so no ` +
          `character could be chosen (last error: ${lastError}). The game may have failed to load ` +
          'the Sunrise DLL; check log_read.',
      };
    }
    await sleep(Math.min(CHARACTER_ENDPOINT_POLL_MS, Math.max(deadline - Date.now(), 0)));
  }
}

/** What the caller asked for and what the roster says about it, as the `character` object every
 *  response carrying this argument gets. */
function characterReport(
  request: ResolvedCharacterRequest,
  picked: SelectAnswer | null,
  roster: Roster | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requested: request.token,
    ...(picked !== null
      ? { selected: { index: picked.index, class: picked.characterClass, soid: picked.soid, changed: picked.changed } }
      : {}),
    ...(roster !== null
      ? {
          entered:
            roster.selected !== null
              ? { index: roster.selected.index, class: roster.selected.characterClass, soid: roster.selected.soid }
              : null,
          roster: describeRoster(roster),
        }
      : {}),
    ...extra,
  };
}

/** Whether the roster's selected character is the one `request` named. */
function rosterMatchesRequest(request: ResolvedCharacterRequest, roster: Roster): boolean {
  if (roster.selected === null) return false;
  return request.kind === 'class'
    ? roster.selected.characterClass === request.token
    : roster.selected.index === request.index;
}

type CharacterVerdict =
  | { ok: true; character: Record<string, unknown> }
  | { ok: false; stage: string; message: string; character: Record<string, unknown> };

/**
 * Answers "did the character the caller asked for actually enter the world?" from the two things
 * this server can honestly observe: the client leaving the character sign-in boot step (a step it
 * does not leave without a selection -- see CHARACTER_ENTERED_MARKER), and the roster the server
 * itself holds while that happened.
 *
 * The order is cheap-and-decisive first. A roster that never had a selection, or has the wrong one,
 * settles the question immediately and without waiting; only a roster that agrees is worth spending
 * the log wait on. That is what keeps a call against a game already parked on the select screen from
 * burning CHARACTER_ENTER_TIMEOUT_MS to reach a conclusion the roster already gave.
 *
 * **What this does not prove.** It reads the *server's* selection, not the client's own character
 * object; the two were shown to agree on all three classes by opening the character sheet in the
 * runs recorded in task-select-report.md, but nothing here re-reads that sheet. The claim it makes
 * is exactly: the client left the character step, and the character State selected at that point was
 * the one asked for.
 *
 * @param request What the caller named.
 * @param picked What character.select answered, when this call made the pick.
 * @param logPath sunrise.log.
 * @param sinceOffset Byte offset the entered-marker must appear at or after.
 * @param timeoutMs How long to wait for that marker.
 * @returns The verdict, always carrying the character report so a caller sees requested vs entered
 *          on every path.
 */
async function verifyCharacterEntered(
  request: ResolvedCharacterRequest,
  picked: SelectAnswer | null,
  logPath: string,
  sinceOffset: number,
  timeoutMs: number,
): Promise<CharacterVerdict> {
  const attempt = await waitForRoster(CHARACTER_ENDPOINT_POLL_MS * 4);
  if (!attempt.ok) {
    return {
      ok: false,
      stage: 'characterVerify',
      message:
        `The world loaded, but which character entered could not be confirmed: ${attempt.message} If the game ` +
        'was just killed, this can also be a process that is still listed but whose console endpoint has already ' +
        'gone -- call game_enter again, which will then launch a fresh one. Otherwise run console_run ' +
        '"character.list" to see what the server selects.',
      character: characterReport(request, picked, null),
    };
  }
  const roster = attempt.roster;

  if (roster.selectedIndex === -1) {
    return {
      ok: false,
      stage: 'characterVerify',
      message:
        'No character is selected on the server, so the client has nothing to enter as and is ' +
        'sitting on the character-selection screen. The pick has to be in place before the game ' +
        'signs in, which is a point this launch is already past. Call game_kill, then game_enter ' +
        `with character "${request.token}" again -- that path makes the pick while the game is ` +
        'still booting.',
      character: characterReport(request, picked, roster),
    };
  }
  if (!rosterMatchesRequest(request, roster)) {
    const entered = roster.selected === null ? 'an unreported character' : roster.selected.characterClass;
    return {
      ok: false,
      stage: 'characterVerify',
      message:
        `The server selects ${entered}, not the ${request.token} that was asked for, and a pick made ` +
        'now would not reach the client: it is read at sign-in, which this launch is past. Call ' +
        `game_kill, then game_enter with character "${request.token}" again.`,
      character: characterReport(request, picked, roster),
    };
  }

  const entered = await waitForLogMarker(CHARACTER_ENTERED_MARKER, timeoutMs, logPath, sinceOffset);
  if (!entered) {
    return {
      ok: false,
      stage: 'characterEnter',
      message:
        `The ${request.token} is selected on the server, but "${CHARACTER_ENTERED_MARKER}" never ` +
        `appeared in sunrise.log within ${timeoutMs}ms, which means the client is still sitting on ` +
        'the character-selection screen rather than having walked through it. The usual cause is ' +
        `"${HOLD_SETTING_KEY}" having been true in the game's settings when this instance booted -- ` +
        'it is read once at startup. Call game_kill, then game_enter with the same character again; ' +
        'that path turns the flag off before launching.',
      character: characterReport(request, picked, roster),
    };
  }

  return {
    ok: true,
    character: characterReport(request, picked, roster, {
      verifiedBy:
        `sunrise.log carries "${CHARACTER_ENTERED_MARKER}" (the client only leaves that step once a ` +
        'character is chosen) and the server reports this character selected. The client\'s own ' +
        'character object was not re-read.',
    }),
  };
}

const server = new McpServer({ name: 'sunrise-mcp', version: '0.1.0' });

server.registerTool(
  'console_run',
  {
    description:
      'Runs one line in the Sunrise in-game console over the loopback endpoint and returns the structured ' +
      'response: status (one of ok, unknownName, wrongArgumentCount, badArgument, outOfRange, refused, failed), ' +
      'a summary string, and rows of key/value pairs. The endpoint answers from the title screen, before the ' +
      'player presses anything, so this works before any load. The registry is console.*, log.*, movement.*, ' +
      'player.infinite_ammo, character.*, and -- for driving and reverse-engineering the game from here -- input.*, ' +
      'mem.* and bootflow.character_step. Call console_describe for the authoritative list with help and bounds -- ' +
      'but note it publishes each entry\'s name, kind, help and (for variables) type, bounds and choices, and NOT ' +
      'the arguments a command takes, so what follows is both what an agent needs before deciding what to try and, ' +
      'for these entries, the argument syntax describe does not carry. character.list takes no argument and reports ' +
      'the account\'s characters with their class, key and which one is selected; character.select ' +
      '<titan|hunter|warlock, or an index into character.list> moves the server\'s selection. Do not choose a ' +
      'character from here unless you mean to: character.select answers ok whenever it is called, but only reaches ' +
      'the game when it is called before the game signs in, and owning that ordering is exactly what game_enter\'s ' +
      'character argument is for -- to start the game as a character, call game_enter { character: "warlock" }. ' +
      'input.hold <vk> / input.release <vk> / ' +
      'input.release_all report Windows virtual keys held to the game through the DLL\'s GetKeyState hook, several ' +
      'at once, and stay held until released -- that is how you drive movement and abilities. input.hold reports ' +
      'refused, changing nothing, while the key hook is not yet attached or a Sunrise in-game surface has the ' +
      'keyboard, since the game is told every key is released in both states and the hold would only fire later; ' +
      'the summary and a field_live row say which. The two releases always act and report ok in every state, so ' +
      'input.release_all is the way out of a key left held. None of them gets past the title screen: measured ' +
      '2026-08-18, the hook IS attached there and input.hold answers ok, but the title screen does not read it -- ' +
      'use game_enter for that. mem.module / mem.read / mem.scan / ' +
      'mem.scan_data / mem.resolve / mem.write read and search the live game process: signature scans over the ' +
      'main image (mem.scan for code, mem.scan_data for static data -- neither sweeps the heap), hexdump reads of ' +
      'any committed readable address including the heap, RIP-relative displacement decoding, and bounded writes. ' +
      'mem.write refuses code and any image section the PE marks read-only, but that gate describes the game\'s ' +
      'IMAGE, not its heap: a heap address that is committed, writable and non-executable is accepted, so a bad ' +
      'address there corrupts live game state rather than being refused. Every write is logged. ' +
      'bootflow.character_step reads the character sign-in boot step\'s heap address, which is otherwise ' +
      'unreachable -- feed it to mem.read. It does not exist as an entry (unknownName) until that hook attaches. ' +
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
      'before guessing at line syntax. One limit to know rather than discover the hard way: the endpoint does ' +
      'not publish the arguments a command declares, only its help text, so this says which commands exist and ' +
      'not what each one takes. Where an argument matters, console_run\'s own description carries the syntax.',
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
      'Starts the game and gets it into the world, optionally as a named character: "start the game and play the ' +
      'warlock" is game_enter { character: "warlock" } and nothing else. Works from any starting point -- not ' +
      'running, sitting at the title screen, or already past it. Without a character it stops at the ' +
      'character-selection screen, which is where the game parks with nobody chosen. With one it enters the world ' +
      'as that character, and this tool owns the ordering that makes that work, which a caller driving console_run ' +
      'by hand would get wrong: the choice has to be in place before the game signs in, and that deadline was ' +
      'measured at about one second after the title screen appears, so the pick goes in as soon as the game\'s ' +
      'console endpoint answers (about seven seconds earlier) rather than at the title screen. The steps: ' +
      'launches destiny2.exe if it is not already running, waits for sunrise.log\'s ' +
      `"${TITLE_SCREEN_MARKER}" line (the earliest reliable readiness signal -- game_launch itself returns ` +
      'roughly 40s before the title screen can actually accept input, so calling console_run or pressing a key ' +
      'right after game_launch resolves does nothing), brings the game window to the foreground and confirms it ' +
      'got there, presses Enter as an OS-level SendInput keystroke (the one place in this whole project that is ' +
      'legitimate: measured 2026-08-18, the DLL\'s key hook IS attached at the title screen -- console_run ' +
      '"input.hold 13" answers ok there -- but the title screen does not read it, and five taps plus a ' +
      'five-second hold moved nothing while SendInput moved it at once on the same launch; this engine also ' +
      'reads the keyboard below the window message queue, so nothing posted at its window reaches it either), ' +
      'then waits for the log line marking the world finishing loading. Calls are serialized: two at once cannot ' +
      'both decide to press. The response names the route the press actually took: ' +
      'sendInput on success, or postMessage -- which is reported as a failure at stage keyPress, since that fallback ' +
      'reaches the window but cannot move an engine that polls GetKeyState. The response also carries a window ' +
      'object saying what the press did to the window stack -- which window it displaced, whether it minimized the ' +
      'game to take the foreground, and whether it had to un-minimize a game left stranded by an earlier run -- ' +
      'since the displaced window is never put back. Safe to call repeatedly ' +
      'against an already-running game -- including after this MCP server itself restarts -- e.g. as a ' +
      'precondition before other tools: if a world has already loaded, it reports ok without pressing anything; ' +
      'if Enter was already pressed for this exact game process and the world is still loading, it resumes ' +
      'waiting without pressing again rather than risking a second keystroke into whatever the game is currently ' +
      'showing; if it cannot tell whether the game has already been pressed (an ambiguous or undeterminable ' +
      'state), it declines to press at all. ' +
      'With a character named, three more things happen and all three are reported. Before launching, it makes ' +
      `sure the game's own settings file has client.${HOLD_SETTING_KEY} set to false, because while that is true ` +
      'the client parks on the selection screen whatever character is chosen, and the flag is read once at boot by ' +
      'code the console cannot reach; if it has to change the value it says so in a settings object naming the ' +
      'file, the old value and a backup of the original, and if it cannot (the key is missing, or the file is not ' +
      'writable) it refuses without launching and says what to edit. After the world loads it confirms which ' +
      'character actually entered rather than only that something did, and reports requested and entered side by ' +
      'side in a character object: the evidence is sunrise.log recording that the client left the character ' +
      'sign-in step, which it does not do without a selection, plus the server reporting that character selected ' +
      '-- the client\'s own character object is not re-read. And a pick that would land too late is refused ' +
      'rather than reported as success: called against a game that is already past sign-in, it tells you which ' +
      'character that game actually entered as and, if it is the wrong one, that game_kill followed by this same ' +
      'call is the way to change it. On ' +
      'failure, the response names which stage it stopped at (launch, titleScreen, keyPress, worldLoad, ambiguous, ' +
      'or -- only when a character was asked for -- character for a name that is not a class, characterHold for the ' +
      'settings flag, characterSelect for a pick the game refused, characterEnter for a client that stayed on the ' +
      'selection screen, characterVerify for a different character than the one asked for) so a caller knows what ' +
      'actually went wrong rather than just that something did.',
    inputSchema: {
      character: z
        .string()
        .optional()
        .describe(
          'Optional. Which character to enter the world as: ' +
            CHARACTER_CLASSES.map((name) => `"${name}"`).join(', ') +
            ' (case does not matter). An index into the console\'s character.list ("0", "1", "2") is accepted in ' +
            'the same argument, and is what to use if the account owns two characters of one class, since the ' +
            'class name then picks nobody. Omit this to enter without choosing, which leaves the game sitting on ' +
            'the character-selection screen.',
        ),
    },
  },
  // Serialized end to end: two overlapping calls would both observe "not pressed yet" before
  // either wrote the press record, and both would fire SendInput. See serialize.ts.
  async ({ character }): Promise<CallToolResult> => serializeGameEnter(async (): Promise<CallToolResult> => {
    // Which stage failed is the whole point of this tool's error reporting (see its description),
    // so every failure -- expected (a stage's own bad outcome) or not (an exception thrown while
    // in it) -- goes through this one path, tagged with whichever stage was running at the time.
    // isError: true matches every other tool in this file that reports failure (game_launch,
    // game_kill, log_read), rather than leaving a caller to notice a 'failed' status buried in text.
    const fail = (stage: string, message: string, extra?: Record<string, unknown>): CallToolResult => ({
      content: [{ type: 'text', text: JSON.stringify({ stage, status: 'failed', ...(extra ?? {}), message }, null, 2) }],
      isError: true,
    });

    // Decided before anything is observed, launched, written or pressed: a word that is not a class
    // costs nothing to refuse here and would otherwise cost a launch and a minute of boot before the
    // console said the same thing. `request` stays null for the no-character call, and every
    // character-specific step below is gated on it, so that call's behaviour is untouched.
    let request: ResolvedCharacterRequest | null = null;
    if (character !== undefined) {
      const normalized = normalizeCharacterRequest(character);
      if (normalized.kind === 'invalid') return fail('character', normalized.reason);
      request = normalized;
    }
    let holdSetting: HoldSettingResult | null = null;
    let picked: SelectAnswer | null = null;
    const settingsReport = (): Record<string, unknown> =>
      holdSetting !== null && holdSetting.status !== 'alreadyOff' ? { settings: holdSetting } : {};

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

        case 'shortCircuitOk': {
          if (request === null) {
            return textResult({
              status: 'ok',
              message: 'The game was already past the title screen with a world loaded; nothing to press.',
            });
          }
          // A world has already loaded, so the pick this call would make could not reach the client
          // -- it is read at sign-in, which is behind us. The honest answer is not "ok, nothing to
          // press" but "here is who is actually in, and whether it is who you asked for". Whole-file
          // offset: the log is this boot's (the engine rotates it to sunrise.log.old on start), and
          // there is no press in this call to attribute a marker to.
          stage = 'characterVerify';
          const verdict = await verifyCharacterEntered(request, null, logPath, 0, CHARACTER_ENTER_TIMEOUT_MS);
          if (!verdict.ok) return fail(verdict.stage, verdict.message, { character: verdict.character });
          return textResult({
            status: 'ok',
            character: verdict.character,
            message:
              `The game was already in the world as the ${request.token}; nothing was pressed and no pick was made.`,
          });
        }

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
          if (request !== null) {
            // Enter was already pressed for this pid, so sign-in has happened or is happening and a
            // pick made now is too late. Report who actually got in rather than claiming success.
            stage = 'characterVerify';
            const verdict = await verifyCharacterEntered(request, null, logPath, 0, CHARACTER_ENTER_TIMEOUT_MS);
            if (!verdict.ok) return fail(verdict.stage, verdict.message, { character: verdict.character });
            return textResult({
              status: 'ok',
              character: verdict.character,
              message:
                `The game entered the world as the ${request.token} (Enter had already been pressed for this game ` +
                'process, so nothing was pressed and no pick was made by this call).',
            });
          }
          return textResult({
            status: 'ok',
            message: 'The game reached the character-selection screen (Enter had already been pressed for this game process).',
          });
        }

        case 'launch': {
          if (request !== null) {
            // Before the launch, because the flag is read once at boot: after it, this call could
            // only report a value the running client already ignored. See character.ts for why this
            // writes a file the user owns instead of refusing with an instruction.
            stage = 'characterHold';
            holdSetting = await disableCharacterSelectHold(getSettingsPath());
            if (holdSetting.status === 'refused') {
              return fail(stage, holdSetting.message, { settings: holdSetting });
            }
            stage = 'launch';
          }
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

      // The pick goes here -- before the title-screen wait, not after it. Measured 2026-08-19 on one
      // launch: the endpoint answered character.list at wall t=15.6s, the title-screen marker landed
      // at t=22.8s, and the deadline for a pick (the client entering bootflow:bap_signin, where the
      // first Family-4 push is built out of the account snapshot) was about a second past the press.
      // Picking at the title screen would therefore be a race this tool would lose on a fast boot;
      // picking when the endpoint first answers has seven seconds of margin. See character.ts.
      if (request !== null) {
        stage = 'characterSelect';
        const rosterBefore = await waitForRoster(CHARACTER_ENDPOINT_TIMEOUT_MS);
        if (!rosterBefore.ok) return fail(stage, rosterBefore.message, settingsReport());
        const response = await endpoint.runLine(`character.select ${request.token}`);
        if (response.status !== 'ok') {
          return fail(
            stage,
            `character.select ${request.token} answered ${response.status}: ${response.summary} This account has ` +
              `${describeRoster(rosterBefore.roster)}. Nothing was pressed, so a corrected call can still make the ` +
              'pick on this same launch.',
            { character: characterReport(request, null, rosterBefore.roster), ...settingsReport() },
          );
        }
        picked = parseSelectAnswer(response.rows);
        if (picked === null) {
          return fail(
            stage,
            `character.select ${request.token} answered ok but without the index and class rows this server reads, ` +
              `so what it selected cannot be confirmed: ${response.summary}`,
            { character: characterReport(request, null, rosterBefore.roster), ...settingsReport() },
          );
        }
      }

      stage = 'titleScreen';
      const sawTitleScreen = await waitForTitleScreen(undefined, logPath, titleWaitOffset);
      if (!sawTitleScreen) {
        return fail(
          stage,
          `Timed out waiting for "${TITLE_SCREEN_MARKER}" in sunrise.log. The game may still be booting.`,
          settingsReport(),
        );
      }

      // Checked here rather than at the settings file, and only now: the hook logs this line when it
      // attaches, roughly 3.5s into a boot, so by the time the title-screen marker is in the log the
      // answer is settled -- and it is an observation of the boot that is actually running, which
      // re-reading settings.json is not (that file can have changed since this instance started).
      // Whole-file, because the engine rotates sunrise.log to sunrise.log.old on start, so the file
      // holds this boot and no other.
      if (request !== null) {
        const holdAttached = await waitForLogMarker(HOLD_HOOK_MARKER, 0, logPath);
        if (holdAttached) {
          stage = 'characterHold';
          return fail(
            stage,
            `This instance of the game booted with client.${HOLD_SETTING_KEY} on -- sunrise.log carries ` +
              `"${HOLD_HOOK_MARKER}", the line the hold hook writes when it attaches -- so the client will park on ` +
              `the character-selection screen whatever character is chosen. The flag is read once at boot, so it ` +
              'cannot be changed for this instance. Call game_kill, then game_enter with the same character again; ' +
              'that path turns the flag off before launching. Enter was not pressed.',
            { character: characterReport(request, picked, null), ...settingsReport() },
          );
        }
      }

      stage = 'keyPress';
      // Anchor the world-load wait to right before the press: this is what proves the marker found
      // below was produced by THIS press, not a stale one already sitting in the log.
      const preKeyPressOffset = await currentLogSize(logPath);
      const press = await pressTitleScreenKey();
      // Unchanged gate: 'sent' still means a keystroke was actually delivered, which is exactly what
      // the press record below is allowed to be written for. The PostMessage fallback reports
      // 'failed' precisely so it cannot reach that record -- see interpretPressKeyOutput in keys.ts.
      if (press.status !== 'sent') {
        return fail(stage, press.message, {
          ...(press.route !== undefined ? { route: press.route } : {}),
          ...pressWindowReport(press),
          ...(request !== null ? { character: characterReport(request, picked, null) } : {}),
          ...settingsReport(),
        });
      }
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
          {
            route: pressRoute,
            ...pressWindowReport(press),
            ...(request !== null ? { character: characterReport(request, picked, null) } : {}),
            ...settingsReport(),
          },
        );
      }

      if (request !== null) {
        // The world-load marker is written before the client even enters the character step (orbit
        // at client t=27.9s, character:signin entered at t=31.4s on the 2026-08-19 run), and it
        // appears identically on a run that then parks on the selection screen -- so on its own it
        // says nothing about who got in. Anchored to the same pre-press offset as the world wait.
        stage = 'characterVerify';
        const verdict = await verifyCharacterEntered(
          request,
          picked,
          logPath,
          preKeyPressOffset,
          CHARACTER_ENTER_TIMEOUT_MS,
        );
        if (!verdict.ok) {
          return fail(verdict.stage, verdict.message, {
            route: pressRoute,
            ...pressWindowReport(press),
            character: verdict.character,
            ...settingsReport(),
          });
        }
        return textResult({
          status: 'ok',
          route: pressRoute,
          ...pressWindowReport(press),
          character: verdict.character,
          ...settingsReport(),
          message: `The game entered the world as the ${request.token}.`,
        });
      }

      return textResult({
        status: 'ok',
        route: pressRoute,
        ...pressWindowReport(press),
        message: 'The game reached the character-selection screen.',
      });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return fail(stage, message, settingsReport());
    }
  }),
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
