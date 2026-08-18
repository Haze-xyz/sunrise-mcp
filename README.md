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

Three things worth knowing before you drive this from an agent:

- **The endpoint answers from the title screen**, before the player presses anything. You do not
  need to wait for a load after `game_launch` resolves — `console_run` and `console_describe` work
  immediately.
- **The registry is not layer 1's any more.** Alongside `console.*`, `log.*`, `movement.*` and
  `player.infinite_ammo`, layer 2 publishes forced key input (`input.*`), memory primitives
  (`mem.*`) and `bootflow.character_step` — the point of layer 2 being that reverse engineering
  happens under the MCP rather than beside it. `console_describe` is authoritative; the section
  below is the part that is in no help string and that you need before building on them.
- **`console_run` alone still cannot get past the title screen.** It *does* have key-input
  primitives now, and they are attached and answering `ok` at the title screen — but the title
  screen does not read them. Use `game_enter`; see "Getting past the title screen" below, and the
  measurement that corrected this README's earlier explanation of why.

## What `console_run` can drive (`input.*`, `mem.*`, `bootflow.character_step`)

`console_describe` returns every entry with its help text and bounds, and is the list to trust.
What follows is what the help strings have no room for and an operator needs first.

### Forced key input — `input.hold`, `input.release`, `input.release_all`

`input.hold <vk>` reports one Windows virtual-key code held to the game and leaves it held until
`input.release <vk>` or `input.release_all` takes it back. Several are held at once: the field is
256 bits, one per virtual-key code, precisely so that a skate can report forward, jump and strike
together — a single value could only ever answer the last one. This is not an injected keystroke.
The DLL hooks the `GetKeyState` the engine polls every frame and answers it, so only game code sees
the held key; the real keyboard is untouched and Dear ImGui still reads it for its own modifiers.

**Two states leave the field disconnected from the game**, and every response carries a `field_live`
row saying whether you are in one:

- **The polled guards are not attached.** They install with the graphics hooks, while the console
  entries register at DLL load, so there is a window in which the entries exist and nothing reads
  the field they write.
- **A Sunrise surface has the keyboard.** With the menu or the in-game console open, `get_key_state`
  answers "released" for every key the game asks about, and it does that before it ever looks at the
  forced-key field.

**`input.hold` refuses in both, changing nothing; the two releases always act and report `ok`.** The
asymmetry is deliberate. A hold the game cannot see is a keystroke waiting to fire at a moment nobody
chose, because neither state clears the field on the way in or out — the bit simply becomes live
later. A release has the opposite property: opening a Sunrise surface *masks* the field without
clearing it, so a key held before the surface opened springs back the instant it closes, and
`input.release_all` is the only thing in the process that can stop that. Refusing it in exactly the
state you would reach for it would leave no way out. A clear is idempotent and nothing it can corrupt
depends on who is currently reading the field, so the summary and `field_live` report the state
rather than the status declining to act.

**Consequence worth knowing before you type at the in-game console: a hold submitted at the console
prompt is *always* refused.** Not usually — always, by construction. The overlay drains the command
queue before it tests its own visibility, so a line typed at the prompt runs on the next frame while
the console is still showing, and "a Sunrise surface has the keyboard" cannot be false for anything
typed there. Holds come from this MCP, with no surface open. The prompt is still where the releases
and the reported state are useful, and `input.release_all` typed there works — that is the escape
hatch the asymmetry exists to preserve.

### Memory — `mem.module`, `mem.read`, `mem.scan`, `mem.scan_data`, `mem.resolve`, `mem.write`

`mem.module` gives the main image's base and size, without which an absolute address means nothing
from one launch to the next. `mem.read` dumps up to 256 bytes as hexdump rows keyed by address.
`mem.resolve` decodes a RIP-relative displacement into the address it names. `mem.scan` and
`mem.scan_data` search for a signature. `mem.write` stores up to a small, bounded run of bytes.
Three properties of that set are worth knowing before you build on it, and none of them fits in a
help string.

**The write gate protects the game's image, not the game's state.** `mem.write` refuses code, and
refuses any section the PE's own section table marks read-only — `.rdata`, `.pdata`, `.rsrc` and the
rest, which hold const vtables, the import address table and unwind info. That is a gate on the
*image*. Outside the image there is no section table, so the gate is the page protection alone: a
heap address that is committed, writable and non-executable clears it and is written. This is the
correct design — the heap is where the interesting writes are, and an image-only primitive could not
change a live object at all — but the consequence has to be said plainly: **a wrong address on the
heap corrupts live game state rather than being refused.** A refusal you got back from a bad address
inside the image is not evidence that the gate would catch a bad address outside it; nothing catches
that one. Every call is logged with its address and its bytes, refused calls included, which is the
only record you will have when the symptom surfaces somewhere else entirely.

**The scans sweep ungated, on purpose.** `mem.read` and `mem.write` check every byte against the
region Windows says it lives in; the two scans do not. That is deliberate rather than an omission: a
sweep that skipped whatever it could not prove readable would answer "no match" for a signature that
is present, which is worse than a refusal because it looks like an answer. The sweep is bounded by
the image's own section table instead.

**Neither scan reaches the heap, and `mem.scan_data` is static data only.** `mem.scan` covers the
main image's executable sections; `mem.scan_data` covers its readable non-executable ones. A live
object is therefore not findable by scanning for it — you need a global that points at it, or a hook
that hands you its address. A `matches: 0` result says so in its own summary, because that is the
most decision-changing fact about a miss.

### `bootflow.character_step`

A read-only integer variable carrying the base address of the character sign-in boot step — a hook
handing you an address, which is the second of the two routes to a live object above. The step is
heap-allocated, its address changes every launch, and nothing else in the process can produce one:
the character-select hook is given one live instance per boot and latches it. Feed the value to
`mem.read`. It reads zero until the step has been entered once, and **before that hook attaches the
entry does not exist at all**, so a call then comes back `unknownName` rather than zero.

## Getting past the title screen (`game_enter`)

`game_enter` (`src/keys.ts` + the wiring in `src/index.ts`) is layer 2's answer to the gap layer 1
left: the console endpoint answers from the title screen, but nothing could get *past* it. A probe
run against the real game on 2026-08-18 measured two things that shape everything below:

- **Holding VK_RETURN through the DLL's key hook does not move the title screen.** Three seconds of
  it did nothing. An OS-level keystroke injected below the game entirely is the only door open
  there. (That probe recorded this as "the hook does not *reach* the title screen". It was never
  measured, and it is wrong — see "The hook is there; the title screen just does not read it"
  below. The behaviour above held up; the explanation did not.)
- **`game_launch` resolving is not a readiness signal.** It only waits for the game's window to
  exist, which the probe measured happening roughly 40s before the title screen can actually accept
  input — a keystroke sent right after `game_launch` returns is lost. The signal that actually works
  is the line `Entering state 'bootflow:start'` appearing in `sunrise.log`, measured at 8s after
  launch in that run; a keystroke sent after that line appears worked.

### What the 2026-08-18 re-measurement changed

That first probe's `SendInput` was re-measured the same day, this time with every Win32 return value
actually read instead of discarded, because pressing Enter had stopped working. Three findings, all
now written into `scripts/press-title-screen-key.ps1`'s header:

- **The script's `SendInput` was injecting a null keystroke.** It built the `INPUT` struct as
  `$down.ki = New-Object ...KEYBDINPUT` followed by `$down.ki.wVk = 13`. PowerShell hands back a
  boxed *copy* when you read a value-type field, so that write landed on the copy and was discarded;
  marshalling the struct that actually reached `SendInput` gives `type=1 wVk=0 wScan=0`. The OS
  accepts such an event and returns `1` for it, and nothing on the machine can react to it — which
  is indistinguishable from "the game ignored us" unless someone dumps the bytes. The fix is to
  populate the `KEYBDINPUT` in its own variable and assign it to `.ki` whole; a readback guard in the
  script now fails the call loudly rather than injecting nothing if that ever regresses.
- **`SetForegroundWindow` does fail from here — but that was not the bug.** Called on the game's
  window from a PowerShell started out of WSL it returns `False`, and `GetForegroundWindow()` is
  unchanged. The old code discarded that `False`. Even so, with the game genuinely in the foreground
  the same broken `SendInput` still did nothing, so the foreground was never the cause.
- **Posted window messages do not reach this engine's title screen at all.** `PostMessage` and
  `SendMessage` of `WM_KEYDOWN`/`WM_KEYUP`/`WM_CHAR`, aimed at the visible `Tiger D3D Window`, at
  the hidden `Tiger Input Window` the process also owns, and at both windows' thread queues via
  `PostThreadMessage`, all returned success and none moved anything — with or without a faked
  `WM_ACTIVATE`/`WM_SETFOCUS` first. With the struct fixed, `SendInput` dismisses the title screen
  instantly when the game holds the foreground and does nothing at all when it does not, both
  measured on the same launch.

**The reason both of those hold is one API, known by name rather than inferred: the engine polls
`GetKeyState`** — `Input_PollKeyboardState105`, RVA `0x003447A0`, from static analysis of the mapped
dump. `GetKeyState` reads the per-thread *synchronous* key-state table, which is updated only when
that thread pulls real hardware input off its queue. A posted message never touches it, so no
`PostMessage`/`SendMessage`/`PostThreadMessage` can move this screen at any window on any thread;
and injected input only ever reaches the *foreground* thread's queue. (An earlier revision of this
section said "the signature of Raw Input or DirectInput". Every behavioural conclusion survived, the
attributed API did not. The name matters: the follow-on route — Sunrise's own hook intercepting that
polled `GetKeyState` in-process — is discoverable from `GetKeyState` and invisible from Raw Input.)

**Scope of "the foreground is required".** It is required *from outside the process, via `SendInput`
or `PostMessage`* — the two doors the MCP has. It is not a closed problem in general. Two others met
the no-foreground condition and were left to later tasks: hooking the very `GetKeyState` the engine
polls, **in-process** (that is Sunrise's existing forced-key hook), and a separate desktop via
`CreateDesktop`/`SetThreadDesktop`, which has its own foreground that never touches the user's
screen. The first of those has since been built, shipped as `input.*`, and **measured not to move
this screen** — see below. It drives the game perfectly well once past it. The separate desktop is
untried.

**So `SendInput` is the primary route and `PostMessage` the fallback, and the result names which one
ran** (`PressResult.route`, surfaced by `game_enter` as `route`). **`postMessage` always comes back
as `status: 'failed'`, at stage `keyPress`** — not as a weaker success. Two messages accepted by a
queue nobody reads is not a press, and `'sent'` is the exact gate `game_enter` uses to commit its
durable press record; letting the fallback through it would widen that record's input contract from
"a keystroke was delivered" to "some messages were queued", burn the 120s world-load wait, fail at
the wrong stage, and then refuse to press on a retry. Failing at `keyPress` instead stops in about a
second, writes no record, and leaves a retry free to try again.

**The keystroke-leak defect layer 2 accepted is gone.** `SendInput` targets whatever window has OS
foreground focus, so layer 2 knowingly accepted that a press could land in whatever the user had
alt-tabbed to. The script now brings the game window to the front (minimize → restore →
`SetForegroundWindow`, because a bare `SetForegroundWindow` is refused but restoring a minimized
window is permitted) and injects **only** once `GetForegroundWindow()` has been read back and found
to be the game's own window. If the foreground cannot be taken it injects nothing at all and posts to
the HWND instead, which can't leak either. What it costs instead is that the game window is pulled to
the front — unavoidable for the routes above, and it needs no human, which is the property that matters.

**What the press disturbs, and what it does not put back.** Taking the foreground means
`SW_MINIMIZE` on the game window (which activates whatever is next in the Z order) and then
`SW_RESTORE` + `SetForegroundWindow`. **The window the user was on is left behind the game and is
not restored.** That is a deliberate choice, not an oversight: a restore could not be verified
against a live game in the session that introduced it, and an unverified focus change on the critical
path is a worse bet than the disturbance it would undo — the caller asked for the game to be driven.
It **is** reported, all the way to the caller: `foregroundBefore` (the displaced window),
`minimized` (whether the game was minimized to take the foreground) and `restoredIconicAtEntry`
travel from the script's JSON through `PressResult` into `game_enter`'s response as a `window`
object, on success and on every failure path alike. An agent that pulled the game in front of
whatever the user was looking at can say which window it was. (Until these were propagated they
existed only in the subprocess's stdout, which `pressTitleScreenKey` discards on the success path —
so the claim "none of it is silent" was true of the script and false of the tool.)

Two things bound the damage: the minimize/restore pair polls `IsIconic` rather than sleeping a flat
400ms, keeping the minimized interval as short as Windows allows; and if the script finds the game
window **already** minimized on entry — exactly what a previous run killed at
`PRESS_KEY_TIMEOUT_MS` between those two calls would leave — it restores it and reports
`restoredIconicAtEntry`, so that hazard self-heals on the next call instead of needing a human.

**The self-heal was measured, and it behaves better than predicted.** The open question was whether
Windows grants foreground-on-restore to a *new* process restoring a window that a *different,
already-dead* process minimized — not the case originally measured, which was one process undoing
its own minimize. It does. Contrived honestly (a separate short-lived `powershell.exe` minimizes the
game window and exits, then the shipped script runs), three consecutive runs came back
`restoredIconicAtEntry: true`, `alreadyForeground: true`, `minimized: false`,
`setForegroundResult: null` — `SW_RESTORE` alone won the foreground, `SetForegroundWindow` was never
called, and the title screen was dismissed every time. The predicted
restore → re-minimize → restore flicker **did not happen**: the minimize/restore branch never ran.

**Windows agreeing the window is foreground is not the same as the engine having re-acquired the
keyboard.** Pressing the instant `GetForegroundWindow()` first agreed, right after the
minimize/restore, was accepted by the OS (`down=1 up=1`) and ignored by the game, which then sat on
the title screen until `game_enter`'s world-load wait timed out 120s later. The script therefore
settles 1200ms after taking the foreground — the value measured working across the restore — and
re-reads the foreground once more before injecting, in case something took it back during the wait.

**That settle is gated on whether the script activated the window, not on whether the window was
already in front.** The self-heal measurement above forced this correction: because `SW_RESTORE`
wins the foreground outright, the self-heal path arrives at the settle with `alreadyForeground`
already `true`, so the original `-not $alreadyForeground` gate skipped the settle on precisely the
path that had just activated the window — leaving 300ms between activation and the keystroke, a
quarter of what was measured as necessary. It worked twice anyway; that is luck, not margin. The
gate is now `restoredIconicAtEntry -or minimized`, i.e. "this invocation activated the window".
With that settle in place: three consecutive cold `game_enter` runs and three runs where the game was
deliberately pushed into the background first all dismissed the title screen, none failed.

**Residual, worth knowing before you debug this at 3am.** That settle is a measured number, not a
proof, and this is a timing-sensitive interaction with a game engine. If a press is ever accepted by
the OS and ignored by the game again, `game_enter` fails at stage `worldLoad` naming the `sendInput`
route — and a bare `game_enter` retry will *not* press again, because the press record correctly says
this pid was already pressed (see the repeat-call finding below). The way out is `game_kill` then
`game_enter`, which clears the record; the failure message says so.

**`SendInput` is still used nowhere else in this project, and should not be.** Using it here is a
deliberate, narrow exception: it is the only route measured to move this screen. Not, as this
section used to claim, because the title screen precedes every hook the DLL installs — see below.

### The hook is there; the title screen just does not read it

Measured 2026-08-18, at the end of the layer-2 fix wave, because nobody had ever measured the
premise the exception rests on. The polled guards attach with the graphics hooks, and the game
presents frames at the title screen, so there was every reason to think the hook was live there.

It is. At the title screen, `console_run "input.hold 13"` answers **`ok`** — which, since that same
fix wave, means the guards reported themselves attached and no Sunrise surface had the keyboard. The
hook is installed, the forced-key field is live, and the console can write it, all before Enter has
ever been pressed. `bootflow.character_step` answers there too. The old claim that the title screen
"precedes every key hook the DLL installs" is simply false.

What the title screen does not do is read it. On one launch, in this order: five hold/release taps
of VK_RETURN through the hook — nothing; one continuous five-second hold — nothing; then
`SendInput`, on the same launch and the same title screen, which produced
`Leaving state 'bootflow:start'` at once and a loaded world after it. The log did not grow by a
single byte across the whole hook phase. So the game was not wedged and the measurement is not an
artifact of a dead title screen: the screen was capable of moving the entire time and the hook did
not move it.

Why is not established, and this README is not going to invent a third confident guess about this
engine. The plausible candidates, in the order worth testing: the title screen polls
`GetAsyncKeyState` rather than `GetKeyState`, and the DLL's async guard only ever forces keys
*released* — it has no path that reports one held; or it reads through some route neither export
covers; or it wants an edge the per-frame scan cannot see from a state bit. What **is** established
is the operational fact: `input.*` is for driving the game once it is in, and `game_enter` is for
getting it in.

Nothing in `game_enter` changes on the strength of this. Had the hook moved the screen, `game_enter`
could have dropped the foreground theft, the window disturbance, the settle, the self-heal and the
whole press-record apparatus — that is a design change for a rested author, not a fix, and in any
case the measurement points the other way.

`game_enter` composes this into one tool: launch if the game isn't already running (checked via
`tasklist`, so a game already sitting past the title screen isn't needlessly killed and restarted),
wait for the `bootflow:start` marker, take and verify the foreground, press Enter via `SendInput`
(falling back to `PostMessage` if the foreground could not be taken), then wait for the
`successfully changed world to: orbit_d2` line. **It leaves the game at the character-selection
screen** — choosing a character is a separate tool, not yet built. On failure it reports which stage
it stopped at (`launch`, `titleScreen`, `keyPress`, `worldLoad`, or `ambiguous` — see below), since
that's what a calling agent needs to know to react sensibly rather than just that something went wrong.

**`game_enter` is safe to call repeatedly against an already-running game.** `sunrise.log` is
append-only, so once `TITLE_SCREEN_MARKER`/`WORLD_LOADED_MARKER` have been written, they stay in the
file for the rest of that process's life — a naive whole-file check can't tell "the game just reached
this state" from "it reached this state once, a while ago, and hasn't moved since". A repeat call
that skipped launch (the game was already running) and then went on to whole-file-match a stale
marker would press `SendInput` Enter into whatever the game is currently showing — a menu, character
select, mid-gameplay — and report a false `ok`, as if it had just freshly gotten the game past the
title screen. This was an Important finding from Task 3's review, confirmed real and not
hypothetical: it only needs the ordinary property that a single process's log file doesn't rewind.

Two things close it, and both are needed — see `waitForLogMarker`'s doc comment in `src/keys.ts` for
the mechanism (`sinceOffset`) they share. First, `game_enter` checks up front whether
`WORLD_LOADED_MARKER` is already anywhere in the log before doing anything else; if so, a full pass
already completed in this session, and it returns `ok` immediately without pressing anything —
that's what actually stops the spurious keystroke on a same-session repeat call, since it never
reaches the point where a press could happen. Second, every wait that follows is anchored to a byte
offset captured at the right moment rather than checking the whole file: the title-screen wait after
a fresh launch is anchored to the log's size right after that launch (closing a related, weaker risk
— `launchGame()` reuses the same log path across a kill+restart, so if the engine doesn't truncate
it, stale markers from the killed process would otherwise look like fresh evidence too), and the
world-load wait is anchored to the log's size right before the press, so the marker that satisfies it
must have been produced by *that* press. The up-front short-circuit alone would not close the
relaunch case (a fresh launch never takes that branch, since the game wasn't running to begin with);
the offset anchor alone would not preserve the legitimate case of a game left sitting at the title
screen by a direct `game_launch` call, unpressed, before `game_enter` is ever called — in that case
`WORLD_LOADED_MARKER` is genuinely absent, so the short-circuit correctly does not trigger, and the
existing (unanchored, whole-file) `TITLE_SCREEN_MARKER` there is legitimate current evidence, not a
stale leftover. Both mechanisms together are what make `game_enter` idempotent without either firing
a spurious keystroke or refusing to press a game that is honestly still waiting at the title screen.

**That first fix still had a gap, found on re-review: a game that is past the title screen but not
yet in orbit.** If the world hasn't loaded yet — still loading, or a prior call that already pressed
and then timed out waiting for the world — the log shows exactly `TITLE_SCREEN_MARKER` present,
`WORLD_LOADED_MARKER` absent: the identical signature to a game that was genuinely never pressed. The
log alone cannot tell these apart, so re-checking it harder was never going to close this; the
world-loaded short-circuit doesn't fire (the world hasn't loaded), and the unanchored title check
(needed to preserve the legitimate case above) matches the leftover title marker and presses again.
The fix is a second, independent signal the log can't provide: `game_enter` remembers the pid of the
destiny2.exe process it has already pressed Enter for. A repeat call against the same still-running
pid recognizes it already pressed and resumes waiting for the world to load without pressing again; a
game whose pid can't even be determined (a `tasklist`-parsing edge case, and only once a press might
actually be needed — an already-loaded world reports `ok` regardless) is treated as genuinely
ambiguous and declined rather than guessed at, surfaced as a new `ambiguous` failure stage. The whole
decision — given whether the game is running, its pid is known, the world/title markers are present,
and this pid was already pressed for, what to do next — is a pure function, `decideGameEnterAction`
in `src/game-enter-decision.ts`, pulled out of `index.ts` precisely so it can be pinned by a table of
cases instead of only reasoned about against real wiring that needs the actual game to run end to end.

**That second fix's memory was in-process only, and a further re-review overruled calling that an
accepted limitation.** A bare module variable is lost the instant the MCP server process itself
restarts — a crash, a client reconnect, a rebuild during iteration — which is an ordinary event, not
a rare one, and the game can easily still be mid-load when it happens; a `game_enter` call right after
such a restart sees no record, falls through to the unanchored title check, and re-presses. The
finding was never scoped to one server process's uptime, so this was a residual version of the same
bug, not a genuinely different, acceptable one. The fix, in `src/press-record.ts`: the pid (and the
log's byte size at the moment of the press) is written to a small durable file — `%LOCALAPPDATA%\
sunrise-mcp\press-record.json`, falling back to the OS temp directory if `LOCALAPPDATA` isn't set —
and read back on every `game_enter` call, so the record survives a restart. Deliberately not written
anywhere inside the game's own directory, which would be surprising and could vanish on a reinstall.
Guarding a durable record against staleness matters more than an in-process one did, since it can now
outlive the very session it describes: if the log is now *smaller* than the size recorded at press
time, the log was replaced (truncated or recreated) since, so the pid match cannot be trusted even
though the number is the same — most plausibly Windows having reused the old pid for an unrelated,
unpressed process. This is deliberately a size check, not a content one: nobody has measured what
sunrise.log actually contains while sitting at the title screen versus while loading, and this
project has already paid for two confident guesses about the game, so the fix does not add a third by
inventing a "process started" marker it has never seen. `decideGameEnterAction` stays pure throughout
this: it only ever sees the resulting boolean (`isPressRecordFresh`, also pure, computed by the
caller from the already-fetched record, pid, and log size), never touches the file itself.

**That third fix's own diff reopened the harmful direction, this time within a single, uninterrupted
server process — no restart needed.** `writePressRecord` never throws: an unwritable
`%LOCALAPPDATA%`, a `mkdir` failure, or a transient I/O error is caught and only logged to stderr.
`game_enter` called it fire-and-forget, without checking success. The round-2 in-process variable
this replaced could never fail to record a press within a process's own lifetime — a plain assignment
cannot fail the way a file write can — so making that guarantee depend entirely on a disk write
succeeding was a real regression, found on a fourth review round. If the write silently failed,
`readPressRecord` on the very next call *in the same process* found no record, `pressedThisSession`
was false, and a second spurious `SendInput` went into the loading screen. The fix keeps the
in-process variable after all, but as a first-line *cache* alongside the durable file rather than
instead of it: `cachedPressRecord` in `index.ts` is set unconditionally right after a successful
press, before the file write is even attempted, so a broken disk write cannot cost it. Reading it
back goes through `resolvePressedThisSession` in `press-record.ts`, which checks the cache first and
only reads the file if the cache doesn't already answer positively — the durable record still carries
the restart case, the cache still carries the same-process case, and neither depends on the other
succeeding. Both are gated by the identical `isPressRecordFresh` pid+log-size check, and both are
cleared together the moment the game is observed not running, so the two sources can never disagree
in a way that resurrects a record for a game session it doesn't actually belong to.

**Every one of those fixes is a read-then-act sequence, and none of them was atomic.** A fifth round
found the last open path to a spurious press, and it is not in any of the checks above but in the way
they are reached: nothing in MCP stops a client dispatching two `game_enter` calls at once. Both
would observe "not pressed for this pid" before either wrote the record — the cache included, since
it is only written after the press — and both would fire `SendInput`. Until this was closed, the
safety claim was quietly conditional on the client never parallelising, which this repo does not
control and never stated. `src/serialize.ts` closes it: `createSerializer` returns a one-at-a-time
queue, and `game_enter`'s whole handler runs inside it. Serializing the whole call rather than
locking around the record is deliberate — the press also takes the OS foreground, minimizes and
restores a window, and settles for over a second, and two of those interleaved would fight each other
even with a perfectly guarded record. A rejected call resolves to its own caller without poisoning
the queue. The scope is one process, which is exactly the scope of the in-process cache it protects;
the durable record already covers the restart case.

The `INPUT` struct `press-title-screen-key.ps1` passes to `SendInput` is 40 bytes on x64. A
declaration missing the two trailing `int` padding fields comes out 32 bytes, and `SendInput` then
silently returns `0` — no exception, no `GetLastError` anyone sees — instead of throwing; this cost
the original probe two attempts before the 40-byte layout was found to be the fix. `down`/`up`
counts of `0` are treated as an explicit failure on the TypeScript side (`pressTitleScreenKey`
returns `status: 'failed'`), not folded into `'sent'`. That struct has now bitten this project
twice, the second time through PowerShell rather than through the layout — see
"What the 2026-08-18 re-measurement changed" above — which is why the script reads the key code back
out of the struct it is about to marshal and refuses to call `SendInput` at all if it comes out `0`.
The script emits its result via
`[Console]::Out.WriteLine`, never `Write-Output`, for the same reason `launch-game.ps1` does:
PowerShell's success-stream formatter wraps long lines at the console width, and a parser that reads
only the last line would get a truncated fragment instead of the whole JSON object — `keys.ts`'s
`parsePressKeyOutput` mirrors `game.ts`'s `parseLaunchOutput` and scans backwards from the end of
stdout for the first line that actually parses as its expected shape, rather than trusting it's
strictly the last line printed. Turning that parsed line into a `PressResult` is
`interpretPressKeyOutput`, kept pure and exported precisely so the keys smoke test can drive every
branch — including the route naming a caller switches on — without a running game.

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
poll; the log file simply not existing yet (e.g. called right after launch, before the game has
written anything); `currentLogSize`'s contract (0 for a missing file, the real byte size for an
existing one); `timeoutMs` 0 acting as a single immediate check in both directions, which is the
building block `game_enter`'s already-past-the-title-screen short-circuit relies on; and — added for
the repeat-call idempotency finding described above — that `sinceOffset` makes the wait ignore a
marker already in the file before that offset was captured, matching only content appended after it.

It also covers `interpretPressKeyOutput`, the pure half of `pressTitleScreenKey`: the sendInput
route reporting a confirmed foreground; the postMessage fallback reported as `failed` rather than a
weaker `sent`, so it can never reach the press-record gate; a zero `SendInput` count treated as a
failure rather than a success; the script's own null-keystroke guard surfaced verbatim instead of
behind a generic message; the `no-game` case carrying no route because nothing was attempted; `null`
when nothing parses, so a killed process stays distinguishable from an outcome; the result line being
found among PowerShell noise by scanning from the end; and an unknown route value rejected outright,
since callers switch on that name and an unmodelled one would fall through every branch silently.

Those cases are fed hand-written JSON, so **on their own they prove the parser and nothing about the
script** — a key renamed in `press-title-screen-key.ps1` would leave all of them green while
`interpretPressKeyOutput` silently stopped seeing that field, since every optional field is tolerated
as absent (`foregroundIsGame` included, which is the one fact the no-leak argument rests on). One
further case closes that: it reads the `.ps1` and asserts that every field the parser reads is
written there as an actual hashtable assignment (`name =`, so a mention in a comment cannot satisfy
it), that both route names and every accepted status exist as literals it can emit, and that
`foregroundIsGame` is written from the measured `$foregroundIsGame` variable rather than a `$true`
literal. **That** is the case that fails on drift; the literal-JSON cases pin the behaviour once the
names are known to match.

Both rounds of this test were deliberately broken to confirm they can actually fail. First round:
with the poll loop temporarily replaced by a single immediate check (i.e. the wait removed), the
"marker appended mid-wait" case failed as expected (`3/4 passed`, exit code 1) while the other three
still passed, then all four passed again once the loop was restored. Second round (the
`sinceOffset` fix): with the offset ignored (`logHasMarkerSince` matching the whole file regardless
of `sinceOffset`, i.e. the original pre-fix behavior), the new "ignores a marker already in the log
before sinceOffset" case failed as expected (`6/7 passed`, exit code 1) while the other six still
passed, then all seven passed again once restored. See `task-3-report.md` for the pasted output of
both rounds.

`pressTitleScreenKey()` itself shells out to a real `destiny2.exe` process check and, with the game
running, real Win32 calls — neither of which this repo fakes. Its `no-game` branch (the game not
running) was instead verified directly: with `destiny2.exe` confirmed not running, calling it under
real Windows `node.exe` returned `{"status":"no-game", ...}` cleanly rather than throwing, in about
half a second. The `SendInput` path is proven against the real game: on 2026-08-18, `game_enter`
driven over stdio from a closed game returned
`{"status":"ok","route":"sendInput","message":"The game reached the character-selection screen."}`
in 40.1s, and `sunrise.log` shows `Entering state 'bootflow:start'` at `t=13797` followed by
`Leaving state 'bootflow:start'` at `t=15031` — the press landing 1.2s later — then
`successfully changed world to: orbit_d2` at `t=29172` and `Entering state 'character:signin'` at
`t=32422`.

### Testing game_enter's branch selection without the game or the filesystem

`game_enter`'s own decision of what to do next — launch, short-circuit to `ok`, press then wait,
resume waiting without pressing, or decline — is pulled out of `index.ts` into a pure function,
`decideGameEnterAction` in `src/game-enter-decision.ts`. It takes nothing but plain booleans (is the
game running, is its pid known, is the world marker present, is the title marker present, was this
pid already pressed for) and returns which action to take, with no file reads, no process checks, and
no `SendInput` — which is what makes it testable directly, with a plain table of cases. The
staleness check behind that last boolean, `isPressRecordFresh` in `src/press-record.ts`, is pure too
(it only compares values the caller already fetched), while the record's actual read/write/clear live
in the same file as real (if small and cheap) file I/O, tested the same no-mock way
`keys-smoke.mjs` tests `waitForTitleScreen` — against a real temp file, not a fake. All of it is in
`scripts/game-enter-decision-smoke.mjs`:

```
npm run test:keys   # also runs scripts/game-enter-decision-smoke.mjs, after keys-smoke.mjs
```

`decideGameEnterAction`'s table covers the five situations traced by hand in the review that found
the repeat-call gap, one defensive case beyond them (the game's pid can't be determined), and two
priority checks: a world already loaded always wins over a stale press record, and — fixed in the
third review round, since a `tasklist` pid hiccup on a game that's already fully in orbit has nothing
left to press and shouldn't report `ambiguous` — also wins over an undeterminable pid. `isPressRecordFresh`'s
table covers no record, a record for a different pid, a record for the same pid the log has only
grown past (fresh), and a record for the same pid the log has since shrunk below (stale).
`resolvePressedThisSession`'s table (fourth review round) covers a fresh cache trusted entirely on
its own — proven by passing it a `readRecord` stub that *throws if called*, so a passing test proves
the file was never even touched, not just that the right answer came back — a stale or missing cache
correctly falling back to a fresh file record, both being absent, and a stale cache still falling back
to the file rather than being trusted for merely existing. The persistence functions are checked
round-tripping a record through a real temp file, overwriting rather than merging on a second write,
leaving no leftover `.tmp` file behind (the atomic write-then-rename works), treating a corrupt or
wrongly-shaped file as no record rather than throwing, and creating their parent directory on first use.

Three rounds of deliberate breaks confirm this can actually fail, not just pass. First (second review
round): with the "already pressed this session" check removed from `decideGameEnterAction`
(reverting to the exact bug the review found — a repeat call always proceeds to press, whether or not
this server already pressed), the finding's own case failed as expected (`11/12 passed`, exit code
1) while every other case still passed, then all twelve passed again once restored. Second (third
review round, the durable-record fix): with `isPressRecordFresh`'s log-size staleness guard removed
(a same-pid record trusted regardless of whether the log has since shrunk), the "log is now SMALLER
than recorded -> stale" case failed as expected (`24/25 passed`, exit code 1), then all cases passed
again once restored. Third (fourth review round, the cache fix): with `resolvePressedThisSession`'s
cache short-circuit removed (always falling through to the file, exactly the regression this round
fixes), the "fresh cache trusted on its own" case failed as expected — its `readRecord` stub, now
actually called, threw on cue (`28/29 passed`, exit code 1) — then all cases passed again once
restored. See `task-3-report.md`'s fix reports for the full pasted output of all three rounds.

The same script also checks `parseTasklistCsv` (`src/tasklist.ts`) against real `tasklist.exe`
output captured live during the second review round: a genuine "not found" `INFO:` line, the exact
CSV shape a match takes, and an unparseable pid field falling back to `pid: null` rather than
throwing or guessing.

What none of this can prove without the real game: that the durable press record
and its in-process cache behave as intended across a real MCP server restart or a real relaunch, and
in particular the one residual documented above (see "Getting past the title screen"): Windows pid
reuse for a genuinely different, unpressed game session, when the engine doesn't truncate
sunrise.log on a fresh start and no server ever observes the game not running in between.

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
exercised: the retry-on-connect-failure path (see "Retry policy" above).

`game_enter`'s full sequence is now proven against the real game (2026-08-18, task 1 of the
reverse-primitives plan). Driven over stdio from a closed game it answered
`{"status":"ok","route":"sendInput","message":"The game reached the character-selection screen."}`
in 40.1s, with `sunrise.log` showing `Entering state 'bootflow:start'` (`t=13797`) →
`Leaving state 'bootflow:start'` (`t=15031`) → `successfully changed world to: orbit_d2`
(`t=29172`) → `Entering state 'character:signin'` (`t=32422`). No human touched the keyboard, and
`down`/`up` came back `1`/`1` from the real window. What that run also established is that the
foreground is not optional for this engine — see "What the 2026-08-18 re-measurement changed".

## Project layout

- `src/endpoint.ts` — the endpoint client. No MCP import here, on purpose.
- `src/game.ts` — Windows-side game process and log helpers (`game_launch`, `game_kill`,
  `log_read`), used by `index.ts`.
- `src/keys.ts` — getting past the title screen: `waitForTitleScreen`/`waitForLogMarker` (poll
  `sunrise.log` for a marker line), `pressTitleScreenKey` (the keystroke), and
  `interpretPressKeyOutput` (its pure result-parsing half, which decides the route name). See
  "Getting past the title screen" above.
- `src/tasklist.ts` — `getGameProcessInfo`/`parseTasklistCsv`: whether destiny2.exe is running and
  its pid, via `tasklist`. Split out from `index.ts` so the pure parsing logic is importable by a
  test without pulling in `index.ts`'s module-load side effect of connecting an MCP stdio transport.
- `src/game-enter-decision.ts` — `decideGameEnterAction`, the pure branch-selection logic behind
  `game_enter`, extracted so it can be tested with a table of cases. See "Testing game_enter's branch
  selection without the game or the filesystem" above.
- `src/press-record.ts` — the durable record of which pid `game_enter` already pressed Enter for
  (`readPressRecord`/`writePressRecord`/`clearPressRecord`), the pure staleness check
  (`isPressRecordFresh`), and `resolvePressedThisSession`, which checks `index.ts`'s in-process cache
  first and only falls back to the file -- together they're what turns into
  `decideGameEnterAction`'s `pressedThisSession` input. The file survives an MCP server restart; the
  cache survives the file's own write silently failing within one process's lifetime. See "Getting
  past the title screen" above.
- `src/serialize.ts` — `createSerializer`, the one-at-a-time call queue `game_enter` runs inside so
  two concurrent invocations cannot both observe "not pressed yet" and both press. Pure, no imports,
  tested by table in `scripts/game-enter-decision-smoke.mjs`.
- `src/index.ts` — the MCP server: six tools over stdio, wiring `endpoint.ts`, `game.ts`, `keys.ts`,
  `tasklist.ts`, `game-enter-decision.ts`, `press-record.ts` and `serialize.ts` together.
- `scripts/launch-game.ps1` — launch + window-wait, adapted from
  `a local capture script` (same kill-existing /
  `Start-Process -PassThru` / poll-`MainWindowHandle` shape; the capture/dump/close steps that
  script also does are dropped, since `game_launch` wants the game left running).
- `scripts/press-title-screen-key.ps1` — the key-press script `pressTitleScreenKey` shells out to:
  foreground the game and verify it, `SendInput`, else fall back to `PostMessage`. Its header carries
  the full 2026-08-18 measurement.
- `scripts/endpoint-smoke.mjs` — the fake-server test for `endpoint.ts` described above.
- `scripts/keys-smoke.mjs` — the temp-log-file test for `waitForTitleScreen`/`waitForLogMarker`,
  described in "Testing keys.ts without the game".
- `scripts/game-enter-decision-smoke.mjs` — the table-driven test for `decideGameEnterAction` and
  `parseTasklistCsv`, described in "Testing game_enter's branch selection without the game or the
  filesystem". Also run by `npm run test:keys`.
- `scripts/smoke.mjs` — the live-game counterpart, described in "Testing against a live game".
