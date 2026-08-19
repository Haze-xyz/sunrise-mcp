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
    return {
      status: 'refused',
      path: settingsPath,
      message:
        `${settingsPath} has no "${HOLD_SETTING_KEY}" key, and the game's own default for it is ` +
        'true, which parks the client on the character-select screen no matter what character is ' +
        `chosen. Add "${HOLD_SETTING_KEY}": false to the "client" object in that file and call ` +
        'game_enter again. This was not added automatically: the key is absent, so adding it means ' +
        'editing the shape of a configuration file rather than one value in it. Nothing was launched.',
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
