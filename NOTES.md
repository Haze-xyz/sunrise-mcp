# Fix notes — first review round

This is a plain, non-task-numbered record of one review round and how it was addressed. Durable
design/architecture content (retry policy, testing approach, known limits) lives in `README.md`
instead — this file is the "what changed and why" history of that round.

## What the review found

Five Important findings, all confirmed real and fixed:

1. **The busy-accept race was a hard error, not a retry.** `connectNow()` made exactly one connect
   attempt and rejected; nothing retried it. Reproduced: connect-refused rejected in 3ms, and an
   accept-then-destroy ("busy") case rejected in 1ms — no retry at all. This mattered because the
   very first `console_run` after `game_launch` is precisely the case that needs a retry: the game's
   window can be up before `server::initialize` has bound the endpoint's listener.
2. **`close()` could leave a socket attached after it returned.** It didn't cancel an in-flight
   connect. Reproduced: calling `close()` while a connect was still inside its 250ms reconnect delay
   left the server holding a live socket 600ms later, taking the endpoint's one connection slot away
   from a client that believed it was shut down.
3. **The concurrency test couldn't fail for the property it claimed to prove.** The fake server
   answered in request order, so a FIFO-dispatch bug would satisfy the same assertions a correct
   id-based dispatch would. Confirmed by mutating the compiled client to dispatch by arrival order:
   the suite still passed 7/7.
4. **Nothing covered the 512-byte envelope guard**, the one constraint whose violation produces an
   uncorrelatable `id: 0` in the live game — the cheapest possible test to have been missing.
5. **`console_run`'s tool description omitted the line-length limit**, which a calling model can
   otherwise only discover by failing.

Plus four minors: `launch-game.ps1`'s `Write-Output` could get wrapped by PowerShell's formatter at
exactly the width a real error message hits; an unchecked `as EndpointStatus` cast where every other
wire-boundary read had a real guard; a hardcoded "18 entries" in `console_describe`'s description
that will rot; and `launchGame()`'s 90s timeout leaving only ~28s of headroom over the launch
script's own ~62s worst case.

## What changed

**`src/endpoint.ts`** — the substantial change. `sendRequest` now retries on a fresh connection
(via the same gap/backoff schedule `ensureConnected` already had) until the request's own
`requestTimeoutMs` is exhausted, gated by a new `connectionHasSucceeded` flag: retry when the
current connection has never completed a full round trip (nothing could have reached the game yet,
so re-sending is safe), hard-fail immediately once it has (the game may have already processed the
pending request — see README's "Retry policy" for the full reasoning). Wiring this through
`failAllPending` required snapshotting `this.pending` before clearing it, since a retried entry's
`onAttemptFailure` re-populates the map synchronously and a naive iterate-then-delete would have
deleted the fresh retry instead of the stale entry. `close()` now sets a terminal `closed` flag
checked in `ensureConnected`, after `connectNow`'s reconnect-delay wait, and inside its `onConnect`
handler, and awaits any in-flight connect before deciding what (if anything) is left to close.
`frame.status as EndpointStatus` became `toEndpointStatus()`, a real `Set`-backed guard falling back
to `'failed'` for anything unrecognized.

**`scripts/endpoint-smoke.mjs`** — grew from 7 to 12 cases: the concurrency test's fake server now
delays the *first* request's reply so replies arrive reversed (this is what makes it discriminate —
see README's "On testing dispatch correctness"); a new test asserts a 600-byte line is rejected
client-side and that the request count observed by the servers doesn't move; a new blanket
assertion runs after every other test, checking every request every fake server saw for a non-zero
numeric id, a ≤512-byte envelope, and no `\u` escape; two new tests reproduce findings 1 (a server
refusing connections until it starts listening late, and a server that accepts-then-destroys twice
before accepting for real) and one reproduces finding 2 (`close()` mid-reconnect-delay, asserting
the server ends with zero live sockets); every `test()` call now runs under an 8s watchdog, and the
script force-exits with the right code at the end, so a regression that hangs reports as a failure
instead of wedging the terminal.

**`src/game.ts`** — `parseLaunchOutput` now scans backwards from the end of stdout for the first
line that parses as the expected shape, instead of trusting the literal last line. `launchGame`'s
timeout raised to 180s (from 90s) with a comment on where the ~62s worst case comes from, and a
distinct failure message when Node's own timeout is what killed `powershell.exe` — noting
`destiny2.exe` runs detached and may still be alive regardless.

**`scripts/launch-game.ps1`** — `Write-Result` now writes via `[Console]::Out.WriteLine` instead of
`Write-Output`, bypassing PowerShell's success-stream formatter (and its line-wrapping) entirely.

**`src/index.ts`** — `console_run`'s description gained the line-length clause; `console_describe`'s
dropped the hardcoded entry count.

**Docs** — `NOTES-task7.md` (task-scoped) removed; its durable content folded into `README.md`
("Retry policy" and "Design notes and known limits" sections, plus an expanded testing section).
This file replaces it as the record of a specific review round, deliberately without task numbers,
so it stays legible after the originating plan document is gone.

## Verifying the fixes are real, not just present

**Finding 1** was proven with tests that fail without the fix, not just an argument:
`scripts/endpoint-smoke.mjs`'s "a request survives connect-refused..." and "a busy-accept..." tests
both fail (hang until their own watchdog trips) against the pre-fix, single-attempt `connectNow`.

**Finding 2's test is weaker than that, and it is worth being precise about what it actually
proves.** "close() during a connect still inside its reconnect delay..." asserts the server ends
with zero live sockets — and the fix landed as three separate guards (`ensureConnected`'s
closed-check, `connectNow`'s closed-check after the delay, and `onConnect`'s closed-check). A
second-round re-review measured that removing any *one* of those three guards alone still leaves
the test passing, because the other two independently prevent the same leak; only removing all
three at once makes it fail. So this test proves the end-to-end property (no leaked socket) holds
with the fix as a whole — it does not, and was never able to, attribute that property to any single
guard. The three-guard redundancy is a deliberate defense-in-depth choice, not a gap; just don't
read the passing test as evidence that each guard is individually load-bearing.

**Finding 3's fix was checked against the specific failure mode it was fixing**, not just re-run:

```
$ node scripts/endpoint-smoke.mjs        # with a FIFO-dispatch mutant applied to dist/endpoint.js
PASS  normal request/response
FAIL  two requests in flight resolve to the right ids, even when replies arrive out of order
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  [
    {
      key: 'echo',
+     value: 'concurrent.b'
-     value: 'concurrent.a'
    }
  ]
PASS  reply split across two TCP writes
... (10 of 12 still pass; only the concurrency test catches this mutant)
11/12 passed
```

The mutant (dispatch by `this.pending.keys().next().value` — oldest inserted — instead of by
`parsed.id`) was applied directly to the compiled `dist/endpoint.js`, never to `src/`, and reverted
by rebuilding (`npm run build`) before continuing. A rebuild-vs-backup diff confirmed the restored
`dist/endpoint.js` was byte-identical to the pre-mutant build.

## Full verification, clean room

```
$ rm -rf dist node_modules
$ npm install
added 96 packages, and audited 97 packages in 1s
found 0 vulnerabilities

$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(zero output)

$ npm run build
> tsc -p tsconfig.json
(zero output)

$ npm run test:endpoint
> npm run build && node scripts/endpoint-smoke.mjs
main fake endpoint listening on 127.0.0.1:39745
PASS  normal request/response
PASS  two requests in flight resolve to the right ids, even when replies arrive out of order
PASS  reply split across two TCP writes
PASS  reply larger than one TCP segment
PASS  id: 0 reply is surfaced, not matched to any request, and the real request times out
PASS  client-side timeout when the endpoint never answers
PASS  an over-long line is rejected client-side and never reaches the socket
PASS  dropped connection rejects the in-flight request once already proven, then the next call reconnects
PASS  a request survives connect-refused while the endpoint is not up yet, then succeeds once it is
PASS  a busy-accept (accepted then immediately destroyed) is retried until a real accept goes through
PASS  close() during a connect still inside its reconnect delay leaves the server with zero live sockets
PASS  every one of the 12 requests observed satisfied the wire-protocol constraints
12/12 passed
```

`grep -rn "\bany\b\|@ts-ignore\|@ts-nocheck\|@ts-expect-error" src/` still returns only the English
word "any" inside prose comments/descriptions — no type escapes, no suppression directives.

No MSBuild, no game, nothing under `/mnt/e/` touched — all of the above ran under WSL node.

## Steps 2 and 4: now done (superseded by the section below)

The rest of this file predates Steps 2 and 4 actually running. They have since been run against
the live game by the person at the keyboard — see "Second review round" below for what came back
and what changed as a result. `README.md`'s "Verified against the live game" section has the
durable summary of the results themselves.

## Second review round

Steps 2 and 4 both passed against the live, running game: a 16-check live round trip through
`endpoint.ts` directly (`scripts/smoke.mjs`, written at the keyboard and handed over to be owned
here) in 0.22s, and the full five-tool stdio round trip — `game_launch` → `console_describe` →
`console_run` write → `console_run` read-back → `log_read` → `game_kill` — in 20.9s, with
`movement.json` on disk confirming the write actually persisted. Layer 1's end criterion is met.
That run surfaced two things and four small cleanup items.

**What the live run surfaced:**

- The retry logic added in the first review round (Finding 1) was never actually exercised:
  `game_launch`'s window-wait already outlasts the endpoint's bind time, so every `console_run` in
  practice finds it already listening. The fix is still worth keeping — insurance for a faster
  launch path later — but claiming it as load-bearing today would be dishonest. `README.md`'s
  "Retry policy" section now says so plainly.
- `game_kill` logged `endpoint connection error: read ECONNRESET` on shutdown — the client
  correctly noticing the game died, but a deliberate kill causing that is expected, not an error
  worth surfacing to whatever is reading stderr.

**What changed:**

- **Owned and strengthened `scripts/smoke.mjs`.** Two of its checks were weaker than they looked:
  the client-side over-long-line guard only checked that *some* error was thrown, which would also
  pass if the guard were deleted and the line were sent to the game and refused for an unrelated
  reason — now checks the specific error type (`EndpointRequestTooLargeError`) and that it resolved
  in under 50ms, since a real round trip to the game would not be that fast. The script also used
  to leave `movement.fly_speed` at whatever test value it last set — now restores it to the value it
  read at the start, in a `finally` block, so running the smoke test doesn't quietly change the
  game's settings. Added `npm run smoke`, and rewrote the header so "needs a running game" and
  "needs Windows node" are impossible to miss (the WSL failure mode here is a silent hang, not an
  error — worth stating plainly rather than assuming the WSL section elsewhere in the README gets
  read first). Committed as the Step 2 deliverable the plan asks for.
- **Quieted the intentional kill.** `src/index.ts` now has `expectDisconnectBriefly()`, called at
  the top of the `game_kill` handler: it records a short (5s) window during which exactly one
  `connectionError` is swallowed instead of logged. Chose this over closing the endpoint client
  before killing, because `close()` is terminal — closing the shared client on every `game_kill`
  would break reconnection after the *next* `game_launch`, defeating the whole point of the
  reconnect design (an agent session surviving a game restart). A flag the error handler consults
  keeps the client reusable across kill/relaunch cycles while still not swallowing errors that
  aren't caused by an intentional kill.
- **Replaced the two `task-7-brief.md` references in `src/endpoint.ts`** (lines 9 and 21) with
  either the substance or a `README.md` pointer — the same defect as the commit subject fixed in the
  first round, missed in that sweep. `task-7-brief.md` lives in `sunrise-console`'s plan directory
  and won't survive the plan being finished.
- **Made `close()` actually fast, instead of documenting around the fact that it wasn't.** The
  second-round re-review measured `close()` taking ~3.5s of a 4s backoff step, because
  `connectNow`'s `await delay(waitMs)` had no cancellation path — the "stops"/"cancels" language in
  `README.md` and the first-round `NOTES.md` was aspirational, not yet true. Fixed the code instead
  of softening the docs: `close()` now aborts an `AbortController` that both the reconnect-delay
  sleep (`node:timers/promises`' `setTimeout` with `{ signal }`) and the TCP connect attempt
  (`createConnection`'s own `signal` option) are wired to, so both are interrupted immediately
  rather than left to finish on their own schedule. `scripts/endpoint-smoke.mjs`'s close-during-delay
  test now also asserts `close()` resolves in under 100ms (previously it only asserted the eventual
  socket count), which is the regression check for this specific fix.
- **Corrected `NOTES.md`'s claim about what the close-during-delay test proves** — see the "second
  review round" correction above the "Steps 2 and 4" heading in this file. It proves the guards
  work together, not that each is individually pinned.

**Verification (all local, no game, no MSBuild — the author stepped away and the game is closed):**

```
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(zero output)

$ npm run build
> tsc -p tsconfig.json
(zero output)

$ npm run test:endpoint
> npm run build && node scripts/endpoint-smoke.mjs
main fake endpoint listening on 127.0.0.1:36745
PASS  normal request/response
PASS  two requests in flight resolve to the right ids, even when replies arrive out of order
PASS  reply split across two TCP writes
PASS  reply larger than one TCP segment
PASS  id: 0 reply is surfaced, not matched to any request, and the real request times out
PASS  client-side timeout when the endpoint never answers
PASS  an over-long line is rejected client-side and never reaches the socket
PASS  dropped connection rejects the in-flight request once already proven, then the next call reconnects
PASS  a request survives connect-refused while the endpoint is not up yet, then succeeds once it is
PASS  a busy-accept (accepted then immediately destroyed) is retried until a real accept goes through
PASS  close() during a connect still inside its reconnect delay leaves the server with zero live sockets
PASS  every one of the 12 requests observed satisfied the wire-protocol constraints
12/12 passed
```

Ran three more times back to back to check the new timing assertion (close() < 100ms) wasn't
flaky under WSL's scheduling — 12/12 every time.

`scripts/smoke.mjs` was **not** run this round, per instruction: the game is closed and the author
stepped away. Its content was reviewed, strengthened, and typechecked-by-reading only; its own
prerequisites (running game, Windows node) mean it can only actually be exercised the way
`scripts/endpoint-smoke.mjs` was exercised here.
