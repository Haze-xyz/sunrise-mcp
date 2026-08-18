# sunrise-mcp

MCP server for the Sunrise console endpoint. Layer 1 of the Sunrise MCP project: a TypeScript
client for the endpoint's line protocol, plus five MCP tools built on top of it.

This repo is private. It is not published anywhere and has no remote configured — keep it that
way.

## Read this before running anything: this server must run under Windows node.exe

You can `npm install`, `npm run build`, and `npm run typecheck` from WSL — that's ordinary
TypeScript, and this README was written from WSL. But **running** `dist/index.js` — actually
talking to the game — only works under `C:\nvm4w\nodejs\node.exe` (or whatever Windows Node you
have), never under WSL node. This is a Windows networking fact, not a preference:

- WSL runs in NAT mode on this machine. A process's `127.0.0.1` inside WSL is the WSL VM's own
  loopback interface, **not** the Windows host's. The Sunrise game binds `INADDR_LOOPBACK` on the
  Windows side, so a WSL process can never reach it, full stop.
- If you run this server under WSL node and point it at the endpoint, you will see one of two
  things, neither of which is a bug in this code: a **connection refused** (nothing is listening on
  the WSL VM's loopback at that port), or, if something else happens to be listening there, a
  **silent hang** — the TCP connection succeeds against the wrong host, so every request just sits
  there until this client's own request timeout fires.
- The same applies to `game_launch` (starts `destiny2.exe`), `game_kill` (`taskkill`), and
  `log_read` (reads an `E:\...` path) — none of those exist from inside WSL either.

So: point your MCP client (Claude Desktop, an agent harness, whatever) at
`C:\nvm4w\nodejs\node.exe C:\path\to\sunrise-mcp\dist\index.js`, not at a WSL node binary.

## Configuration

Everything is env vars, with Windows-appropriate defaults — nothing here is WSL-specific:

| Variable | Default | Meaning |
|---|---|---|
| `SUNRISE_ENDPOINT_HOST` | `127.0.0.1` | Host the console endpoint listens on. |
| `SUNRISE_ENDPOINT_PORT` | `30975` | Port the console endpoint listens on. |
| `SUNRISE_GAME_DIR` | `E:\Destiny_Sunrise` | Game install directory. `destiny2.exe` and the log both live under here. |

## The five tools

| Tool | Input | Output |
|---|---|---|
| `console_run` | `line: string` | The endpoint's structured response: `status`, `summary`, `rows`. |
| `console_describe` | — | The full command/variable registry. |
| `game_launch` | — | Starts `destiny2.exe` (killing any existing instance first) and waits for its window. |
| `game_kill` | — | `taskkill /IM destiny2.exe /F`. Safe to call when the game isn't running. |
| `log_read` | `lines?: number` | The tail of `sunrise.log` (default 200 lines, capped at 1000). |

Two things worth knowing before you drive this from an agent:

- **The endpoint answers from the title screen**, before the player presses anything. You do not
  need to wait for a load after `game_launch` resolves — `console_run` and `console_describe` work
  immediately.
- **`console_run` cannot get past the title screen.** The game currently stops at a
  `PRESS ENTER TO PLAY` screen, and layer 1's registry has no key-input primitive — all 18 entries
  are `console.*`, `log.*`, `movement.*`, and `player.infinite_ammo`. Getting past the title screen
  is layer 2's job.

## Building

```
npm install
npm run build       # tsc -p tsconfig.json, emits dist/
npm run typecheck   # tsc --noEmit, same strictness, no emit
```

Strict TypeScript throughout: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
no `any`, no `@ts-ignore`.

## Testing endpoint.ts without the game

`src/endpoint.ts` deliberately knows nothing about MCP — it's a plain TCP client keyed by request
`id`. That's what makes it testable without the game: `scripts/endpoint-smoke.mjs` stands up small
fake servers on ephemeral local ports that speak the exact same line protocol, and drives the real
compiled client against them over real sockets (no mocks).

```
npm run test:endpoint   # builds, then runs scripts/endpoint-smoke.mjs
```

It covers: a normal request/response; two requests in flight resolving to the right ids (proven
against a server that answers the *first* request last, so a dispatch-by-arrival-order bug — not
just a dispatch-by-id one — would actually fail this: see "On testing dispatch correctness" below);
a reply split across two TCP writes; a reply larger than one TCP segment; an `id: 0` reply; a
client-side timeout; an over-long line rejected before it ever reaches a socket; a dropped
connection rejected (not silently retried) once the connection has already proven itself, followed
by an automatic reconnect; a connect that only succeeds once the endpoint's listener comes up late;
a busy-accept retried until a real accept goes through; `close()` during a connect that's still
inside its reconnect delay, leaving zero live sockets on the server; and a blanket check that every
request every fake server saw obeyed the wire protocol (non-zero numeric id, ≤512 bytes, no `\u`
escapes). Every test runs under its own watchdog, and the whole script force-exits at the end, so a
regression that hangs reports as a failure instead of wedging CI or a terminal.

None of it touches `127.0.0.1:30975` — every fake server binds an ephemeral port, so it can't be
confused with a real game instance.

This script is committed (not thrown away) because it is the whole reason `endpoint.ts` is a
separate file from the MCP wiring in `index.ts`, and because it costs nothing to keep as a
regression check the next time this file changes.

### On testing dispatch correctness

A test that asserts two concurrent requests each resolve to their own value can pass for the wrong
reason if the fake server happens to answer in request order — a client that dispatched replies by
arrival order (FIFO) instead of by `id` would satisfy that assertion too. The fix isn't a smarter
assertion, it's a fake server that answers out of order: `concurrent.a`'s reply is delayed behind
`concurrent.b`'s. That is what makes the test discriminate. This was checked directly: with a
FIFO-dispatch mutant applied to the compiled client, the reordered-reply version of this test
fails (and only this test — everything else still passes), then passes again once the mutant is
reverted. Worth remembering next time a "concurrent" test is added anywhere in this repo.

## Testing against a live game

`scripts/smoke.mjs` is the live counterpart to `scripts/endpoint-smoke.mjs`: the same shape of
checks, but through `endpoint.ts` against the actual running game instead of a fake server. Unlike
everything else in this repo, it needs both a running game and Windows node — read its header
before running it, or see the WSL warning at the top of this README.

```
npm run smoke   # builds, then runs scripts/smoke.mjs — needs the game running, Windows node.exe
```

It covers describe (registry size, `movement.fly_speed`'s numeric bounds), read, write, read-back,
`outOfRange` (and confirms the refused write left the value unchanged), `unknownName`,
`badArgument`, the client-side over-long-line guard (checking the specific error type and that it
resolved in under 50ms, not after a round trip), and two concurrent requests resolving to their own
rows. It restores `movement.fly_speed` to whatever it read at the start before exiting, so running
it doesn't leave the game's settings different from how it found them.

## Wire protocol (for reference)

One JSON object per line, `\n`-terminated, both directions:

```
-> {"id":1,"line":"movement.fly_speed 55"}
<- {"id":1,"status":"ok","summary":"","rows":[{"key":"movement.fly_speed","value":55}]}

-> {"id":2,"describe":true}
<- {"id":2,"status":"ok","entries":[{"name":"...","kind":"...","help":"..."}]}
```

`status` is always one of `ok`, `unknownName`, `wrongArgumentCount`, `badArgument`, `outOfRange`,
`refused`, `failed` — a name, never a number.

Constraints `endpoint.ts` has to respect, each the reason for something in the code:

- **One connection at a time.** A second is accepted then immediately closed by the endpoint.
- **`id` must be a non-zero JSON number.** Zero means "absent".
- **No server-side timeout, anywhere.** `endpoint.ts` enforces its own per-request timeout
  (`requestTimeoutMs`, default 10s) and rejects the pending promise when it fires.
- **512-byte max request envelope.** Rejected client-side with `EndpointRequestTooLargeError`
  before ever touching the socket, rather than sent and coming back as an uncorrelatable `id: 0`.
- **`id: 0` replies happen** for an over-long envelope or a request so malformed no id could be
  parsed. They can never be matched to a specific pending request, so they're surfaced via an
  `unmatchedResponse` event instead of being dropped or resolving the wrong promise.
- **Reconnecting immediately after a close can race the endpoint's own cleanup** of the old
  connection slot (logged on the game side as `stage=accept result=busy`). `endpoint.ts` enforces a
  minimum gap after any close, plus increasing backoff after repeated connect failures, before
  trying again.

## Retry policy

A request whose connection attempt fails, or whose connection is closed before the socket has ever
completed a single full round trip, is retried on a fresh connection until the request's own
`requestTimeoutMs` is exhausted — using the gap/backoff schedule above between attempts. This is
what lets `console_run` recover from being called the instant `game_launch` resolves: the game's
window can be up before `server::initialize` has actually bound the endpoint's listener, so the
very first request after a launch is exactly the case that needs a retry, not a hard error. The
same retry covers the busy-connection-slot race: an accept-then-immediate-close never delivers
anything to the game, so re-sending on the next connection is safe.

Once a connection has completed at least one real response, though, a later drop is **not** retried
automatically — the game may already have processed whatever was still in flight, and silently
re-sending a console line risks running it twice. That failure is surfaced immediately instead of
retried. The distinction is a single per-connection flag (`connectionHasSucceeded`), reset on every
fresh socket and set the moment any response is matched to a pending request.

`close()` is terminal: it stops any connect still waiting out its reconnect delay or mid-handshake
— via an `AbortController`, so it interrupts an in-progress wait rather than merely checking a flag
once the wait finishes on its own — rather than letting it land later and silently take the
endpoint's one connection slot. It resolves in milliseconds, not after however much of the
gap/backoff delay happened to be left. The client never reconnects again afterward; construct a new
`SunriseEndpointClient` if you need the endpoint again.

**Honesty check on when this actually matters:** the retry path above has not been exercised by the
real `game_launch` → `console_run` flow. `game_launch`'s window-wait (see `scripts/launch-game.ps1`)
already outlasts the time the endpoint's listener takes to bind, so by the time an agent's first
`console_run` arrives, the endpoint is already up — the retry loop's connect-refused branch has
never actually fired in practice. Keep it anyway: it's insurance against a faster launch path
later (or a different game/endpoint startup order), not something load-bearing today. The
busy-accept branch is likewise unexercised live — nothing in the current flow ever opens a second
connection while one is active.

## Design notes and known limits

- **Id reuse.** `nextRequestId()` cycles through 1..2³¹-1 and back, skipping any id still pending.
  A stale, very-late response landing on a long-since-reused id is theoretically possible but needs
  billions of prior requests plus adversarial timing; not worth a monotonic-forever counter for an
  agent-driven console client.
- **Defaults are judgment calls, not tightly tuned values**: `requestTimeoutMs` (10s), the
  reconnect backoff schedule, and `log_read`'s 2 MiB tail-read cap were chosen for plausibility, not
  measured against the real endpoint — though the one real data point available (a full 16-check
  round trip against the live game completing in 0.22s) suggests the 10s timeout has enormous
  headroom for normal use, and is really only there to bound a genuinely stuck request.
- **`game_kill` quiets the connection error it causes.** Killing the game while a connection is open
  produces an expected `ECONNRESET`; `index.ts` tells the `connectionError` handler to swallow the
  *next* one after a `game_kill` call (within a short window), so a deliberate shutdown doesn't
  print something that reads as an unexpected error. Every other connection error still logs
  normally — see the comment above `expectDisconnectBriefly` in `src/index.ts`.

### Verified against the live game

Both endpoint.ts (directly, via `scripts/smoke.mjs`) and the full five-tool stdio round trip (via
an MCP client) have now been run against the real, running game — see `NOTES.md` for the session
that did it. In summary: a 16-check live round trip (registry with 18 entries and numeric bounds,
read, write, read-back, `outOfRange` with the value provably unchanged, `unknownName`,
`badArgument`, the client-side over-long guard refusing before anything reached the socket, two
concurrent requests resolving to their own rows) passed in 0.22s; and the full agent-shaped
sequence — `game_launch` (window up, pid reported) → `console_describe` → `console_run` write →
`console_run` read-back → `log_read` (real log content) → `game_kill` — passed end to end in
20.9s, including `launchGame()`'s PowerShell JSON parsing working on the first try. Not yet
exercised: the retry-on-connect-failure path (see "Retry policy" above), and anything layer 2's
key-input primitive would unlock past the title screen.

## Project layout

- `src/endpoint.ts` — the endpoint client. No MCP import here, on purpose.
- `src/game.ts` — Windows-side game process and log helpers (`game_launch`, `game_kill`,
  `log_read`), used by `index.ts`.
- `src/index.ts` — the MCP server: five tools over stdio, wiring `endpoint.ts` and `game.ts`
  together.
- `scripts/launch-game.ps1` — launch + window-wait, adapted from
  `a local capture script` (same kill-existing /
  `Start-Process -PassThru` / poll-`MainWindowHandle` shape; the capture/dump/close steps that
  script also does are dropped, since `game_launch` wants the game left running).
- `scripts/endpoint-smoke.mjs` — the fake-server test for `endpoint.ts` described above.
- `scripts/smoke.mjs` — the live-game counterpart, described in "Testing against a live game".
