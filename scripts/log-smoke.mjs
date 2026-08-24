#!/usr/bin/env node
/**
 * Tests of log-parse.js, log-cursor.js and log-stream.js against the checked-in 882-line fixture
 * (a scrubbed copy of a real sunrise.log.old) and temporary files. No game, no Windows.
 *
 * Run after `npm run build`:
 *   node scripts/log-smoke.mjs
 * or as part of:
 *   npm run test:log
 *
 * What the fixture is for. The digest's whole value is a number -- 882 lines become 34 -- and the
 * only way to keep that number honest is to compute it on a real log rather than on a hand-made
 * one. The fixture is 121 608 bytes because the scrub is length-preserving; if it ever isn't, the
 * assertions below stop meaning what they say.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RARE_THRESHOLD,
  buildDigest,
  matchesFilter,
  parseLogLine,
} from '../dist/log-parse.js';
import { cursorState, decodeCursor, encodeCursor, fileIdentity } from '../dist/log-cursor.js';
import { readWindow } from '../dist/log-stream.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'sunrise-882.log');

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

async function fixtureRecords() {
  const text = await readFile(FIXTURE, 'utf8');
  return text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0).map(parseLogLine);
}

async function main() {
  await test('a plain line splits into channel, level, t and ev', () => {
    const rec = parseLogLine('client level=info t=113672 ev=shutdown result=ok');
    assert.equal(rec.channel, 'client');
    assert.equal(rec.level, 'info');
    assert.equal(rec.t, 113672);
    assert.equal(rec.ev, 'shutdown');
    assert.equal(rec.fields.result, 'ok');
  });

  await test('text= runs to end of line, spaces and all', () => {
    const raw = 'client level=info t=111610 ev=retail site=80 text=world_controller: Leaving state for reason x.';
    const rec = parseLogLine(raw);
    assert.equal(rec.ev, 'retail');
    assert.equal(rec.fields.site, '80');
    assert.equal(rec.fields.text, 'world_controller: Leaving state for reason x.');
  });

  await test('a repeated key keeps the first occurrence, not the last', () => {
    // A real line from the checked-in fixture. The second level= is a graphics driver feature
    // level, not a severity; last-wins made this info line rank as unknown, and an unknown level
    // is never filtered out -- so asking for errors returned a message about the graphics probe.
    const rec = parseLogLine(
      'client level=info t=1313 ev=graphics stage=probe result=ok driver=hardware level=0xB000',
    );
    assert.equal(rec.level, 'info');
    assert.equal(rec.fields.level, 'info');
    assert.equal(matchesFilter(rec, { level: 'error' }), false);
  });

  await test('a text= out of position silently absorbs every field after it', () => {
    // The real sink always emits text= last -- that is the contract parseLogLine relies on. This
    // pins what happens if a line ever broke that contract: no throw, no warning, and the fields
    // that would have come after text= (here ev= and site=) are gone, swallowed into fields.text.
    const raw = 'client level=info t=1 text=hello there ev=retail site=5';
    const rec = parseLogLine(raw);
    assert.equal(rec.ev, '');
    assert.equal(rec.fields.text, 'hello there ev=retail site=5');
  });

  await test('a line with no recognisable shape still parses without throwing', () => {
    const rec = parseLogLine('this is not a log line');
    assert.equal(rec.channel, 'this');
    assert.equal(rec.ev, '');
    assert.equal(rec.t, null);
  });

  await test('level is a threshold, not an equality', () => {
    const warn = parseLogLine('client level=warn t=1 ev=x');
    const debug = parseLogLine('client level=debug t=1 ev=x');
    assert.equal(matchesFilter(warn, { level: 'info' }), true);
    assert.equal(matchesFilter(debug, { level: 'info' }), false);
    assert.equal(matchesFilter(debug, { level: 'debug' }), true);
  });

  await test('a line whose level is unreadable is never filtered out', () => {
    const rec = parseLogLine('client t=1 ev=x');
    assert.equal(matchesFilter(rec, { level: 'error' }), true);
  });

  await test('ev, channel and text filters', () => {
    const rec = parseLogLine('client level=info t=1 ev=queuez stage=family0 result=seeded');
    assert.equal(matchesFilter(rec, { ev: ['queuez'] }), true);
    assert.equal(matchesFilter(rec, { ev: ['send'] }), false);
    assert.equal(matchesFilter(rec, { channel: ['server'] }), false);
    assert.equal(matchesFilter(rec, { text: 'FAMILY0' }), true);
  });

  await test('the digest turns the real 882-line log into 34 lines', async () => {
    const records = await fixtureRecords();
    assert.equal(records.length, 882);
    const digest = buildDigest(records);
    assert.equal(digest.total, 882);
    assert.equal(digest.rows.length, 8);
    assert.equal(digest.verbatim.length, 26);
    assert.equal(digest.rows.length + digest.verbatim.length, 34);
    const retail = digest.rows.find((r) => r.ev === 'retail');
    assert.ok(retail, 'ev=retail must be a counted row, not verbatim');
    assert.equal(retail.count, 422);
  });

  await test('grouping by ev alone beats grouping by ev+site, and by a lot', async () => {
    // The assertion that stops someone "improving" the granularity. Measured: sub-grouping
    // ev=retail by site= turns one 422-line bucket into dozens of singletons, which the
    // rare-is-signal rule then keeps verbatim, and 34 lines out becomes 203 -- 96.1% down to 77.0%.
    //
    // Both sides are sized by the SAME rule, and that is why it is written as one function: rows
    // for frequent keys, verbatim for rare keys PLUS every warn and error, which is exactly what
    // buildDigest does. Counting one side with the warn/error term and the other without it
    // compares nothing -- it yields 34 against 201, and the gap looks real when it is an artefact.
    const records = await fixtureRecords();

    const sizeUnder = (keyOf) => {
      const counts = new Map();
      for (const rec of records) counts.set(keyOf(rec), (counts.get(keyOf(rec)) ?? 0) + 1);
      const rare = new Set();
      let rows = 0;
      for (const [key, count] of counts) {
        if (count <= DEFAULT_RARE_THRESHOLD) rare.add(key);
        else rows += 1;
      }
      const verbatim = records.filter(
        (rec) => rare.has(keyOf(rec)) || rec.level === 'warn' || rec.level === 'error',
      ).length;
      return rows + verbatim;
    };

    const byEv = (rec) => rec.ev;
    const byEvAndSite = (rec) =>
      rec.ev === 'retail' && rec.fields.site !== undefined ? `retail/${rec.fields.site}` : rec.ev;

    assert.equal(sizeUnder(byEv), 34);
    assert.equal(sizeUnder(byEvAndSite), 203);

    // This only checks that the test's local copy of the rule has not drifted from buildDigest's
    // own: sizeUnder mirrors buildDigest's rule structurally, so the two agree for any input, not
    // just this fixture -- it catches a hand-edit to one copy that was not made to the other.
    const digest = buildDigest(records);
    assert.equal(digest.rows.length + digest.verbatim.length, sizeUnder(byEv));
  });

  await test('warn and error are verbatim even when their ev is frequent', () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => parseLogLine(`client level=info t=${i} ev=send bytes=1`)),
      parseLogLine('client level=warn t=99 ev=send bytes=2'),
    ];
    const digest = buildDigest(records);
    assert.equal(digest.rows.length, 1);
    assert.equal(digest.rows[0].ev, 'send');
    // The warn line counts in the row (21, not 20) AND appears verbatim: the row says how often
    // the event happened, the verbatim line says what went wrong.
    assert.equal(digest.rows[0].count, 21);
    assert.equal(digest.verbatim.length, 1);
    assert.ok(digest.verbatim[0].includes('level=warn'));
  });

  await test('a counted row carries the first and last t it saw', () => {
    const records = [10, 20, 30, 40, 50, 60].map((t) => parseLogLine(`client level=info t=${t} ev=send`));
    const digest = buildDigest(records);
    assert.equal(digest.rows[0].count, 6);
    assert.equal(digest.rows[0].firstT, 10);
    assert.equal(digest.rows[0].lastT, 60);
  });

  await test('a cursor survives a round trip', () => {
    const encoded = encodeCursor({ v: 1, id: '42:1700000000000', off: 8192 });
    assert.deepEqual(decodeCursor(encoded), { v: 1, id: '42:1700000000000', off: 8192 });
  });

  await test('garbage decodes to null rather than throwing', () => {
    assert.equal(decodeCursor('not-base64!!'), null);
    assert.equal(decodeCursor(Buffer.from('{}', 'utf8').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('[1,2,3]', 'utf8').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('{"v":2,"id":"a","off":0}', 'utf8').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('{"v":1,"id":"a","off":-1}', 'utf8').toString('base64url')), null);
  });

  await test('no cursor means fresh', () => {
    const identity = fileIdentity({ ino: 7, birthtimeMs: 1000, size: 500 });
    assert.deepEqual(cursorState(undefined, identity), { state: 'fresh', offset: 0 });
  });

  await test('an undecodable cursor is invalid, not silently fresh', () => {
    const identity = fileIdentity({ ino: 7, birthtimeMs: 1000, size: 500 });
    assert.equal(cursorState('!!!', identity).state, 'invalid');
  });

  await test('rotation is caught by the identity test on its own', () => {
    // Same offset, still inside the new file's size: only the id can tell these apart.
    const before = fileIdentity({ ino: 7, birthtimeMs: 1000, size: 900 });
    const after = fileIdentity({ ino: 8, birthtimeMs: 2000, size: 900 });
    const cursor = encodeCursor({ v: 1, id: before.id, off: 400 });
    assert.equal(cursorState(cursor, before).state, 'resumable');
    assert.equal(cursorState(cursor, after).state, 'rotated');
  });

  await test('rotation is caught by the size test on its own', () => {
    // Same id -- the case where Windows hands back a recycled file index -- but the file shrank.
    const identity = fileIdentity({ ino: 7, birthtimeMs: 1000, size: 100 });
    const cursor = encodeCursor({ v: 1, id: identity.id, off: 400 });
    assert.equal(cursorState(cursor, identity).state, 'rotated');
  });

  await test('an offset exactly at end of file is resumable, not rotated', () => {
    const identity = fileIdentity({ ino: 7, birthtimeMs: 1000, size: 400 });
    const cursor = encodeCursor({ v: 1, id: identity.id, off: 400 });
    assert.deepEqual(cursorState(cursor, identity), { state: 'resumable', offset: 400 });
  });

  await test('a bigint ino is accepted, since Node hands one back on some volumes', () => {
    const identity = fileIdentity({ ino: 12345678901234567890n, birthtimeMs: 1000, size: 10 });
    assert.equal(identity.id, '12345678901234567890:1000');
  });

  await test('two NTFS file ids that collide as doubles stay distinct', () => {
    // Measured on this machine: a real ino was 15481123719086430, past 2^53. Above that a double
    // cannot hold every integer, and 15481123719086431 and ...433 both become ...432. If this
    // assertion ever fails, a rotated log reads as resumable and the next read walks into unrelated
    // bytes -- the one failure this whole module exists to prevent.
    assert.equal(Number(15481123719086431n), Number(15481123719086433n), 'the collision guarded against is real');
    const left = fileIdentity({ ino: 15481123719086431n, birthtimeMs: 1000, size: 10 });
    const right = fileIdentity({ ino: 15481123719086433n, birthtimeMs: 1000, size: 10 });
    assert.notEqual(left.id, right.id);
  });

  await test('a first read returns everything and hands back a usable cursor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    await writeFile(file, 'client level=info t=1 ev=a\r\nclient level=info t=2 ev=b\r\n', 'utf8');
    const first = await readWindow(file, {});
    assert.equal(first.state, 'fresh');
    assert.equal(first.records.length, 2);
    assert.equal(first.dropped, 0);

    await appendFile(file, 'client level=info t=3 ev=c\r\n', 'utf8');
    const second = await readWindow(file, { since: first.cursor });
    assert.equal(second.state, 'resumable');
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].ev, 'c');
    await rm(dir, { recursive: true, force: true });
  });

  await test('an incomplete trailing line is not consumed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    await writeFile(file, 'client level=info t=1 ev=a\r\nclient level=info t=2 ev=b', 'utf8');
    const first = await readWindow(file, {});
    assert.equal(first.records.length, 1, 'the half-written line must wait for its newline');

    await appendFile(file, ' result=ok\r\n', 'utf8');
    const second = await readWindow(file, { since: first.cursor });
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].fields.result, 'ok');
    await rm(dir, { recursive: true, force: true });
  });

  await test('a real rotation is reported, and the read restarts from the top', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    await writeFile(file, 'client level=info t=1 ev=a\r\n'.repeat(50), 'utf8');
    const first = await readWindow(file, {});
    assert.equal(first.records.length, 50);

    // What the game does: rename, then create a fresh, shorter file under the same name.
    await rm(`${file}.old`, { force: true });
    await writeFile(`${file}.old`, await readFile(file, 'utf8'), 'utf8');
    await rm(file, { force: true });
    await writeFile(file, 'client level=info t=1 ev=z\r\n', 'utf8');

    const second = await readWindow(file, { since: first.cursor });
    assert.equal(second.state, 'rotated');
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].ev, 'z');
    await rm(dir, { recursive: true, force: true });
  });

  await test('the filter is applied while reading, not after', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    const lines = [];
    for (let i = 0; i < 100; i += 1) {
      lines.push(`client level=${i % 2 === 0 ? 'debug' : 'info'} t=${i} ev=${i % 2 === 0 ? 'send' : 'queuez'}\r\n`);
    }
    await writeFile(file, lines.join(''), 'utf8');
    const result = await readWindow(file, { filter: { ev: ['queuez'] } });
    assert.equal(result.records.length, 50);
    assert.equal(result.scanned, 100);
    await rm(dir, { recursive: true, force: true });
  });

  await test('the output cap is said, and the cursor resumes at the first line left behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    const lines = [];
    for (let i = 0; i < 30; i += 1) lines.push(`client level=info t=${i} ev=a\r\n`);
    await writeFile(file, lines.join(''), 'utf8');

    const first = await readWindow(file, { maxLines: 10 });
    assert.equal(first.records.length, 10);
    assert.equal(first.dropped, 20);
    assert.equal(first.records[9].t, 9);

    const second = await readWindow(file, { since: first.cursor, maxLines: 10 });
    assert.equal(second.records[0].t, 10, 'nothing may be lost at the cap');
    assert.equal(second.dropped, 10);
    await rm(dir, { recursive: true, force: true });
  });

  await test('a multi-byte character on a chunk boundary neither corrupts nor drifts', async () => {
    // The reader pulls 256 KiB per syscall. Decoding each chunk on its own splits a UTF-8 sequence
    // into two replacement characters -- 2 bytes becoming 6 -- and because every offset here comes
    // from the decoded text, the cursor overshoots true EOF. cursorState then answers 'rotated' for
    // a file that never rotated: the next read starts over from zero, and in wait_for the wait ends
    // reporting a restart that did not happen. Measured on the real code before the fix: +4 bytes.
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    const file = path.join(dir, 'sunrise.log');
    const CHUNK = 256 * 1024;
    const filler = 'client level=info t=1 ev=pad\r\n';
    let head = filler.repeat(Math.floor((CHUNK - 1) / filler.length));
    head += 'x'.repeat(CHUNK - 1 - Buffer.byteLength(head));
    await writeFile(
      file,
      Buffer.concat([
        Buffer.from(head, 'utf8'),
        Buffer.from('\u00e9', 'utf8'), // starts at CHUNK-1, so its second byte lands in chunk two
        Buffer.from('\r\nclient level=info t=999 ev=marker text=cafe\r\n', 'utf8'),
      ]),
    );
    const { size } = await stat(file);
    const result = await readWindow(file, { filter: { ev: ['marker'] } });
    assert.equal(result.records.length, 1);
    assert.equal(decodeCursor(result.cursor).off, size, 'the cursor must land on true EOF, not past it');

    const everything = await readWindow(file, { maxLines: 100000 });
    assert.ok(
      !everything.records.some((rec) => rec.raw.includes('\uFFFD')),
      'a split sequence must not decode to replacement characters',
    );
    await rm(dir, { recursive: true, force: true });
  });

  await test('a missing log says so instead of throwing something unreadable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'log-stream-'));
    await assert.rejects(
      () => readWindow(path.join(dir, 'nope.log'), {}),
      (err) => err instanceof Error && err.message.includes('not found'),
    );
    await rm(dir, { recursive: true, force: true });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('log smoke test crashed:', err);
  process.exit(1);
});
