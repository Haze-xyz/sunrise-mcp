# sunrise-mcp

MCP server for the Sunrise console endpoint. Layer 1 built a TypeScript client for the endpoint's
line protocol plus five MCP tools on top of it; layer 2 (in progress) is adding what layer 1 could
not do from outside the game process, starting with getting past the title screen (`game_enter`).

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

## The six tools

| Tool | Input | Output |
|---|---|---|
| `console_run` | `line: string` | The endpoint's structured response: `status`, `summary`, `rows`. |
| `console_describe` | — | The full command/variable registry. |
| `game_launch` | — | Starts `destiny2.exe` (killing any existing instance first) and waits for its window. |
| `game_kill` | — | `taskkill /IM destiny2.exe /F`. Safe to call when the game isn't running. |
| `log_read` | `lines?: number` | The tail of `sunrise.log` (default 200 lines, capped at 1000). |
| `game_enter` | — | Launches if needed, gets past the title screen, and waits for the world to load. Leaves the game at character selection. |

Two things worth knowing before you drive this from an agent:

- **The endpoint answers from the title screen**, before the player presses anything. You do not
  need to wait for a load after `game_launch` resolves — `console_run` and `console_describe` work
  immediately.
- **`console_run` alone cannot get past the title screen** — its registry (`console.*`, `log.*`,
  `movement.*`, `player.infinite_ammo`) has no key-input primitive of its own. Use `game_enter` for
  that; see "Getting past the title screen" below for how it works and why.

## Getting past the title screen (`game_enter`)

`game_enter` (`src/keys.ts` + the wiring in `src/index.ts`) is layer 2's answer to the gap layer 1
left: the console endpoint answers from the title screen, but nothing could get *past* it. A probe
run against the real game on 2026-08-18 measured two things that shape everything below:

- **The DLL's key hook does not reach the title screen.** Holding VK_RETURN through the hook for
  three seconds moved nothing. `SendInput` — an OS-level keystroke injected below the game entirely
  — did, and the game went on to load all the way to `successfully changed world to: orbit_d2`.
- **`game_launch` resolving is not a readiness signal.** It only waits for the game's window to
  exist, which the probe measured happening roughly 40s before the title screen can actually accept
  input — a keystroke sent right after `game_launch` returns is lost. The signal that actually works
  is the line `Entering state 'bootflow:start'` appearing in `sunrise.log`, measured at 8s after
  launch in that run; a keystroke sent after that line appears worked.

**`SendInput` is used nowhere else in this project, and should not be.** It targets whatever window
currently has OS foreground focus, not a specific one, so it would leak keystrokes into whatever the
user has alt-tabbed to. Using it here is a deliberate, narrow exception: the title screen precedes
every hook this project installs, so it is the *only* screen with no other way in, and it is only on
screen for a few seconds right at startup — not something that stays true later in a session. The
same reasoning is written in `scripts/press-title-screen-key.ps1` and `src/keys.ts`'s header comment.

`game_enter` composes this into one tool: launch if the game isn't already running (checked via
`tasklist`, so a game already sitting past the title screen isn't needlessly killed and restarted),
wait for the `bootflow:start` marker, press Enter via `SendInput`, then wait for the
`successfully changed world to: orbit_d2` line. **It leaves the game at the character-selection
screen** — choosing a character is a separate tool, not yet built. On failure it reports which stage
it stopped at (`launch`, `titleScreen`, `keyPress`, or `worldLoad`), since that's what a calling
agent needs to know to react sensibly rather than just that something went wrong.

The `INPUT` struct `press-title-screen-key.ps1` passes to `SendInput` is 40 bytes on x64. A
declaration missing the two trailing `int` padding fields comes out 32 bytes, and `SendInput` then
silently returns `0` — no exception, no `GetLastError` anyone sees — instead of throwing; this cost
the original probe two attempts before the 40-byte layout was found to be the fix. `down`/`up`
counts of `0` are treated as an explicit failure on the TypeScript side (`pressTitleScreenKey`
returns `status: 'failed'`), not folded into `'sent'`. The script emits its result via
`[Console]::Out.WriteLine`, never `Write-Output`, for the same reason `launch-game.ps1` does:
PowerShell's success-stream formatter wraps long lines at the console width, and a parser that reads
only the last line would get a truncated fragment instead of the whole JSON object — `keys.ts`'s
`parsePressKeyOutput` mirrors `game.ts`'s `parseLaunchOutput` and scans backwards from the end of
stdout for the first line that actually parses as its expected shape, rather than trusting it's
strictly the last line printed.

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

## Testing keys.ts without the game

`waitForTitleScreen` (and the `waitForLogMarker` it's built on) never talk to the game directly —
they poll a log file on disk. That's what makes them testable without the game: `scripts/keys-smoke.mjs`
points them at a temp file it writes to incrementally instead of the real `sunrise.log`, using the
`logPath` parameter both functions take (defaulting to `getLogPath()`) for exactly this reason.
`getLogPath()` builds its path with `path.win32`, which mangles a Linux-style temp path's
separators, so there was no way to reach a real temp file through `SUNRISE_GAME_DIR` alone under
WSL node — the explicit parameter is the smallest change that makes this testable while staying
source-compatible with the one-argument `waitForTitleScreen(timeoutMs)` signature.

```
npm run test:keys   # builds, then runs scripts/keys-smoke.mjs
```

It covers: `false` before the marker line is present and the timeout is hit; `true` once the marker
is appended to the file mid-wait, returned promptly rather than riding out the full timeout; the
timeout being respected — not rounded up to the poll interval — when it's shorter than a single
poll; and the log file simply not existing yet (e.g. called right after launch, before the game has
written anything).

This test was deliberately broken to confirm it can actually fail: with the poll loop temporarily
replaced by a single immediate check (i.e. the wait removed), the "marker appended mid-wait" case
failed as expected (`3/4 passed`, exit code 1) while the other three still passed, then all four
passed again once the loop was restored. See `task-3-report.md` for the pasted output of both runs.

`pressTitleScreenKey()` shells out to a real `destiny2.exe` process check and, with the game
running, a real `SendInput` call — neither of which this repo fakes. Its `no-game` branch (the game
not running) was instead verified directly: with `destiny2.exe` confirmed not running, calling it
under real Windows `node.exe` returned `{"status":"no-game", ...}` cleanly rather than throwing, in
about half a second. The `SendInput` path itself remains unproven until a session with the real
game — see "Design notes and known limits" below.

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
- **`game_enter`'s `WORLD_LOAD_TIMEOUT_MS` (120s) is an unmeasured judgment call**, unlike
  `waitForTitleScreen`'s 30s default, which at least has one real data point (8s) behind it with
  headroom on top. Nothing has timed how long the world actually takes to load past the title
  screen yet — worth tightening once it has.

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
exercised: the retry-on-connect-failure path (see "Retry policy" above), and — still true as of
`game_enter` landing — the actual `SendInput` keystroke and the `game_enter` tool end to end. Task 3
was built and tested entirely off-target (see `task-3-report.md`): `waitForTitleScreen`/
`waitForLogMarker` were proven against a temp-file log under real polling and a deliberate-break
falsification pass, and `pressTitleScreenKey()`'s `no-game` branch was proven under real Windows
`node.exe` and real `powershell.exe` with `destiny2.exe` confirmed not running. What remains
unproven until a session with the real game: that `SendInput` actually reaches the title screen
from this exact script (it did in the original probe, run by hand, not through this code path), that
`down`/`up` come back non-zero against the real window, and that `game_enter`'s full sequence
(launch → title screen → keypress → world load → character selection) works end to end.

## Project layout

- `src/endpoint.ts` — the endpoint client. No MCP import here, on purpose.
- `src/game.ts` — Windows-side game process and log helpers (`game_launch`, `game_kill`,
  `log_read`), used by `index.ts`.
- `src/keys.ts` — getting past the title screen: `waitForTitleScreen`/`waitForLogMarker` (poll
  `sunrise.log` for a marker line) and `pressTitleScreenKey` (the `SendInput` keystroke). See
  "Getting past the title screen" above.
- `src/index.ts` — the MCP server: six tools over stdio, wiring `endpoint.ts`, `game.ts`, and
  `keys.ts` together.
- `scripts/launch-game.ps1` — launch + window-wait, adapted from
  `a local capture script` (same kill-existing /
  `Start-Process -PassThru` / poll-`MainWindowHandle` shape; the capture/dump/close steps that
  script also does are dropped, since `game_launch` wants the game left running).
- `scripts/press-title-screen-key.ps1` — the `SendInput` script `pressTitleScreenKey` shells out to.
- `scripts/endpoint-smoke.mjs` — the fake-server test for `endpoint.ts` described above.
- `scripts/keys-smoke.mjs` — the temp-log-file test for `waitForTitleScreen`/`waitForLogMarker`,
  described in "Testing keys.ts without the game".
- `scripts/smoke.mjs` — the live-game counterpart, described in "Testing against a live game".
