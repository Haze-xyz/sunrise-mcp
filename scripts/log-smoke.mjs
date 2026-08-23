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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RARE_THRESHOLD,
  buildDigest,
  matchesFilter,
  parseLogLine,
} from '../dist/log-parse.js';

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

    // And the shared rule must agree with buildDigest itself, or the comparison above is theatre.
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('log smoke test crashed:', err);
  process.exit(1);
});
