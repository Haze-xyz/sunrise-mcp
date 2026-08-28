/**
 * Everything `game_enter`'s optional `character` argument needs that is not I/O against the game:
 * naming a character, reading the console's two `character.*` answers, the two log markers that say
 * what the client did with a pick, and the one settings flag that decides whether it can act on it
 * at all.
 *
 * Split out of index.ts for the same reason game-enter-decision.ts was: all of this is decidable
 * from text, so it can be pinned by a test table (scripts/character-smoke.mjs) instead of only ever
 * being exercised by a real launch that takes a minute and needs a running game.
 *
 * ## Why the ordering these pieces serve is the tool's and not the caller's
 *
 * Measured on the live game on 2026-08-19, one launch, `client.hold_character_select` off:
 *
 * ```
 * wall t= 0.0s  launch
 * wall t=15.6s  character.select warlock  -> ok, index 2                (client t ~4.6s)
 * wall t=22.8s  "Entering state 'bootflow:start'"  (the title-screen marker, client t=12.1s)
 * wall t=24.7s  Enter pressed, SendInput
 *      client t=15.1s  "Entering state 'bootflow:bap_signin'"
 *      client t=31.7s  "Leaving state 'character:signin'"  -> the client left the pick screen
 * ```
 *
 * The pick has to be in State before the first Family-4 push, which is built during
 * `bootflow:bap_signin` — client t=15.1s in that run, i.e. **2.3 seconds after the title-screen
 * marker and 1 second after the key press**. So a caller told only "pick before sign-in" who did
 * the obvious thing (get to the title screen, then pick) would be racing a one-second window on
 * every launch. The pick therefore goes as early as the console endpoint will take it — measured
 * seven seconds before the title-screen marker in the same run — which is why `game_enter` polls
 * `character.list` for the endpoint to come up rather than reusing the title-screen wait it already
 * had. That ordering is the reason this argument belongs to `game_enter` at all instead of being a
 * `console_run` line an agent is told to send at the right moment.
 */

import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';

import type { RunRow } from './endpoint.js';
import { readSettings } from './install.js';

/** The classes this game authors, lowercase, exactly as `character.list` prints them. */
export const CHARACTER_CLASSES = ['titan', 'hunter', 'warlock'] as const;

export type CharacterClass = (typeof CHARACTER_CLASSES)[number];

/**
 * The line sunrise.log emits when the client leaves the character sign-in boot step.
 *
 * This is the one honest "a character actually entered" signal available from outside the process,
 * and it is not `WORLD_LOADED_MARKER`: measured, `successfully changed world to: orbit_d2` is
 * written at client t=27.9s, nearly four seconds *before* the client even enters `character:signin`
 * at t=31.4s, and it appears identically on a run that then parks on the character-select screen
 * forever. Leaving that step is what does not happen without a selection — the control run in
 * task-select-report.md posted the same UI substage 26 -> 30 -> 31 and then stopped there, while
 * the run with a pick crossed it in 334 ms and went on to `cleanup`.
 */
export const CHARACTER_ENTERED_MARKER = "Leaving state 'character:signin'";

/**
 * The line sunrise.log emits when the character-select hold hook attaches, which happens once per
 * boot and only when `client.hold_character_select` was true in settings.json at startup (see
 * `bootflow_hook_lifecycle.cpp`: the install is guarded by that flag, so nothing at all is logged
 * when it is off).
 *
 * Read as evidence about **the boot that is running now**, which is what makes it better than
 * re-reading settings.json: the file can have been changed since this process started, the flag
 * cannot. It is a prefix of the `result=ok reason=step_unpublished` variant, which means the same
 * thing (attached, registry entry not published), so a substring test covers both.
 */
export const HOLD_HOOK_MARKER = 'ev=bootflow stage=character_select result=ok';

/** The settings key this feature has to have off, under the `client` object. */
export const HOLD_SETTING_KEY = 'hold_character_select';

/**
 * What a successful hands-free entry did *not* give the caller, said in the response of every one of
 * them.
 *
 * Unconditional on the character path, and that is the point. The flag has to be off for a pick to
 * reach the client, so every `game_enter { character }` that returns ok entered by this route -- but
 * the file is only written once, so `settings` appears in the first response and never again, and
 * from the second call on the response read `status: ok`, `entered: warlock` and nothing else. An
 * agent reading that goes to a destination, gets a world that loads with no error and nobody in it,
 * and looks for the fault in the destination. The cost of the route belongs in the answer the route
 * returns, not in a file the caller has no reason to open.
 */
export const HANDS_FREE_ENTRY_WARNING =
  `This entry skipped the client's own character-select screen, which is what client.${HOLD_SETTING_KEY}` +
  ': false buys and what it costs. Measured 2026-08-19 and 2026-08-21: entering by this route leaves ' +
  'the client with no player object -- no ship in orbit, player.position present:false, keepalive ' +
  'spawn_state=0 -- and a destination launched from here loads correctly, with nobody in it: a black ' +
  'screen and no error anywhere. Everything that does not need a body still works (console.*, mem.*, ' +
  'the wire). For anything that does -- moving, seeing a destination, testing the world -- call ' +
  `game_kill, set client.${HOLD_SETTING_KEY} back to true, and make the pick on the real screen ` +
  '(game_enter with no character stops there, and input.hold drives it).';

/**
 * A `character` argument that named something. Split from the union below so every function that
 * only ever runs *after* the argument was accepted can say so in its signature, rather than
 * re-proving it or reaching for a token the invalid case does not have.
 */
export type ResolvedCharacterRequest =
  | { kind: 'class'; token: CharacterClass }
  | { kind: 'index'; token: string; index: number };

/** What a caller's `character` argument turned out to be. */
export type CharacterRequest = ResolvedCharacterRequest | { kind: 'invalid'; reason: string };

/**
 * Reads a caller's `character` argument.
 *
 * Rejected locally rather than being forwarded for the console to refuse, because the console only
 * exists once the game is up: forwarding `warlok` would spend a launch and a minute of boot before
 * anyone said the word was wrong. What cannot be decided locally — whether *this account* owns a
 * character of that class, and whether two of them share it — is deliberately left to
 * `character.select`, whose refusal already names the roster.
 *
 * A side effect worth stating, since it is what makes the accepted token safe to concatenate into a
 * console line: everything this returns as `class` or `index` is `[a-z]+` or one-or-two digits, so
 * it can carry no space, quote, brace or newline into the request envelope.
 *
 * @param raw The caller's argument, in whatever case and spacing it arrived.
 * @returns The class, the index, or a refusal carrying the sentence a caller should read.
 */
export function normalizeCharacterRequest(raw: string): CharacterRequest {
  const token = raw.trim().toLowerCase();
  if (token.length === 0) {
    return {
      kind: 'invalid',
      reason:
        'The character argument is empty. Name a class -- one of ' +
        `${CHARACTER_CLASSES.join(', ')} -- or an index into character.list. Omit the argument ` +
        'entirely to enter without choosing a character.',
    };
  }
  for (const known of CHARACTER_CLASSES) {
    if (token === known) return { kind: 'class', token: known };
  }
  if (/^[0-9]{1,2}$/.test(token)) {
    return { kind: 'index', token, index: Number(token) };
  }
  return {
    kind: 'invalid',
    reason:
      `"${raw}" is not a character class this game authors. The classes are ` +
      `${CHARACTER_CLASSES.join(', ')}. An index into character.list (0, 1, 2) is accepted in the ` +
      'same argument, which is what to use if the account owns two characters of one class. ' +
      'Nothing was launched and nothing was changed.',
  };
}

/** One character as `character.list` reports it. */
export interface RosterCharacter {
  index: number;
  soid: string;
  soidHex: string;
  characterClass: string;
  selected: boolean;
}

/** The whole `character.list` answer. */
export interface Roster {
  count: number;
  /** -1 when nothing is selected yet, exactly as the console reports it. */
  selectedIndex: number;
  characters: RosterCharacter[];
  /** The selected entry, or null when `selectedIndex` names none. */
  selected: RosterCharacter | null;
}

function findRow(rows: readonly RunRow[], key: string): unknown {
  for (const row of rows) {
    if (row.key === key) return row.value;
  }
  return undefined;
}

function numberRow(rows: readonly RunRow[], key: string): number | null {
  const value = findRow(rows, key);
  return typeof value === 'number' ? value : null;
}

function textRow(rows: readonly RunRow[], key: string): string | null {
  const value = findRow(rows, key);
  return typeof value === 'string' ? value : null;
}

function booleanRow(rows: readonly RunRow[], key: string): boolean | null {
  const value = findRow(rows, key);
  return typeof value === 'boolean' ? value : null;
}

/**
 * Reads a `character.list` answer.
 *
 * Returns null rather than a half-filled roster when the two header rows are not both numbers: the
 * caller uses this to decide whether the character it asked for is the one that entered, and a
 * roster invented out of a shape this does not recognize would answer that question with a guess.
 * The keys are the console module's own (`count`, `selected_index`, `soid_N`, `soid_N_hex`,
 * `class_N`, `selected_N`); a character whose four rows are not all present is dropped rather than
 * defaulted, so it can never silently read as "not selected".
 *
 * @param rows The `rows` array of the endpoint's response.
 * @returns The roster, or null when the answer is not one this understands.
 */
export function parseRoster(rows: readonly RunRow[]): Roster | null {
  const count = numberRow(rows, 'count');
  const selectedIndex = numberRow(rows, 'selected_index');
  if (count === null || selectedIndex === null) return null;

  const characters: RosterCharacter[] = [];
  for (let index = 0; index < count; index += 1) {
    const soid = textRow(rows, `soid_${index}`);
    const soidHex = textRow(rows, `soid_${index}_hex`);
    const characterClass = textRow(rows, `class_${index}`);
    const selected = booleanRow(rows, `selected_${index}`);
    if (soid === null || soidHex === null || characterClass === null || selected === null) continue;
    characters.push({ index, soid, soidHex, characterClass, selected });
  }

  const selected = characters.find((entry) => entry.index === selectedIndex) ?? null;
  return { count, selectedIndex, characters, selected };
}

/** The `character.select` answer, on the path where it moved (or confirmed) the selection. */
export interface SelectAnswer {
  index: number;
  soid: string;
  characterClass: string;
  /** False when that character was already the selected one. */
  changed: boolean;
  /** -1 when nothing was selected before this call. */
  previousIndex: number;
}

/**
 * Reads a successful `character.select` answer.
 *
 * @param rows The `rows` array of the endpoint's response.
 * @returns What was selected, or null when the answer does not carry the rows a pick reports (which
 *          is every refusal path -- those stop before the index and class rows are added).
 */
export function parseSelectAnswer(rows: readonly RunRow[]): SelectAnswer | null {
  const index = numberRow(rows, 'index');
  const soid = textRow(rows, 'soid');
  const characterClass = textRow(rows, 'class');
  const changed = booleanRow(rows, 'changed');
  if (index === null || soid === null || characterClass === null || changed === null) return null;
  return { index, soid, characterClass, changed, previousIndex: numberRow(rows, 'previous_index') ?? -1 };
}

/** One character named for a caller: `warlock (index 2)`. */
export function describeCharacter(entry: RosterCharacter): string {
  return `${entry.characterClass} (index ${entry.index})`;
}

/** The account's roster as one sentence, for a message that has to say what it could have picked. */
export function describeRoster(roster: Roster): string {
  if (roster.characters.length === 0) return 'this account owns no characters';
  return roster.characters.map(describeCharacter).join(', ');
}

/** What a rewrite of the hold flag found in, and did to, a settings file's text. */
export interface HoldSettingRewrite {
  /** How many times the key appears. A valid settings file has exactly one. */
  occurrences: number;
  /** The value the file carried, or null when the key is absent. */
  previous: boolean | null;
  /** The text to write back. Identical to the input unless `changed` is true. */
  text: string;
  changed: boolean;
}

/**
 * Turns `"hold_character_select": true` into `false` in a settings file's text, and nothing else.
 *
 * A single-token substitution rather than `JSON.parse`/`stringify` on purpose. The file is ~74 KB of
 * a user's own configuration, with its own key order, indentation and one-line objects; round-tripping
 * it through a parser would rewrite every byte of it to serve a one-word change, and would silently
 * drop anything the parser normalizes. This touches the six characters that have to change.
 *
 * Absence and duplication are reported rather than repaired, and the caller refuses on both. An
 * absent key means the C++ default applies (`holdCharacterSelect{true}` in
 * `core/settings/client/definition.h`), so the hold is on and a value has to be *added* — which
 * means synthesizing structure in a file this has no business restructuring. Two occurrences mean
 * the game's own parser already rejects the file (it refuses a duplicate key), so picking one to
 * edit would be guessing at which half of an already-broken file the game wanted.
 *
 * @param text The settings file exactly as read.
 * @returns What was found and the text to write back.
 */
export function rewriteHoldCharacterSelect(text: string): HoldSettingRewrite {
  const pattern = new RegExp(`"${HOLD_SETTING_KEY}"\\s*:\\s*(true|false)`, 'g');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    return { occurrences: matches.length, previous: null, text, changed: false };
  }
  const match = matches[0];
  if (match === undefined || match.index === undefined) {
    return { occurrences: 0, previous: null, text, changed: false };
  }
  const previous = match[1] === 'true';
  if (!previous) {
    return { occurrences: 1, previous: false, text, changed: false };
  }
  const rewritten =
    text.slice(0, match.index) + match[0].replace(/true$/, 'false') + text.slice(match.index + match[0].length);
  return { occurrences: 1, previous: true, text: rewritten, changed: true };
}

/** What `disableCharacterSelectHold` did, reported to the caller verbatim in every response. */
export interface HoldSettingResult {
  status: 'alreadyOff' | 'turnedOff' | 'refused';
  path: string;
  /** The value found in the file, when there was one to find. */
  previous?: boolean;
  /** Where the untouched original was copied before the first write this server ever made. */
  backupPath?: string;
  message: string;
}

/** Where the untouched original goes, once, the first time this server changes the file. */
export function holdSettingBackupPath(settingsPath: string): string {
  return `${settingsPath}.sunrise-mcp-backup`;
}

/**
 * Makes sure the game will *not* hold the character-select screen on its next boot, by turning
 * `client.hold_character_select` off in settings.json.
 *
 * **This writes a file the user owns, and that is a deliberate choice.** The flag is read once, at
 * boot, by a hook the console cannot reach, so it is a boot-time input to `game_enter` in exactly
 * the way the game directory is — and the caller this whole feature exists for is an agent holding
 * six MCP tools and no filesystem access, for whom "edit this JSON yourself and call me back" is not
 * an instruction that can be followed. Refusing would have made the feature unreachable by its own
 * audience, which is the defect it was built to remove.
 *
 * What makes the write acceptable is that it is neither silent nor lossy. The result names the file,
 * the key, the value found and the value written, and `game_enter` puts that object in every
 * response that caused a change. The whole original file is copied to
 * `settings.json.sunrise-mcp-backup` before the first write and never overwritten after, so the
 * pre-Sunrise-MCP state survives every later call. The edit itself is one token in ~74 KB. And it
 * happens only when a caller actually asked for a character and only when the flag is not already
 * off.
 *
 * It deliberately does **not** put the flag back afterwards. The value is read at boot, so restoring
 * it after the launch would mean every single call had to flip it again, and a crash between flip
 * and restore would leave it flipped anyway — a restore would buy a guarantee it cannot keep, at the
 * cost of making the reported state ("this is now off") false.
 *
 * @param settingsPath The game's settings.json.
 * @returns What was found and what was done. `refused` means nothing was written and the message
 *          says what a human has to change.
 */
export async function disableCharacterSelectHold(settingsPath: string): Promise<HoldSettingResult> {
  let text: string;
  try {
    text = await readFile(settingsPath, 'utf8');
  } catch (err) {
    return {
      status: 'refused',
      path: settingsPath,
      message:
        `Could not read the game's settings at ${settingsPath} ` +
        `(${err instanceof Error ? err.message : String(err)}). That file has to carry ` +
        `"${HOLD_SETTING_KEY}": false under "client" for a chosen character to reach the game, ` +
        'because the flag is read once at boot by a hook the console cannot reach. Nothing was ' +
        'launched.',
    };
  }

  const rewrite = rewriteHoldCharacterSelect(text);
  if (rewrite.occurrences === 0) {
    // Why the same missing key gets two different answers. `hold_character_select` is an addition of
    // the private fork, and so is `console_endpoint`; a settings file with neither was written by a
    // build that has no console endpoint at all, which makes "add this key by hand" advice that
    // cannot work -- the DLL that would read it is not there. Telling those two apart is the
    // difference between naming the cause and describing a symptom, and describing the symptom is
    // exactly what the first outside user of this server was handed.
    const looksLikeFork = readSettings(text).hasConsoleEndpoint;
    return {
      status: 'refused',
      path: settingsPath,
      message: looksLikeFork
        ? `${settingsPath} has no "${HOLD_SETTING_KEY}" key, and the game's own default for it is ` +
          'true, which parks the client on the character-select screen no matter what character is ' +
          `chosen. Add "${HOLD_SETTING_KEY}": false to the "client" object in that file and call ` +
          'game_enter again. This was not added automatically: the key is absent, so adding it means ' +
          'editing the shape of a configuration file rather than one value in it. Nothing was launched.'
        : `${settingsPath} carries neither "${HOLD_SETTING_KEY}" nor "console_endpoint". Both are ` +
          'additions of the private Sunrise fork this server pairs with, so this install was built ' +
          'from upstream Sunrise or another fork, and nothing this server drives exists in it -- ' +
          'there is no console endpoint to connect to, and adding the key by hand would change ' +
          'nothing because no code reads it. Deploy a steam_api64.dll built from the fork; ' +
          'install_check reports the same thing in full. Nothing was launched.',
    };
  }
  if (rewrite.occurrences > 1) {
    return {
      status: 'refused',
      path: settingsPath,
      message:
        `${settingsPath} carries "${HOLD_SETTING_KEY}" ${rewrite.occurrences} times. The game's own ` +
        'settings parser rejects a duplicated key, so that file is already not being read the way ' +
        'it looks; nothing was changed and nothing was launched. Leave exactly one, set to false.',
    };
  }
  if (!rewrite.changed) {
    return {
      status: 'alreadyOff',
      path: settingsPath,
      previous: false,
      message: `"${HOLD_SETTING_KEY}" was already false; the settings file was not touched.`,
    };
  }

  const backupPath = holdSettingBackupPath(settingsPath);
  try {
    // Written once and never again: the point of it is the state before this server ever touched
    // the file, which a backup refreshed on every call would destroy on the second one.
    let backupExists = true;
    try {
      await stat(backupPath);
    } catch {
      backupExists = false;
    }
    if (!backupExists) await copyFile(settingsPath, backupPath);

    // Temp-then-rename, like press-record.ts: the game reads this file at boot, and a crash
    // mid-write would otherwise leave it unparseable and the game unlaunchable.
    const tmpPath = `${settingsPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, rewrite.text, 'utf8');
    await rename(tmpPath, settingsPath);
  } catch (err) {
    return {
      status: 'refused',
      path: settingsPath,
      previous: true,
      message:
        `"${HOLD_SETTING_KEY}" is true in ${settingsPath} and could not be turned off ` +
        `(${err instanceof Error ? err.message : String(err)}). While it is true the client parks ` +
        'on the character-select screen whatever character is chosen. Set it to false by hand and ' +
        'call game_enter again. Nothing was launched.',
    };
  }

  return {
    status: 'turnedOff',
    path: settingsPath,
    previous: true,
    backupPath,
    message:
      `"${HOLD_SETTING_KEY}" was true in ${settingsPath} and this call set it to false, because a ` +
      'chosen character cannot reach the client while it is true. The value is read at boot, so it ' +
      `is left false rather than restored. The original file was copied to ${backupPath}.`,
  };
}

/**
 * The line sunrise.log emits when the client enters BAP sign-in — the deadline for a pick.
 *
 * `family4_snapshot_preparer` builds the first Family-4 image out of `account_snapshot()` during
 * this step, so a selection that is not in State by the time this line appears never reaches the
 * client. Measured 2026-08-19 it landed at client t=15.1s, **2.3 seconds after the title-screen
 * marker and about one second after the key press**, which is the whole reason the pick is made when
 * the console endpoint first answers rather than when the title screen appears.
 *
 * It is also the gate on making a pick at all. A pick after this point does not reach the client and
 * is not harmless: `character_console.cpp` records that every action the server prepares starts by
 * finding the selected character, so a late pick moves equip, unequip, dismantle, socket plugs, item
 * state and character-scoped acquisition at once, and one landing inside a client transaction makes
 * that commit fail while the console still answers ok. `game_enter` owning the ordering has to mean
 * refusing here, not assuming.
 */
export const SIGN_IN_MARKER = "Entering state 'bootflow:bap_signin'";

/**
 * ## Why the marker reads in this file are whole-file, and what that rests on
 *
 * `sunrise.log` holds exactly one boot. `open_log_file` in the DLL's `core/logging/log.cpp` does two
 * things before it returns a handle: `MoveFileExW(logPath -> logPath + ".old",
 * MOVEFILE_REPLACE_EXISTING)`, and then `CreateFileW(..., CREATE_ALWAYS, ...)`, which truncates even
 * if that rename failed. Either one alone would be enough; both run on every `log::initialize`,
 * which is once per DLL load. This is read out of the source, not assumed from the presence of a
 * `sunrise.log.old` on disk.
 *
 * The one thing it rests on is `core.logging.file_sink` being true. With the file sink off the DLL
 * writes no file at all, so whatever `sunrise.log` is on disk is a previous boot's and *every*
 * marker in `game_enter` — the title screen and world-load ones included, long before this feature —
 * reads a stale file. That is a whole-tool precondition, not something these three reads introduce.
 *
 * Where an anchor is available for free it is still used (the title-screen wait after a fresh launch
 * keeps its `sinceOffset`), because a redundant guard costs nothing. Where one is not — the hold-hook
 * line is written ~3.5s into a boot, which can be before `launchGame` returns — the whole-file read
 * is the correct one and the rotation above is what makes it sound. The `SIGN_IN_MARKER` gate needs
 * neither: it is only ever read *after* `character.list` has answered, and the endpoint cannot answer
 * until the running process's own DLL has initialized, which is after that process rotated the file.
 */

/**
 * Whether a `character.list` answer is the game saying "the pick can be made now".
 *
 * An empty roster this early in a boot is not an account that owns nobody, it is a roster that has
 * not been built yet: the characters are authored from settings during startup, and the console
 * endpoint binds well before that finishes (`console_endpoint stage=listen` is at t=125ms). Treating
 * the first answer that arrives as final -- which is what polling only on a thrown error amounts to
 * -- fails the whole call on a game that was merely a few hundred milliseconds early.
 *
 * @param roster The parsed roster, or null when the answer could not be read at all.
 * @returns True when the roster is loaded and a pick can be made against it.
 */
export function rosterIsReady(roster: Roster | null): boolean {
  return roster !== null && roster.count > 0;
}

/** What the roster poll knows each time round the loop. */
export interface RosterWaitObservation {
  /** Whether the game has answered `character.list` at all yet, ready or not. */
  everAnswered: boolean;
  /** Time since the first answer of any kind. Meaningless while `everAnswered` is false. */
  msSinceFirstAnswer: number;
  /** How long an answering-but-not-ready game is given before the poll stops believing in it. */
  graceMs: number;
  /** Whether the overall budget is spent. */
  deadlineExpired: boolean;
}

/**
 * Whether the roster poll should go round again.
 *
 * Two budgets, because the two states mean different things. **Nothing answering** is the ordinary
 * shape of a boot -- the endpoint is not bound yet -- and deserves the whole timeout. **Answering
 * but not ready** is nearly always permanent: `character.list` refuses outright for an account that
 * owns no characters, and an `unknownName` from a DLL that predates the character console never
 * becomes ready. Spending ninety seconds re-asking those is the same defect as the ninety-second
 * marker wait on an already-decided question, reached by a different path.
 *
 * It is a grace rather than an immediate stop because the window is real, if small: the endpoint
 * binds at t=125ms and the account is authored from settings at t=172ms, so about fifty
 * milliseconds exist in which a ready endpoint can hand back an empty roster.
 *
 * @param obs Where the poll has got to.
 * @returns True to poll again.
 */
export function shouldKeepPollingRoster(obs: RosterWaitObservation): boolean {
  if (obs.deadlineExpired) return false;
  if (!obs.everAnswered) return true;
  return obs.msSinceFirstAnswer < obs.graceMs;
}

/**
 * The sentence a roster poll ends on, which differs by *why* it ended.
 *
 * A game that never answered and a game that answered something useless are different problems with
 * different next steps, and the old single message appended "check log_read" to both -- advice aimed
 * at a DLL that failed to load, printed directly after a line quoting a console answer that DLL had
 * just given.
 *
 * @param everAnswered Whether any answer arrived.
 * @param lastReason The last answer or error seen.
 * @param timeoutMs The overall budget.
 * @param graceMs The answering-but-not-ready budget.
 * @returns The message.
 */
export function rosterWaitFailure(
  everAnswered: boolean,
  lastReason: string,
  timeoutMs: number,
  graceMs: number,
): string {
  if (!everAnswered) {
    return (
      `The game's console endpoint did not answer character.list within ${timeoutMs}ms, so no character ` +
      `could be chosen (last error: ${lastReason}). Nothing answered at all, so the game may have failed ` +
      'to load the Sunrise DLL; check log_read.'
    );
  }
  return (
    `The game answered character.list but never with a loaded roster, so no character could be chosen ` +
    `(last answer: ${lastReason}). It was re-asked for ${graceMs}ms after its first answer and did not ` +
    'change, and the two things that produce this do not change with time: an account that owns no ' +
    'characters, and a Sunrise DLL that predates the character console (which answers unknownName). The ' +
    'endpoint itself is up, so this is not a DLL that failed to load.'
  );
}

/** Which branch `decideGameEnterAction` chose, as the character step needs to see it. */
export type GameEnterEntry = 'launch' | 'proceed' | 'resumeWorldWait' | 'shortCircuitOk';

/** What game_enter knows when it is about to decide whether to make the pick. */
export interface CharacterStepObservation {
  entry: GameEnterEntry;
  /**
   * Whether `SIGN_IN_MARKER` is already in this boot's log. Only meaningful once the console
   * endpoint has answered, which is what proves the log belongs to the running process.
   */
  signInStarted: boolean;
}

/** What game_enter should do about the character it was given. */
export type CharacterStep =
  | { kind: 'pick' }
  | { kind: 'refuseLatePick'; reason: string }
  | { kind: 'verifyOnly' };

/**
 * Decides whether the pick can still be made on the game that is in front of us.
 *
 * The rule: **a pick is only issued when this call can positively justify that sign-in has not
 * started.** Absence of a press record is not that justification, and that gap was real — the
 * `proceed` branch is reached whenever the game is running, the world marker is absent, the pid is
 * known and *this server* has no record of pressing, which includes a game a human or another agent
 * pressed Enter on and which is already mid sign-in. Issuing `character.select` there repoints every
 * action the server resolves, for a client that will never see it. See `SIGN_IN_MARKER`.
 *
 * `launch` is not exempt. It is the one branch where a stale marker is conceivable (the pick is
 * issued after a poll that can run for a minute), and refusing on a marker that is genuinely there
 * is right in every case, so it goes through the same gate rather than being trusted.
 *
 * The two already-entered branches never pick: the question there is only who is in.
 *
 * @param obs What is known at the decision point.
 * @returns The step to take.
 */
export function decideCharacterStep(obs: CharacterStepObservation): CharacterStep {
  if (obs.entry === 'shortCircuitOk' || obs.entry === 'resumeWorldWait') {
    return { kind: 'verifyOnly' };
  }
  if (obs.signInStarted) {
    // The tail of this sentence is entry-specific, and that is not a nicety. Reaching here on the
    // launch branch means launchGame() has already run -- launch-game.ts's script does
    // `Get-Process destiny2 | Stop-Process -Force` and starts a new instance -- and, when the hold
    // flag had been on, settings.json has already been rewritten and a backup left beside it. The
    // response carries that settings object, so a blanket "nothing was changed" would contradict
    // its own payload in the same JSON.
    const aftermath =
      obs.entry === 'launch'
        ? 'This call pressed nothing and picked nothing. It had already restarted the game before it got ' +
          'here, though: the instance running now was started by this call, after it force-stopped any ' +
          'instance that was running before. If it also changed the game settings, the settings object ' +
          'beside this message says what it changed. This call did not dismiss the title screen, so ' +
          'something else advanced that new instance past it while this call was waiting for the console ' +
          'to answer. Call game_kill, then game_enter with the same character again.'
        : 'This call pressed nothing, picked nothing, and neither started nor stopped the game -- it found ' +
          'this instance already running and already being signed in. Call game_kill, then game_enter with ' +
          'the same character again.';
    return {
      kind: 'refuseLatePick',
      reason:
        `This game is already past the point where a character can be chosen: sunrise.log carries ` +
        `"${SIGN_IN_MARKER}", the step during which the first account image this client is sent gets built. ` +
        'No pick was ' +
        'made, deliberately -- a selection set now would never reach this client, and would still repoint ' +
        'every action the server resolves for it (equip, dismantle, socket plugs, character-scoped ' +
        'acquisition), and one landing inside a client transaction makes that commit fail while the ' +
        `console still answers ok. ${aftermath}`,
    };
  }
  return { kind: 'pick' };
}

/** Whether the roster's selected character is the one `request` named. */
export function rosterMatchesRequest(request: ResolvedCharacterRequest, roster: Roster): boolean {
  if (roster.selected === null) return false;
  return request.kind === 'class'
    ? roster.selected.characterClass === request.token
    : roster.selected.index === request.index;
}

/** The two roster reads and the log wait that a verdict is decided from. */
export interface CharacterVerdictObservation {
  request: ResolvedCharacterRequest;
  /**
   * Whether *this call* made the pick. Only then can the entered-marker be attributed to it, and
   * only then is the word "entered" defensible -- see `decideCharacterVerdict`.
   */
  pickedByThisCall: boolean;
  /** The roster read before the entered-marker wait, or null when it could not be read. */
  before: Roster | null;
  /** The roster read after it, or null when the wait failed or it could not be read. */
  after: Roster | null;
  /** Whether the entered-marker appeared within the wait. */
  entered: boolean;
  /** Why a roster is null, when one is. */
  unreadableReason?: string;
  /** How long the entered-marker was waited for, so the failure can name it. */
  waitedMs?: number;
}

/** A verdict, carrying the sentence a caller reads and the key its roster is reported under. */
export interface CharacterVerdict {
  ok: boolean;
  stage: 'characterVerify' | 'characterEnter';
  /** `entered` only where this call can defend the word; `selectedNow` everywhere else. */
  rosterKey: 'entered' | 'selectedNow';
  message: string;
  /** On the ok path, what the claim rests on. */
  verifiedBy?: string;
  /** On the ok path, why there is no claim to make. */
  unverified?: string;
}

/**
 * Decides what to say about which character is in, from two roster reads bracketing the log wait.
 *
 * **Why two reads.** One read plus "the marker is somewhere in the log" is not evidence about the
 * same moment, and the gap is reachable without anything exotic: `console_run "character.select
 * titan"` against a game already in orbit as the warlock, then `game_enter { character: "titan" }`,
 * and a single-read verdict answers ok with `entered: titan` and a verification string attached.
 * Reading the roster before the wait and again after it means the ok path can say the selection was
 * the requested one on both sides of the moment the client left the character step, and can name the
 * disagreement when it was not.
 *
 * **Why `pickedByThisCall` still gates the word "entered".** The bracket only correlates when the
 * marker lands *inside* it. On the two branches where the game was already in the world, the marker
 * is somewhere in the past and both reads happen after it, so the bracket collapses and proves
 * nothing about sign-in. Those answers report `selectedNow` and say plainly that the two
 * observations are not time-correlated, rather than dressing a guess as a measurement.
 *
 * @param obs The reads, the wait's outcome, and who made the pick.
 * @returns The verdict.
 */
export function decideCharacterVerdict(obs: CharacterVerdictObservation): CharacterVerdict {
  const who = obs.request.token;

  if (obs.before === null) {
    return {
      ok: false,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        `The world loaded, but which character entered could not be confirmed: ${obs.unreadableReason ?? 'the roster could not be read.'} ` +
        'If the game was just killed, this can also be a process that is still listed but whose console ' +
        'endpoint has already gone -- call game_enter again, which will then launch a fresh one. Otherwise ' +
        'run console_run "character.list" to see what the server selects.',
    };
  }

  if (obs.before.selectedIndex === -1) {
    return {
      ok: false,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        'No character is selected on the server, so the client has nothing to enter as and is sitting on ' +
        'the character-selection screen. The pick has to be in place before the game signs in, which is a ' +
        `point this launch is already past. Call game_kill, then game_enter with character "${who}" again ` +
        '-- that path makes the pick while the game is still booting.',
    };
  }

  if (!rosterMatchesRequest(obs.request, obs.before)) {
    const entered = obs.before.selected === null ? 'an unreported character' : obs.before.selected.characterClass;
    return {
      ok: false,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        `The server selects ${entered}, not the ${who} that was asked for, and a pick made now would not ` +
        'reach the client: it is read at sign-in, which this launch is past. Call game_kill, then ' +
        `game_enter with character "${who}" again.`,
    };
  }

  if (!obs.entered) {
    // The figure matters again now that two different waits are in use -- 90s after a press this
    // call made, 20s on a game that was already in the world -- so "never appeared" without it
    // leaves a caller unable to tell which wait it just spent.
    const waited = obs.waitedMs === undefined ? '' : ` within ${obs.waitedMs}ms`;
    return {
      ok: false,
      stage: 'characterEnter',
      rosterKey: 'selectedNow',
      message:
        `The ${who} is selected on the server, but "${CHARACTER_ENTERED_MARKER}" never appeared in ` +
        `sunrise.log${waited}, which means the client is still sitting on the character-selection screen rather ` +
        `than having walked through it. The usual cause is "${HOLD_SETTING_KEY}" having been true in the ` +
        "game's settings when this instance booted -- it is read once at startup. Call game_kill, then " +
        'game_enter with the same character again; that path turns the flag off before launching.',
    };
  }

  if (obs.after === null) {
    return {
      ok: false,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        `The client left the character step, but the roster could not be re-read afterwards to confirm the ` +
        `selection had not moved while it did: ${obs.unreadableReason ?? 'the roster could not be read.'} ` +
        'Nothing is claimed about which character is in; run console_run "character.list" to see what the ' +
        'server selects now.',
    };
  }

  if (obs.after.selectedIndex !== obs.before.selectedIndex || !rosterMatchesRequest(obs.request, obs.after)) {
    const now = obs.after.selected === null ? 'nobody' : obs.after.selected.characterClass;
    return {
      ok: false,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        `The selection moved while the client was entering the world: the ${who} was selected before, and ` +
        `the server selects ${now} now. Something other than this call is driving the server's console, so ` +
        'which character the client actually entered as cannot be established from here. Call game_kill, ' +
        `then game_enter with character "${who}" again with nothing else touching the game.`,
    };
  }

  if (!obs.pickedByThisCall) {
    return {
      ok: true,
      stage: 'characterVerify',
      rosterKey: 'selectedNow',
      message:
        `The game was already in the world and the server selects the ${who}. This call made no pick and ` +
        'cannot confirm the client entered as that character: the two facts it has are that the client left ' +
        'the character sign-in step at some earlier point in this boot, and that the roster reads this way ' +
        'now, and nothing ties those two moments together -- a selection changed after sign-in looks ' +
        'identical from here. Call game_kill, then game_enter with the same character, if you need that ' +
        'guaranteed.',
      unverified:
        'This call did not make the pick. The entered-marker is somewhere earlier in this boot and both ' +
        'roster reads happened after it, so nothing here is evidence about what the client signed in as.',
    };
  }

  return {
    ok: true,
    stage: 'characterVerify',
    rosterKey: 'entered',
    message: `The game entered the world as the ${who}.`,
    verifiedBy:
      `This call made the pick; sunrise.log then recorded "${CHARACTER_ENTERED_MARKER}" after the keystroke ` +
      'this call sent (the client only leaves that step once a character is chosen), and the server reported ' +
      'this character selected on two reads taken around that wait, the second of them after that line had ' +
      'been seen. The first read is only known to precede the wait, not the line itself, so the pair bounds ' +
      "the wait rather than the instant. The client's own character object was not re-read.",
  };
}
