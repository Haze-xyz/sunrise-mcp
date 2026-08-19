#!/usr/bin/env node
/**
 * Drives everything behind `game_enter`'s `character` argument that can be driven without the game:
 * the argument parser, the two console answers it reads, the two log markers it decides on, and the
 * settings rewrite it performs — plus one end-to-end check that the MCP server actually *publishes*
 * the argument, which is the whole point of the feature.
 *
 * Run after `npm run build`:
 *   node scripts/character-smoke.mjs
 * or just:
 *   npm run test:keys
 *
 * Three of these deserve a note, because they are the ones that could have been written so they
 * cannot fail:
 *
 * - **The markers are checked against real captured log lines, both ways.** The claim behind
 *   CHARACTER_ENTERED_MARKER is not "this string exists" but "this string separates a client that
 *   entered as a character from one parked on the selection screen". So the fixtures below are
 *   verbatim excerpts of two real sunrise.log runs — the 2026-08-19 probe that entered as the
 *   warlock, and the run before it that parked — and the checks assert the marker is found in the
 *   first and *absent* from the second, through the very `waitForLogMarker` game_enter calls. A
 *   marker that matched both runs would pass a one-sided test and be worthless.
 * - **The settings rewrite is checked byte-for-byte on the untouched remainder.** The reason not to
 *   round-trip the user's 74 KB settings.json through JSON.parse is that it would rewrite the whole
 *   file; a test that only asserted the flag came out false would pass for the implementation that
 *   does exactly that.
 * - **The published tool surface is read from a real MCP client over stdio**, not from the source
 *   text. The acceptance criterion for this feature is that an agent holding nothing but the tool
 *   list can issue the call, so the check spawns dist/index.js and reads tools/list the way that
 *   agent would. No game is involved: the server connects to the endpoint lazily, per request.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CHARACTER_CLASSES,
  CHARACTER_ENTERED_MARKER,
  HOLD_HOOK_MARKER,
  HOLD_SETTING_KEY,
  SIGN_IN_MARKER,
  decideCharacterStep,
  decideCharacterVerdict,
  describeRoster,
  disableCharacterSelectHold,
  holdSettingBackupPath,
  normalizeCharacterRequest,
  parseRoster,
  parseSelectAnswer,
  rewriteHoldCharacterSelect,
  rosterIsReady,
} from '../dist/character.js';
import { waitForLogMarker } from '../dist/keys.js';
import { decideKillOutcome, waitForGameToExit } from '../dist/game.js';

/** @type {{ name: string; ok: boolean; error?: string }[]} */
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

// ---------------------------------------------------------------------------
// Fixtures: verbatim from the game's own sunrise.log, two runs, 2026-08-19.
// ---------------------------------------------------------------------------

/** The run that entered the world as the warlock (client.hold_character_select false, pick made
 *  before sign-in). Note there is no `stage=character_select` line at all: the hold hook is not
 *  installed when the flag is off, so it writes nothing. */
const LOG_ENTERED = `client level=info t=15093 ev=retail site=3 text=world_controller:state_manager: Entering state 'bootflow:bap_signin' for reason 'unavailable'.
client level=info t=31390 ev=retail site=3 text=world_controller:state_manager: Entering state 'character:signin' for reason 'unavailable'.
client level=info t=31421 ev=retail site=26 text=world_controller:ui_stage: Substage goal changed from 'ENUM(26)' to 'ENUM(30)'.
client level=info t=31515 ev=retail site=26 text=world_controller:ui_stage: Substage goal changed from 'ENUM(30)' to 'ENUM(31)'.
client level=info t=31625 ev=retail site=26 text=world_controller:ui_stage: Substage goal changed from 'ENUM(31)' to 'ENUM(19)'.
client level=info t=31718 ev=retail site=23 text=world_controller:retail_datamine: Total time spent: [334] ms in world controller state: [27] name: [character:signin]
client level=info t=31718 ev=retail site=24 text=world_controller:state_manager: Leaving state 'character:signin' for reason 'unavailable'.
client level=info t=31718 ev=retail site=3 text=world_controller:state_manager: Entering state 'cleanup' for reason 'unavailable'.
`;

/** The run that parked on the character-selection screen and stayed there (hold flag on). It reaches
 *  the same UI substage 30 -> 31 and stops; the world-load marker was already written minutes of log
 *  earlier, which is why that marker cannot be the one this feature checks. */
const LOG_PARKED = `client level=info t=3500 ev=bootflow stage=character_select result=ok
client level=info t=31156 ev=retail site=3 text=world_controller:state_manager: Entering state 'character:signin' for reason 'unavailable'.
client level=info t=31156 ev=bootflow stage=character_select result=held
client level=info t=31156 ev=retail site=25 text=world_controller:ui_stage: Substage goal changed from 'ENUM(26)' to 'ENUM(30)'.
client level=info t=31187 ev=retail site=25 text=world_controller:ui_stage: Substage goal changed from 'ENUM(30)' to 'ENUM(31)'.
client level=debug t=31187 ev=bitmap stage=seen handle=0x80B47FD1 result=ok
`;

/** `character.list`'s rows, verbatim from the live endpoint on 2026-08-19 after entering as the
 *  warlock. Note soid values arrive as strings: a character key uses the whole unsigned 64-bit range
 *  and would come back negative as an integer row. */
const LIST_ROWS = [
  { key: 'count', value: 3 },
  { key: 'selected_index', value: 2 },
  { key: 'soid_0', value: '11433003384887574785' },
  { key: 'soid_0_hex', value: '9EAA300100100101' },
  { key: 'class_0', value: 'hunter' },
  { key: 'selected_0', value: false },
  { key: 'soid_1', value: '11433003384887574786' },
  { key: 'soid_1_hex', value: '9EAA300100100102' },
  { key: 'class_1', value: 'titan' },
  { key: 'selected_1', value: false },
  { key: 'soid_2', value: '11433003384887574787' },
  { key: 'soid_2_hex', value: '9EAA300100100103' },
  { key: 'class_2', value: 'warlock' },
  { key: 'selected_2', value: true },
];

/** `character.select warlock`'s rows, verbatim from the same run. */
const SELECT_ROWS = [
  { key: 'count', value: 3 },
  { key: 'previous_index', value: -1 },
  { key: 'index', value: 2 },
  { key: 'soid', value: '11433003384887574787' },
  { key: 'soid_hex', value: '9EAA300100100103' },
  { key: 'class', value: 'warlock' },
  { key: 'changed', value: true },
];

/** A settings.json shaped like the real one: the flag among its siblings, one-line objects, the
 *  exact indentation the game's file uses. */
const SETTINGS = `{
  "version": 6,
  "client": {
    "ui": { "enabled": true, "toggle_key": "insert" },
    "fade_release": true,
    "hold_character_select": true,
    "hold_spawn": true,
    "spawn_hold_ms": 30000
  },
  "server": { "bap_port": 30974 }
}
`;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sunrise-mcp-character-smoke-'));

  try {
    // -----------------------------------------------------------------------
    // The argument a caller types.
    // -----------------------------------------------------------------------

    await test('every class this game authors is accepted, in any case and with stray spacing', () => {
      for (const name of CHARACTER_CLASSES) {
        assert.deepEqual(normalizeCharacterRequest(name), { kind: 'class', token: name });
        assert.deepEqual(normalizeCharacterRequest(name.toUpperCase()), { kind: 'class', token: name });
        assert.deepEqual(normalizeCharacterRequest(`  ${name} `), { kind: 'class', token: name });
      }
      assert.deepEqual(normalizeCharacterRequest('WaRlOcK'), { kind: 'class', token: 'warlock' });
    });

    await test('an index is accepted in the same argument, one or two digits', () => {
      assert.deepEqual(normalizeCharacterRequest('2'), { kind: 'index', token: '2', index: 2 });
      // Two digits reach the console's own refusal (which names the roster) rather than being
      // rejected here as "not a class", which would send a caller looking for a class named 10.
      assert.deepEqual(normalizeCharacterRequest('10'), { kind: 'index', token: '10', index: 10 });
    });

    await test('a word that is not a class is refused locally, naming the classes, before any launch', () => {
      const refused = normalizeCharacterRequest('paladin');
      assert.equal(refused.kind, 'invalid');
      for (const name of CHARACTER_CLASSES) {
        assert.ok(refused.reason.includes(name), `the refusal must name ${name}; got: ${refused.reason}`);
      }
      assert.ok(refused.reason.includes('paladin'), 'the refusal must quote what was typed back');
      assert.equal(normalizeCharacterRequest('').kind, 'invalid');
      assert.equal(normalizeCharacterRequest('   ').kind, 'invalid');
    });

    await test('nothing that survives normalization can carry a second console token', () => {
      // The accepted token is concatenated into `character.select <token>`, one line in a 512-byte
      // envelope. Anything with a space, quote, brace or newline in it would be a second argument,
      // a broken JSON envelope, or a second console line.
      for (const hostile of [
        'warlock 1',
        'warlock\nplayer.infinite_ammo 1',
        'warlock"',
        '{"line":"x"}',
        'war lock',
        'warlock;titan',
      ]) {
        const parsed = normalizeCharacterRequest(hostile);
        assert.equal(parsed.kind, 'invalid', `${JSON.stringify(hostile)} must not be accepted`);
      }
      for (const name of CHARACTER_CLASSES) {
        assert.match(normalizeCharacterRequest(name).token, /^[a-z]+$/);
      }
      assert.match(normalizeCharacterRequest('12').token, /^[0-9]{1,2}$/);
    });

    // -----------------------------------------------------------------------
    // The two console answers.
    // -----------------------------------------------------------------------

    await test('the live character.list rows parse into the roster, keys as strings', () => {
      const roster = parseRoster(LIST_ROWS);
      assert.notEqual(roster, null);
      assert.equal(roster.count, 3);
      assert.equal(roster.selectedIndex, 2);
      assert.equal(roster.characters.length, 3);
      assert.equal(roster.selected.characterClass, 'warlock');
      assert.equal(roster.selected.index, 2);
      // The whole reason the console reports this as text: 0x9EAA… is above INT64_MAX, so a numeric
      // row would have come back negative and this string would not round-trip.
      assert.equal(roster.selected.soid, '11433003384887574787');
      assert.equal(describeRoster(roster), 'hunter (index 0), titan (index 1), warlock (index 2)');
    });

    await test('a roster with nothing selected reports selectedIndex -1 and no selected character', () => {
      const rows = LIST_ROWS.map((row) =>
        row.key === 'selected_index' ? { key: row.key, value: -1 } : row.key === 'selected_2' ? { key: row.key, value: false } : row,
      );
      const roster = parseRoster(rows);
      assert.equal(roster.selectedIndex, -1);
      assert.equal(roster.selected, null);
    });

    await test('an answer without the header rows is null, never a half-built roster', () => {
      assert.equal(parseRoster(LIST_ROWS.filter((row) => row.key !== 'count')), null);
      assert.equal(parseRoster(LIST_ROWS.filter((row) => row.key !== 'selected_index')), null);
      assert.equal(parseRoster([]), null);
      // A character missing one of its four rows is dropped rather than defaulted: defaulting its
      // `selected` flag to false is exactly how a verification would quietly answer the wrong way.
      const missingFlag = parseRoster(LIST_ROWS.filter((row) => row.key !== 'selected_2'));
      assert.equal(missingFlag.characters.length, 2);
      assert.equal(missingFlag.selected, null);
    });

    await test('the live character.select rows parse into what was picked', () => {
      const picked = parseSelectAnswer(SELECT_ROWS);
      assert.notEqual(picked, null);
      assert.equal(picked.index, 2);
      assert.equal(picked.characterClass, 'warlock');
      assert.equal(picked.changed, true);
      assert.equal(picked.previousIndex, -1);
      assert.equal(picked.soid, '11433003384887574787');
    });

    await test('a refused character.select answer parses as null rather than as a pick', () => {
      // Every refusal path in the console module stops before the index/class rows are added, so
      // the refusal carries only `count` (and sometimes previous_index).
      assert.equal(parseSelectAnswer([{ key: 'count', value: 3 }]), null);
      assert.equal(parseSelectAnswer([{ key: 'count', value: 3 }, { key: 'previous_index', value: -1 }]), null);
    });

    // -----------------------------------------------------------------------
    // The markers, against real log excerpts, both ways.
    // -----------------------------------------------------------------------

    await test('the entered-marker is present in the run that entered and absent from the run that parked', async () => {
      const enteredLog = path.join(dir, 'entered.log');
      const parkedLog = path.join(dir, 'parked.log');
      await writeFile(enteredLog, LOG_ENTERED, 'utf8');
      await writeFile(parkedLog, LOG_PARKED, 'utf8');

      assert.equal(
        await waitForLogMarker(CHARACTER_ENTERED_MARKER, 0, enteredLog),
        true,
        'the run that entered the world as the warlock must match',
      );
      assert.equal(
        await waitForLogMarker(CHARACTER_ENTERED_MARKER, 0, parkedLog),
        false,
        'the run that parked on the selection screen must NOT match -- that is the whole claim',
      );
      // Both runs enter the step. Only one leaves it, which is why the marker is the leaving line
      // and not the entering line.
      assert.ok(LOG_PARKED.includes("Entering state 'character:signin'"));
      assert.ok(LOG_ENTERED.includes("Entering state 'character:signin'"));

      // The deadline marker is a real line too, and it lands long before the entered-marker. That
      // ordering is the whole reason the pick is gated on it: once it is in the log, the account
      // image the client is sent has already been built.
      assert.equal(await waitForLogMarker(SIGN_IN_MARKER, 0, enteredLog), true);
      assert.ok(
        LOG_ENTERED.indexOf(SIGN_IN_MARKER) < LOG_ENTERED.indexOf(CHARACTER_ENTERED_MARKER),
        'sign-in must precede the client leaving the character step, or the gate is guarding nothing',
      );
    });

    await test('the hold-hook marker is present in the held run and absent when the flag was off', async () => {
      const enteredLog = path.join(dir, 'entered.log');
      const parkedLog = path.join(dir, 'parked.log');
      assert.equal(await waitForLogMarker(HOLD_HOOK_MARKER, 0, parkedLog), true);
      assert.equal(
        await waitForLogMarker(HOLD_HOOK_MARKER, 0, enteredLog),
        false,
        'nothing is logged at all when hold_character_select is off, which is what makes absence readable',
      );
      // The marker is deliberately a prefix of the variant the hook writes when it attaches but
      // fails to publish its registry entry: both mean attached, and both must be caught.
      const variant = path.join(dir, 'variant.log');
      await writeFile(variant, `${HOLD_HOOK_MARKER} reason=step_unpublished\n`, 'utf8');
      assert.equal(await waitForLogMarker(HOLD_HOOK_MARKER, 0, variant), true);
      // ...but the failure variant must not be read as attached.
      const failed = path.join(dir, 'failed.log');
      await writeFile(failed, 'client level=warn t=3500 ev=bootflow stage=character_select result=fail reason=target\n', 'utf8');
      assert.equal(await waitForLogMarker(HOLD_HOOK_MARKER, 0, failed), false);
    });

    // -----------------------------------------------------------------------
    // The settings rewrite.
    // -----------------------------------------------------------------------

    await test('the rewrite changes the flag and not one other byte of the file', () => {
      const rewrite = rewriteHoldCharacterSelect(SETTINGS);
      assert.equal(rewrite.occurrences, 1);
      assert.equal(rewrite.previous, true);
      assert.equal(rewrite.changed, true);
      assert.ok(rewrite.text.includes(`"${HOLD_SETTING_KEY}": false`));
      // The point of not round-tripping through JSON: everything else has to survive verbatim,
      // including the one-line "ui" object and the trailing newline.
      assert.equal(
        rewrite.text.replace(`"${HOLD_SETTING_KEY}": false`, `"${HOLD_SETTING_KEY}": true`),
        SETTINGS,
        'nothing outside the flag may change',
      );
      assert.equal(rewrite.text.length, SETTINGS.length + 1); // true -> false
    });

    await test('a flag already false is left alone, and an absent or duplicated key is reported not repaired', () => {
      const already = rewriteHoldCharacterSelect(
        SETTINGS.replace(`"${HOLD_SETTING_KEY}": true`, `"${HOLD_SETTING_KEY}": false`),
      );
      assert.equal(already.changed, false);
      assert.equal(already.previous, false);
      assert.equal(already.occurrences, 1);

      const absent = rewriteHoldCharacterSelect(SETTINGS.replace(`    "${HOLD_SETTING_KEY}": true,\n`, ''));
      assert.equal(absent.occurrences, 0);
      assert.equal(absent.changed, false);

      const twice = rewriteHoldCharacterSelect(
        SETTINGS.replace(`"${HOLD_SETTING_KEY}": true,`, `"${HOLD_SETTING_KEY}": true,\n    "${HOLD_SETTING_KEY}": false,`),
      );
      assert.equal(twice.occurrences, 2);
      assert.equal(twice.changed, false, 'a file the game itself refuses to parse must not be half-edited');
    });

    await test('turning the hold off writes the file, backs up the original once, and says what it did', async () => {
      const settingsPath = path.join(dir, 'settings.json');
      await writeFile(settingsPath, SETTINGS, 'utf8');

      const first = await disableCharacterSelectHold(settingsPath);
      assert.equal(first.status, 'turnedOff');
      assert.equal(first.previous, true);
      assert.equal(first.backupPath, holdSettingBackupPath(settingsPath));
      assert.ok(first.message.includes(settingsPath));
      assert.ok(first.message.includes(HOLD_SETTING_KEY));
      assert.equal(await readFile(settingsPath, 'utf8'), rewriteHoldCharacterSelect(SETTINGS).text);
      assert.equal(await readFile(first.backupPath, 'utf8'), SETTINGS, 'the backup must be the untouched original');

      // A second call finds it already off and touches nothing.
      const second = await disableCharacterSelectHold(settingsPath);
      assert.equal(second.status, 'alreadyOff');
      assert.equal(second.previous, false);
      assert.equal(second.backupPath, undefined);

      // And a later call that DOES change it again must not overwrite the first backup -- that copy
      // is the only record of the state before this server ever touched the file.
      await writeFile(settingsPath, SETTINGS.replace('"version": 6', '"version": 7'), 'utf8');
      const third = await disableCharacterSelectHold(settingsPath);
      assert.equal(third.status, 'turnedOff');
      assert.equal(
        await readFile(holdSettingBackupPath(settingsPath), 'utf8'),
        SETTINGS,
        'the backup must still be the FIRST original, not the second one',
      );
    });

    await test('an absent key or an unreadable file is refused with something to do, and nothing is written', async () => {
      const noKeyPath = path.join(dir, 'nokey.json');
      const withoutKey = SETTINGS.replace(`    "${HOLD_SETTING_KEY}": true,\n`, '');
      await writeFile(noKeyPath, withoutKey, 'utf8');
      const refusedAbsent = await disableCharacterSelectHold(noKeyPath);
      assert.equal(refusedAbsent.status, 'refused');
      assert.ok(refusedAbsent.message.includes(HOLD_SETTING_KEY));
      assert.ok(refusedAbsent.message.includes('"client"'), 'the refusal must say where to add it');
      assert.equal(await readFile(noKeyPath, 'utf8'), withoutKey, 'a refusal must not have written anything');
      await assert.rejects(() => stat(holdSettingBackupPath(noKeyPath)), 'a refusal must not leave a backup behind');

      const missing = await disableCharacterSelectHold(path.join(dir, 'does-not-exist.json'));
      assert.equal(missing.status, 'refused');
      assert.ok(missing.message.includes('does-not-exist.json'));
    });

    // -----------------------------------------------------------------------
    // The sequencing itself. This is the feature -- the pick is only correct in a window measured
    // at about a second wide -- and until these existed nothing in this suite could fail if the
    // pick were issued at the wrong moment, or not gated at all.
    // -----------------------------------------------------------------------

    await test('an empty roster is "not ready yet", not "this account owns nobody"', () => {
      // The endpoint binds at t=125ms, long before the account is authored from settings, so the
      // first answer that arrives is not necessarily a final one. Polling only until the socket
      // answers -- rather than until the roster is loaded -- failed the whole call on a game that
      // was a few hundred milliseconds early.
      assert.equal(rosterIsReady(parseRoster(LIST_ROWS)), true);
      assert.equal(rosterIsReady(null), false, 'an unreadable answer is not readiness');
      const empty = parseRoster([{ key: 'count', value: 0 }, { key: 'selected_index', value: -1 }]);
      assert.equal(empty.count, 0);
      assert.equal(rosterIsReady(empty), false, 'an empty roster must keep the poll going, not end it');
    });

    await test('decideCharacterStep: the pick is only issued when sign-in provably has not started', () => {
      // The case that was wrong: `proceed` is reached whenever the game runs, the world marker is
      // absent, the pid is known and THIS server has no press record -- which is also exactly what a
      // game a human or another agent already pressed Enter on, mid sign-in, looks like. A pick
      // there reaches no client and still repoints every action the server resolves for it.
      const table = [
        { entry: 'launch', signInStarted: false, kind: 'pick' },
        { entry: 'proceed', signInStarted: false, kind: 'pick' },
        { entry: 'proceed', signInStarted: true, kind: 'refuseLatePick' },
        { entry: 'launch', signInStarted: true, kind: 'refuseLatePick' },
        { entry: 'shortCircuitOk', signInStarted: false, kind: 'verifyOnly' },
        { entry: 'shortCircuitOk', signInStarted: true, kind: 'verifyOnly' },
        { entry: 'resumeWorldWait', signInStarted: false, kind: 'verifyOnly' },
        { entry: 'resumeWorldWait', signInStarted: true, kind: 'verifyOnly' },
      ];
      for (const row of table) {
        const step = decideCharacterStep({ entry: row.entry, signInStarted: row.signInStarted });
        assert.equal(
          step.kind,
          row.kind,
          `entry=${row.entry} signInStarted=${row.signInStarted} should be ${row.kind}, got ${step.kind}`,
        );
      }
      // The refusal has to tell an agent what happened and what to do, and say that nothing moved.
      const refused = decideCharacterStep({ entry: 'proceed', signInStarted: true });
      assert.ok(refused.reason.includes(SIGN_IN_MARKER), 'the refusal must quote the marker it read');
      assert.match(refused.reason, /game_kill/);
      assert.match(refused.reason, /nothing was changed/i);
      assert.match(refused.reason, /Enter was not pressed/i);
    });

    await test('decideCharacterVerdict: the word "entered" is only used where this call can defend it', () => {
      const warlock = { kind: 'class', token: 'warlock' };
      const rosterFor = (index) => parseRoster(
        LIST_ROWS.map((row) => {
          if (row.key === 'selected_index') return { key: row.key, value: index };
          if (/^selected_[0-9]+$/.test(row.key)) return { key: row.key, value: row.key === `selected_${index}` };
          return row;
        }),
      );
      const warlockRoster = rosterFor(2);
      const titanRoster = rosterFor(1);
      const noneRoster = parseRoster(
        LIST_ROWS.map((row) =>
          row.key === 'selected_index'
            ? { key: row.key, value: -1 }
            : /^selected_[0-9]+$/.test(row.key)
              ? { key: row.key, value: false }
              : row,
        ),
      );

      // The one path that may say "entered": this call picked, and the selection was the requested
      // one on both sides of the moment the client left the character step.
      const verified = decideCharacterVerdict({
        request: warlock, pickedByThisCall: true, before: warlockRoster, after: warlockRoster, entered: true,
      });
      assert.equal(verified.ok, true);
      assert.equal(verified.rosterKey, 'entered');
      assert.ok(verified.verifiedBy.includes('before and after'), 'the claim must name the bracket it rests on');
      assert.equal(verified.unverified, undefined);

      // THE REVIEW CASE, reachable with nothing exotic: console_run "character.select titan" against
      // a game already in orbit as the warlock, then game_enter { character: "titan" }. Both facts
      // are true and they are about different moments. It may answer ok; it may not call it entered
      // and may not attach a verification claim.
      const notPicked = decideCharacterVerdict({
        request: { kind: 'class', token: 'titan' },
        pickedByThisCall: false, before: titanRoster, after: titanRoster, entered: true,
      });
      assert.equal(notPicked.ok, true);
      assert.equal(notPicked.rosterKey, 'selectedNow', 'a call that made no pick must not say "entered"');
      assert.equal(notPicked.verifiedBy, undefined, 'and must attach no verification claim');
      assert.ok(notPicked.unverified.length > 0, 'it must say why there is no claim');
      assert.match(notPicked.message, /cannot confirm/i);

      // A selection that moved across the entry is caught by the second read, not smoothed over.
      const moved = decideCharacterVerdict({
        request: warlock, pickedByThisCall: true, before: warlockRoster, after: titanRoster, entered: true,
      });
      assert.equal(moved.ok, false);
      assert.equal(moved.stage, 'characterVerify');
      assert.match(moved.message, /moved while the client was entering/i);

      // The wrong character, nothing selected, and a client that never left the step.
      const wrong = decideCharacterVerdict({
        request: warlock, pickedByThisCall: false, before: titanRoster, after: titanRoster, entered: true,
      });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.rosterKey, 'selectedNow');
      assert.match(wrong.message, /selects titan, not the warlock/);

      const none = decideCharacterVerdict({
        request: warlock, pickedByThisCall: false, before: noneRoster, after: noneRoster, entered: true,
      });
      assert.equal(none.ok, false);
      assert.match(none.message, /No character is selected/);

      const parked = decideCharacterVerdict({
        request: warlock, pickedByThisCall: true, before: warlockRoster, after: warlockRoster, entered: false,
      });
      assert.equal(parked.ok, false);
      assert.equal(parked.stage, 'characterEnter');
      assert.ok(parked.message.includes(HOLD_SETTING_KEY));

      // An unreadable roster on either side is never an ok.
      const blindBefore = decideCharacterVerdict({
        request: warlock, pickedByThisCall: true, before: null, after: null, entered: true,
        unreadableReason: 'ECONNREFUSED',
      });
      assert.equal(blindBefore.ok, false);
      assert.ok(blindBefore.message.includes('ECONNREFUSED'));
      const blindAfter = decideCharacterVerdict({
        request: warlock, pickedByThisCall: true, before: warlockRoster, after: null, entered: true,
        unreadableReason: 'ECONNREFUSED',
      });
      assert.equal(blindAfter.ok, false);
      assert.equal(blindAfter.rosterKey, 'selectedNow');
      assert.match(blindAfter.message, /could not be re-read/i);

      // No verdict of any kind may claim "entered" without a pick by this call.
      for (const picked of [true, false]) {
        for (const enteredMarker of [true, false]) {
          const v = decideCharacterVerdict({
            request: warlock, pickedByThisCall: picked, before: warlockRoster, after: warlockRoster,
            entered: enteredMarker,
          });
          if (v.rosterKey === 'entered') {
            assert.ok(picked && enteredMarker, 'rosterKey "entered" requires both a pick by this call and the marker');
          }
        }
      }
    });

    await test('game_enter still issues the pick before the title wait and before the press', async () => {
      // A pure decision table cannot notice the call sites being reordered, and the ordering IS the
      // feature: the deadline was measured about one second after the key press, so a pick moved to
      // after the title wait would still pass every other check in this file while losing the race
      // on a fast boot. This reads the built server the way keys-smoke.mjs reads the .ps1 it parses,
      // and it is deliberately narrow: it pins the order of four call sites, and claims nothing
      // about what happens between them.
      const built = await readFile(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'),
        'utf8',
      );
      const at = (needle, what) => {
        const index = built.indexOf(needle);
        assert.notEqual(index, -1, `dist/index.js no longer contains ${what} (${needle})`);
        return index;
      };
      const signInGate = at('decideCharacterStep(', 'the sign-in gate');
      const pick = at('`character.select ${', 'the character.select call');
      const titleWait = at('waitForTitleScreen(', 'the title-screen wait');
      const press = at('pressTitleScreenKey(', 'the key press');

      assert.ok(signInGate < pick, 'the sign-in gate must be decided BEFORE the pick is issued');
      assert.ok(pick < titleWait, 'the pick must be issued BEFORE the title-screen wait, not after it');
      assert.ok(pick < press, 'the pick must be issued BEFORE Enter is pressed');
      // And the roster must be read before the gate, since the gate is only sound once the endpoint
      // has answered (that is what proves the log belongs to the running process).
      assert.ok(at('waitForRoster(', 'the roster poll') < signInGate, 'the roster must be read before the gate');
    });

    // -----------------------------------------------------------------------
    // The kill settle, which the acceptance run found missing the hard way.
    // -----------------------------------------------------------------------

    await test('game_kill waits for the process to actually leave the process table, not just for taskkill to return', async () => {
      // The bug this closes, measured 2026-08-19: `game_kill` reported SUCCESS, and a `game_enter`
      // 200ms later still found destiny2.exe in tasklist, took the "already running, world already
      // loaded" branch on the dead process's own log, and answered against an endpoint that had
      // stopped listening. That sequence is the one several of this server's own failure messages
      // tell a caller to run.
      let calls = 0;
      const goesAwayOnThirdLook = async () => ({ running: ++calls < 3 });
      const start = performance.now();
      assert.equal(await waitForGameToExit(goesAwayOnThirdLook, 3000, 20), true);
      assert.equal(calls, 3, 'it must keep looking until the process is gone, not answer on the first look');
      assert.ok(performance.now() - start >= 20, 'it must actually wait between looks');

      // A process that never goes away must end the wait rather than hang, and must say so.
      const neverGoesAway = async () => ({ running: true });
      assert.equal(await waitForGameToExit(neverGoesAway, 120, 20), false);

      // Already gone: answer at once, without sleeping out a poll interval.
      const alreadyGone = async () => ({ running: false });
      const quick = performance.now();
      assert.equal(await waitForGameToExit(alreadyGone, 3000, 500), true);
      assert.ok(performance.now() - quick < 400, 'an already-dead game must not cost a poll interval');

      // The status is the field a caller switches on, and reporting `killed` for a process that is
      // still there would leave the whole defect alive at the boundary. taskkill.exe does not exist
      // under WSL, so this mapping is only reachable as a pure function.
      const accepted = { status: 'killed', message: 'SUCCESS: ... has been terminated.' };
      const settled = decideKillOutcome(accepted, true);
      assert.equal(settled.status, 'killed');
      assert.match(settled.message, /gone from the process table/);

      const stillThere = decideKillOutcome(accepted, false);
      assert.equal(stillThere.status, 'failed', 'a process that outlived the settle must not report killed');
      assert.match(stillThere.message, /accepted by Windows/, 'and must not read as taskkill having refused');
      assert.match(stillThere.message, /game_kill again/);

      // Nothing to kill is untouched by any of this.
      const nothing = { status: 'notRunning', message: 'destiny2.exe was not running.' };
      assert.deepEqual(decideKillOutcome(nothing, true), nothing);
      assert.deepEqual(decideKillOutcome(nothing, false), nothing);
    });

    // -----------------------------------------------------------------------
    // What the MCP surface actually publishes, read the way an agent reads it.
    // -----------------------------------------------------------------------

    await test('the running MCP server publishes the character argument, its values, and the ordering warning', async () => {
      const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
      const client = new Client({ name: 'character-smoke', version: '0.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        const enter = tools.find((tool) => tool.name === 'game_enter');
        assert.ok(enter, 'game_enter must still be published');

        // An agent with no other context learns the argument exists and what it takes from here.
        const property = enter.inputSchema?.properties?.character;
        assert.ok(property, 'game_enter must declare a `character` input');
        assert.equal(property.type, 'string');
        assert.ok(
          (enter.inputSchema.required ?? []).includes('character') === false,
          'character must stay optional, so the no-character call is unchanged',
        );
        for (const name of CHARACTER_CLASSES) {
          assert.ok(property.description.includes(name), `the argument description must name ${name}`);
        }
        assert.ok(
          property.description.includes('character.list'),
          'the argument description must say an index is accepted and where the indices come from',
        );

        // And it learns that this tool -- not a console line -- is the way to do it, and why.
        assert.match(enter.description, /before the game signs in/i);
        assert.match(enter.description, /characterVerify/);
        assert.match(enter.description, new RegExp(HOLD_SETTING_KEY));

        const run = tools.find((tool) => tool.name === 'console_run');
        assert.ok(run.description.includes('character.select'), 'console_run must name the console entry and its syntax');
        assert.match(run.description, /game_enter \{ character: "warlock" \}/);
        // The class list in that description is built from CHARACTER_CLASSES rather than typed out,
        // so this pins the tie: adding a class to the constant must reach the text an agent reads.
        assert.ok(
          run.description.includes(CHARACTER_CLASSES.join('|')),
          `console_run must publish the class list as ${CHARACTER_CLASSES.join('|')}, built from CHARACTER_CLASSES`,
        );

        // game_kill's own description, not just the README: the settle is a behaviour change a
        // caller has to know about, and the tool list is where it reads about behaviour.
        const kill = tools.find((tool) => tool.name === 'game_kill');
        assert.match(kill.description, /waits/i, 'game_kill must say that it waits for the process to be gone');
        assert.match(kill.description, /failed/, 'and must document the status it returns when it is not');

        const describe = tools.find((tool) => tool.name === 'console_describe');
        assert.match(
          describe.description,
          /does not publish the arguments/i,
          'console_describe must admit it carries no argument metadata, or an agent will trust it to',
        );
      } finally {
        await client.close();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('character smoke test crashed:', err);
  process.exit(1);
});
