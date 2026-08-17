#!/usr/bin/env node
/**
 * Drives SunriseEndpointClient (dist/endpoint.js) against small fake TCP servers that speak the
 * exact line protocol the real Sunrise console endpoint speaks — no mocks, real sockets. This is
 * what lets endpoint.ts be proven correct without the game: it knows nothing about MCP, so a
 * ten-line server is enough to exercise it.
 *
 * Run after `npm run build`:
 *   node scripts/endpoint-smoke.mjs
 * or just:
 *   npm run test:endpoint
 *
 * Covers: a normal request/response, two requests in flight resolving to the right ids (proven
 * against a server that answers out of order, so a FIFO-dispatch mutant actually fails this), a
 * reply split across two TCP writes, a reply larger than one TCP segment, an id: 0 reply, a
 * client-side timeout, a dropped connection followed by an automatic reconnect, an over-long line
 * rejected before it ever reaches the socket, a connect that only succeeds after the endpoint's
 * listener comes up late, a busy-accept (accepted then immediately destroyed) retried until a real
 * accept goes through, close() during a connect that's still inside its reconnect delay, and a
 * blanket check that every request every fake server saw obeyed the wire-protocol constraints
 * (non-zero numeric id, <=512 bytes, no \u escapes).
 *
 * Every fake server binds an ephemeral port (never 127.0.0.1:30975, the real endpoint's port), so
 * this can never be confused with a live game instance.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import {
  SunriseEndpointClient,
  EndpointTimeoutError,
  EndpointConnectionError,
  EndpointRequestTooLargeError,
} from '../dist/endpoint.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms)),
  ]);
}

function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Wire-protocol assertions applied to every request any fake server in this file receives, on
// every test. This is what pins the 512-byte guard, the non-zero-numeric-id rule, and the
// no-\u-escapes rule as regression checks across the whole suite, not just their own tests.
// ---------------------------------------------------------------------------

/** @type {{ raw: string; violations: string[] }[]} */
const protocolViolations = [];
let requestsObservedByServers = 0;

function recordAndParse(raw) {
  requestsObservedByServers += 1;
  const violations = [];
  const byteLength = Buffer.byteLength(raw, 'utf8') + 1; // +1 for the newline this line arrived with.
  if (byteLength > 512) violations.push(`envelope was ${byteLength} bytes, over the 512-byte limit`);
  if (/\\u[0-9a-fA-F]{4}/.test(raw)) violations.push('contained a \\u escape');

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    violations.push(`was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed !== null && (typeof parsed.id !== 'number' || parsed.id === 0)) {
    violations.push(`id was not a non-zero number (got ${JSON.stringify(parsed.id)})`);
  }

  if (violations.length > 0) {
    protocolViolations.push({ raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw, violations });
  }
  return parsed;
}

/** A fake endpoint server: one JSON object per line, in and out, same framing as the real thing. */
function makeLineServer(onRequest) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let nl;
      while ((nl = buffer.indexOf(0x0a)) !== -1) {
        const raw = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        const parsed = recordAndParse(raw);
        if (parsed !== null) onRequest(socket, parsed, raw);
      }
    });
  });
}

function writeLine(socket, obj) {
  socket.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// The main fake server, covering the request/response shapes used by most of the suite.
// ---------------------------------------------------------------------------

const mainServer = makeLineServer((socket, req) => {
  switch (req.line) {
    case 'trigger.timeout':
      // Never respond. The client's own timeout must fire.
      return;

    case 'trigger.dropconnection':
      // Simulate a game crash/restart: close without ever answering this request.
      socket.destroy();
      return;

    case 'trigger.idzero':
      // Simulate the endpoint's own "id: 0" failure class (over-long envelope / unparseable
      // request). Deliberately does NOT use req.id, so the real request is left hanging (it must
      // time out client-side) while this unmatchable frame is surfaced separately.
      writeLine(socket, { id: 0, status: 'badArgument', summary: 'The request line is longer than the endpoint accepts.', rows: [] });
      return;

    case 'concurrent.a':
      // Deliberately answered *after* concurrent.b, so replies arrive in the opposite order to
      // requests. A client that dispatched by arrival order (FIFO) instead of by id would hand
      // this reply to whichever call happened to be resolved first — see the "two requests in
      // flight" test, and the mutant-proof step in NOTES-fixes.md.
      setTimeout(() => {
        writeLine(socket, { id: req.id, status: 'ok', summary: '', rows: [{ key: 'echo', value: 'concurrent.a' }] });
      }, 150);
      return;

    case 'split.write': {
      // Write the reply in two separate TCP writes, with a delay, to prove the client reassembles
      // a frame split across multiple socket writes/segments.
      const payload = JSON.stringify({ id: req.id, status: 'ok', summary: '', rows: [{ key: 'split.write', value: true }] });
      const mid = Math.floor(payload.length / 2);
      socket.write(payload.slice(0, mid));
      setTimeout(() => socket.write(`${payload.slice(mid)}\n`), 20);
      return;
    }

    default:
      if (req.describe === true) {
        // A describe reply well over one TCP segment (~1500 bytes on loopback), to prove the
        // client keeps buffering until the newline even when the frame spans many chunks. This
        // mirrors the real endpoint: a describe reply can be a few KB and in principle up to 128 KB.
        const entries = [];
        for (let i = 0; i < 4000; i++) {
          entries.push({ name: `movement.synthetic_${i}`, kind: 'variable', help: 'Synthetic entry for the large-reply smoke test, padded to push this response past one TCP segment.' });
        }
        writeLine(socket, { id: req.id, status: 'ok', entries });
        return;
      }
      writeLine(socket, { id: req.id, status: 'ok', summary: '', rows: [{ key: 'echo', value: req.line }] });
  }
});

// ---------------------------------------------------------------------------
// Tiny test runner, with a watchdog per test so a hang reports as a failure instead of wedging
// the whole script (and a forced exit at the end for the same reason).
// ---------------------------------------------------------------------------

const TEST_WATCHDOG_MS = 8000;

/** @type {{ name: string; ok: boolean; error?: string }[]} */
const results = [];

async function test(name, fn) {
  try {
    await withTimeout(fn(), TEST_WATCHDOG_MS, `test '${name}'`);
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

async function main() {
  const mainPort = await listen(mainServer);
  console.log(`main fake endpoint listening on 127.0.0.1:${mainPort}`);

  const client = new SunriseEndpointClient({ host: '127.0.0.1', port: mainPort, requestTimeoutMs: 2000 });

  await test('normal request/response', async () => {
    const res = await client.runLine('normal.request');
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.rows, [{ key: 'echo', value: 'normal.request' }]);
  });

  await test('two requests in flight resolve to the right ids, even when replies arrive out of order', async () => {
    // concurrent.a is answered ~150ms after concurrent.b (see mainServer above), reversing the
    // reply order relative to the request order. A dispatch-by-arrival-order (FIFO) bug would
    // hand concurrent.b's reply to whichever call resolves first and fail this assertion.
    const [a, b] = await Promise.all([client.runLine('concurrent.a'), client.runLine('concurrent.b')]);
    assert.deepEqual(a.rows, [{ key: 'echo', value: 'concurrent.a' }]);
    assert.deepEqual(b.rows, [{ key: 'echo', value: 'concurrent.b' }]);
  });

  await test('reply split across two TCP writes', async () => {
    const res = await client.runLine('split.write');
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.rows, [{ key: 'split.write', value: true }]);
  });

  await test('reply larger than one TCP segment', async () => {
    const res = await client.describe();
    assert.equal(res.status, 'ok');
    assert.equal(res.entries.length, 4000);
    assert.equal(res.entries[3999].name, 'movement.synthetic_3999');
  });

  await test('id: 0 reply is surfaced, not matched to any request, and the real request times out', async () => {
    /** @type {import('../dist/endpoint.js').EndpointUnmatchedResponseError[]} */
    const unmatched = [];
    const onUnmatched = (err) => unmatched.push(err);
    client.on('unmatchedResponse', onUnmatched);
    try {
      await assert.rejects(() => client.runLine('trigger.idzero'), (err) => {
        assert.ok(err instanceof EndpointTimeoutError, `expected EndpointTimeoutError, got ${err}`);
        return true;
      });
      assert.equal(unmatched.length, 1);
      assert.match(unmatched[0].message, /id: 0/);
    } finally {
      client.off('unmatchedResponse', onUnmatched);
    }
  });

  await test('client-side timeout when the endpoint never answers', async () => {
    await assert.rejects(() => client.runLine('trigger.timeout'), (err) => {
      assert.ok(err instanceof EndpointTimeoutError, `expected EndpointTimeoutError, got ${err}`);
      return true;
    });
  });

  await test('an over-long line is rejected client-side and never reaches the socket', async () => {
    const before = requestsObservedByServers;
    const longLine = `movement.fly_speed ${'x'.repeat(600)}`;
    await assert.rejects(() => client.runLine(longLine), (err) => {
      assert.ok(err instanceof EndpointRequestTooLargeError, `expected EndpointRequestTooLargeError, got ${err}`);
      return true;
    });
    await delay(50); // give a (buggy) send a chance to have arrived before we check.
    assert.equal(requestsObservedByServers, before, 'the over-long request must never reach a socket');
  });

  await test('dropped connection rejects the in-flight request once already proven, then the next call reconnects', async () => {
    // The connection has already answered several requests above, so connectionHasSucceeded is
    // true: this drop must NOT be silently retried (the game might have processed it already).
    await assert.rejects(() => client.runLine('trigger.dropconnection'), (err) => {
      assert.ok(err instanceof EndpointConnectionError, `expected EndpointConnectionError, got ${err}`);
      return true;
    });
    // The fake server is still listening; the next call must open a fresh connection and succeed.
    const res = await client.runLine('after.reconnect');
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.rows, [{ key: 'echo', value: 'after.reconnect' }]);
  });

  await client.close();
  mainServer.close();

  // -------------------------------------------------------------------------
  // Finding 1: connect-phase failures must be retried until the request's own timeout, not
  // surfaced as an immediate hard error. Two distinct causes, proven separately.
  // -------------------------------------------------------------------------

  await test('a request survives connect-refused while the endpoint is not up yet, then succeeds once it is', async () => {
    // Mirrors game_launch returning before server::initialize has bound the endpoint's listener:
    // grab a port, make sure nothing is listening on it, send a request, and only start the real
    // server after a couple of connect-refused attempts have already happened.
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const lateClient = new SunriseEndpointClient({
      host: '127.0.0.1',
      port,
      requestTimeoutMs: 4000,
      minReconnectDelayMs: 50,
      reconnectBackoffMs: [50, 100, 100],
    });
    const resultPromise = lateClient.runLine('ready.check');

    await delay(300); // let at least a couple of connect-refused attempts happen first.
    const lateServer = makeLineServer((socket, req) => {
      writeLine(socket, { id: req.id, status: 'ok', summary: '', rows: [{ key: 'echo', value: req.line }] });
    });
    await listen(lateServer, port);

    const res = await resultPromise;
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.rows, [{ key: 'echo', value: 'ready.check' }]);

    await lateClient.close();
    lateServer.close();
  });

  await test('a busy-accept (accepted then immediately destroyed) is retried until a real accept goes through', async () => {
    // Mirrors the endpoint's stage=accept result=busy race: the first couple of connections are
    // accepted and torn down instantly, with nothing ever read from them.
    let busyCount = 0;
    const busyServer = net.createServer((socket) => {
      if (busyCount < 2) {
        busyCount += 1;
        socket.destroy();
        return;
      }
      // Third time: behave like a normal fake endpoint.
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let nl;
        while ((nl = buffer.indexOf(0x0a)) !== -1) {
          const raw = buffer.subarray(0, nl).toString('utf8');
          buffer = buffer.subarray(nl + 1);
          const req = recordAndParse(raw);
          if (req !== null) writeLine(socket, { id: req.id, status: 'ok', summary: '', rows: [{ key: 'echo', value: req.line }] });
        }
      });
    });
    const port = await listen(busyServer);

    const busyClient = new SunriseEndpointClient({
      host: '127.0.0.1',
      port,
      requestTimeoutMs: 4000,
      minReconnectDelayMs: 30,
      reconnectBackoffMs: [30, 60, 60],
    });

    const res = await busyClient.runLine('busy.check');
    assert.equal(res.status, 'ok');
    assert.equal(busyCount, 2, 'expected exactly two busy accept-then-destroy cycles before the real one');

    await busyClient.close();
    busyServer.close();
  });

  // -------------------------------------------------------------------------
  // Finding 2: close() must cancel a connect that's still inside its reconnect delay, rather than
  // letting it land later and take the endpoint's single connection slot out from under a client
  // that believes it's shut down.
  // -------------------------------------------------------------------------

  await test('close() during a connect still inside its reconnect delay leaves the server with zero live sockets', async () => {
    /** @type {Set<net.Socket>} */
    const serverSockets = new Set();
    const captureServer = net.createServer((socket) => {
      serverSockets.add(socket);
      socket.on('close', () => serverSockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let nl;
        while ((nl = buffer.indexOf(0x0a)) !== -1) {
          const raw = buffer.subarray(0, nl).toString('utf8');
          buffer = buffer.subarray(nl + 1);
          const req = recordAndParse(raw);
          if (req !== null) writeLine(socket, { id: req.id, status: 'ok', summary: '', rows: [] });
        }
      });
    });
    const port = await listen(captureServer);

    const closingClient = new SunriseEndpointClient({
      host: '127.0.0.1',
      port,
      requestTimeoutMs: 5000,
      minReconnectDelayMs: 300,
      reconnectBackoffMs: [300],
    });

    // Establish a first connection, then force it closed so lastCloseAt is set and the *next*
    // connect attempt has to wait out the full 300ms minReconnectDelayMs.
    await closingClient.runLine('warm.up');
    assert.equal(serverSockets.size, 1);
    for (const s of serverSockets) s.destroy();
    await delay(50); // let the client observe the close.

    // Kick off a new request: this starts a reconnect that must sit in its 300ms delay. We don't
    // care how it resolves (it will be rejected by the close below) — just that it doesn't crash.
    const pending = closingClient.runLine('after.close').catch(() => undefined);
    await delay(50); // make sure we're inside the delay window, not before it started.
    await closingClient.close();

    await delay(500); // well past minReconnectDelayMs — enough time for a leaked connect to land.
    assert.equal(serverSockets.size, 0, 'a socket connected to the server after close() was called');

    await pending;
    captureServer.close();
  });

  // -------------------------------------------------------------------------
  // Blanket check: every request every fake server in this file saw, across every test above,
  // satisfied the wire-protocol constraints. Pins the 512-byte guard, the non-zero-numeric-id
  // rule, and the no-\u-escapes rule for free on every test, not just their own.
  // -------------------------------------------------------------------------

  await test(`every one of the ${requestsObservedByServers} requests observed satisfied the wire-protocol constraints`, async () => {
    assert.deepEqual(protocolViolations, []);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
