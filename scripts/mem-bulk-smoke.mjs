// scripts/mem-bulk-smoke.mjs
//
// The two capabilities that exist because the console answers in 16 rows and nothing more:
// kRowCapacity=16 gives mem.read 256 bytes a call and leaves mem.changed 7 addresses a call.
// Both capabilities collapse that paging server-side so one MCP call answers one question.
import assert from 'node:assert/strict';
import { parseChangedWindow, memChangedAllCapability } from '../dist/capabilities/mem-changed-all.js';
import { compressSpan, memReadRangeCapability } from '../dist/capabilities/mem-read-range.js';

const ok = (name) => console.log(`  ok  ${name}`);

/** Builds a mem.changed reply the way the console does: counts, then changed_0..changed_6. */
function changedReply({ changed, listed, from, addresses }) {
  const rows = [
    { key: 'mode', value: 'pages' },
    { key: 'region_base', value: 140695175368704 },
    { key: 'changed', value: changed },
    { key: 'listed', value: listed },
  ];
  if (from !== undefined) rows.push({ key: 'from', value: from });
  addresses.forEach((a, i) => rows.push({ key: `changed_${i}`, value: a }));
  return { status: 'ok', summary: '', rows };
}

// ---------------------------------------------------------------- parseChangedWindow

{
  const reply = changedReply({ changed: 73, listed: 73, addresses: [10, 20, 30] });
  const win = parseChangedWindow(reply);
  assert.equal(win.changed, 73);
  assert.equal(win.listed, 73);
  assert.deepEqual(win.addresses, [10n, 20n, 30n]);
  ok('parseChangedWindow reads the counts and the changed_N addresses in order');
}

{
  // changed_10 must not sort before changed_2: the suffix is a position, not a string.
  const addresses = Array.from({ length: 7 }, (_, i) => 100 + i);
  const win = parseChangedWindow(changedReply({ changed: 7, listed: 7, addresses }));
  assert.deepEqual(win.addresses, addresses.map(BigInt));
  ok('parseChangedWindow keeps window order');
}

{
  const refused = { status: 'refused', summary: 'Nothing has been photographed yet.', rows: [] };
  assert.throws(() => parseChangedWindow(refused), /refused/);
  ok('parseChangedWindow refuses a non-ok reply instead of returning an empty list');
}

// ---------------------------------------------------------------- mem_changed_all

/** A fake console serving one sorted list of addresses through the real 7-wide window. */
function consoleServing(addresses) {
  const lines = [];
  return {
    lines,
    console: {
      async runLine(line) {
        lines.push(line);
        const m = /^mem\.changed(?:\s+(\d+))?$/.exec(line.trim());
        if (!m) throw new Error(`unexpected line: ${line}`);
        const from = m[1] === undefined ? 0 : Number(m[1]);
        return changedReply({
          changed: addresses.length,
          listed: addresses.length,
          from: m[1] === undefined ? undefined : from,
          addresses: addresses.slice(from, from + 7),
        });
      },
      async describe() {
        return {};
      },
    },
  };
}

{
  const addresses = Array.from({ length: 16 }, (_, i) => 1000 + i * 4096);
  const { console: fake, lines } = consoleServing(addresses);
  const res = await memChangedAllCapability.run({}, { console: fake, mem: {}, game: {}, log: () => {} });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.changed, 16);
  assert.equal(out.addresses.length, 16);
  assert.deepEqual(out.addresses.map(Number), addresses);
  // 16 addresses through a 7-wide window is 3 calls: the fresh compare plus two pages.
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, ['mem.changed', 'mem.changed 7', 'mem.changed 14']);
  ok('mem_changed_all returns every address and pages exactly ceil(n/7) times');
}

{
  const { console: fake, lines } = consoleServing([5, 10, 15]);
  await memChangedAllCapability.run({}, { console: fake, mem: {}, game: {}, log: () => {} });
  assert.equal(lines.length, 1, 'a list that fits one window must not ask for a second');
  ok('mem_changed_all makes one call when the list fits one window');
}

{
  // The list is sorted, so a caller who only wants .data can stop paging at its end.
  const addresses = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const { console: fake, lines } = consoleServing(addresses);
  const res = await memChangedAllCapability.run(
    { maxAddress: '1010' },
    { console: fake, mem: {}, game: {}, log: () => {} },
  );
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(out.addresses.map(Number), addresses.filter((a) => a <= 1010));
  assert.equal(out.stoppedEarly, true);
  assert.ok(lines.length < 5, `expected early stop, made ${lines.length} calls`);
  ok('mem_changed_all stops paging once past maxAddress and says so');
}

// ---------------------------------------------------------------- compressSpan

{
  const bytes = new Uint8Array(4096);
  const out = compressSpan(bytes, 0x1000n);
  assert.deepEqual(out.runs, []);
  assert.equal(out.zeroBytes, 4096);
  assert.equal(out.allZero, true);
  ok('compressSpan reports an all-zero page as one fact, not 256 rows of zeros');
}

{
  const bytes = new Uint8Array(64);
  bytes[3] = 0xaa;
  bytes[4] = 0xbb;
  bytes[40] = 0x01;
  const out = compressSpan(bytes, 0x2000n);
  assert.equal(out.allZero, false);
  assert.equal(out.runs.length, 2);
  assert.equal(out.runs[0].address, '0x0000000000002003');
  assert.equal(out.runs[0].hex, 'AA BB');
  assert.equal(out.runs[1].address, '0x0000000000002028');
  assert.equal(out.runs[1].hex, '01');
  assert.equal(out.zeroBytes, 61);
  ok('compressSpan returns one run per island of non-zero bytes, with its own address');
}

{
  // A gap shorter than the join distance stays inside one run, so a struct with
  // interior zero fields is not shredded into a run per field.
  const bytes = new Uint8Array(32);
  bytes[0] = 1;
  bytes[3] = 2;
  const out = compressSpan(bytes, 0n, 4);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].hex, '01 00 00 02');
  ok('compressSpan joins non-zero bytes separated by less than the join distance');
}

// ---------------------------------------------------------------- mem_read_range

{
  const served = new Uint8Array(4096);
  const reads = [];
  const ctx = {
    mem: {
      async read(address, length) {
        reads.push({ address, length });
        return served.slice(0, length);
      },
    },
    console: { runLine: async () => ({}), describe: async () => ({}) },
    game: {},
    log: () => {},
  };
  const res = await memReadRangeCapability.run({ address: '4096', length: 4096 }, ctx);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.allZero, true);
  assert.equal(out.runs.length, 0);
  assert.equal(out.zeroBytes, 4096);
  assert.equal(reads.length, 1, 'the facade chunks internally; the capability asks once');
  assert.equal(reads[0].length, 4096);
  ok('mem_read_range answers a 4096-byte all-zero span in one call and no hex rows');
}

{
  const served = new Uint8Array(512);
  served[100] = 0x7f;
  const ctx = {
    mem: { async read(_a, length) { return served.slice(0, length); } },
    console: { runLine: async () => ({}), describe: async () => ({}) },
    game: {},
    log: () => {},
  };
  const res = await memReadRangeCapability.run({ address: '0x1000', length: 512 }, ctx);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].address, '0x0000000000001064');
  assert.equal(out.runs[0].hex, '7F');
  ok('mem_read_range accepts a 0x address and reports the run at its true address');
}

{
  const ctx = {
    mem: { async read() { throw new Error('mem.read 1 8 answered failed: nothing is mapped'); } },
    console: { runLine: async () => ({}), describe: async () => ({}) },
    game: {},
    log: () => {},
  };
  const res = await memReadRangeCapability.run({ address: '1', length: 8 }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /nothing is mapped/);
  ok('mem_read_range surfaces an unreadable range as an error carrying the endpoint reason');
}

console.log('mem-bulk-smoke: OK');
