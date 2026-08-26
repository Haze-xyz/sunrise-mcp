# sunrise-mcp

An MCP server for the Sunrise console endpoint: it drives and inspects a **running** Destiny 2
"Sunrise" private server (the game process is itself the server) over a loopback line protocol.
Two things it's for, in priority order:

1. **Reverse engineering** — read, scan, and write the live game's memory, and decode structs out
   of it.
2. **Control** — get the game into the world (past the title screen, optionally as a named
   character) and drive input once it's in.

It exposes twelve base MCP tools — two of them (`console_run`, `console_describe`) talk to the
console endpoint, `install_check` touches nothing and answers why the others are failing, and the
rest work through the game process, its log, its settings file, its build, or the on-disk journal —
plus an extensible **capabilities** layer for composing them into richer tools without touching the
game's C++ at all.

## From nothing to a game that answers

Six steps. The whole thing is one evening, and every step has a command.

```bash
# 1. this server
git clone <sunrise-mcp> && cd sunrise-mcp && npm install && npm run build

# 2. put the fork's capability into your own Sunrise checkout -- 45 files it adds,
#    34 of upstream's it changes, applied as one squashed change. Nothing is committed.
node scripts/overlay-apply.mjs --repo <your Sunrise checkout>

# 3. build the DLL, and copy it into bin\x64 -- NOT next to destiny2.exe. The game root is
#    where the exe lives; the loader takes steam_api64.dll from bin\x64, and a DLL left at
#    the root is simply never loaded. `dll_deploy` puts it in the right place for you.
cd <your Sunrise checkout>
msbuild Sunrise.sln /m /v:normal /p:Configuration=Release /p:Platform=x64
#    build\x64\Release\steam_api64.dll  ->  <game dir>\bin\x64\steam_api64.dll

# 4. turn the listener on. It ships OFF, and this is the step everyone misses:
#    <game dir>\bin\x64\Sunrise\settings.json  ->  server > console_endpoint > "enabled": true

# 5. tell this server where the game is
export SUNRISE_GAME_DIR='E:\Your\Destiny_Sunrise'

# 6. check before believing anything
node -e "import('./dist/install.js').then(m=>m.inspectInstall()).then(r=>console.log(r.verdict, r.message))"
```

Step 6 is the one to run whenever something looks broken; as an MCP tool it is `install_check`. It
answers `ok`, or names which of five things is wrong — and none of its answers is about the game.

**Step 2 needs access to the fork**, which is private. There is no way around that: the console
endpoint, `mem.*`, `character.*` and forced-key input are that fork's additions to
`steam_api64.dll`, and upstream Sunrise has none of them. Against a stock install every tool here
fails identically, with a refused connection.

## What it needs

- **Node ≥ 20**, and the server must run on **whatever machine can reach the game's loopback
  socket** — Destiny 2 being Windows-only, that means Windows. Not a preference: the endpoint *is*
  a `127.0.0.1`-bound TCP listener inside the game process. Point your MCP client at a Windows
  `node.exe`.
- **If you develop under WSL:** `npm install`, `npm run build` and `npm run typecheck` are ordinary
  TypeScript and work fine there. *Running* the server does not. WSL is NAT'd on this kind of
  setup, so a WSL process's `127.0.0.1` is the WSL VM's own loopback, never the Windows host's. See
  `NOTES.md` for what getting this wrong looks like (a refused connection, or a silent hang against
  the wrong loopback).
- Strict TypeScript throughout: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  no `any`, no `@ts-ignore`.
- This repo is private. It pushes to a private `backup` remote only — never a public fork, never
  upstream, never a PR.

## Configure

Everything is env vars, with Windows-appropriate defaults:

| Variable | Default | Meaning |
|---|---|---|
| `SUNRISE_ENDPOINT_HOST` | `127.0.0.1` | Host the console endpoint listens on. |
| `SUNRISE_ENDPOINT_PORT` | `30975` | Port the console endpoint listens on. |
| `SUNRISE_GAME_DIR` | `E:\Destiny_Sunrise` | Game install directory. `destiny2.exe` and the log both live under here. |
| `SUNRISE_FORK_DIR` | *(none — refuses)* | The Sunrise fork checkout, for `sync-fork`. No default: a built-in path belongs to whoever wrote it. |
| `SUNRISE_MSBUILD` | *(found via vswhere)* | An explicit `MSBuild.exe`, when vswhere finds the wrong install or none. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | *(none — stays quiet)* | Where `sync-fork` sends its summary. Both must be set. |

## When nothing connects

Run `install_check` first. Every other tool assumes a game directory, a settings file at one exact
path, and keys in it that only the fork's DLL has — and when an assumption is wrong they report a
*game* failure rather than the configuration problem it is.

The two answers worth knowing in advance:

- **`endpointDisabled`** — the fork ships `"console_endpoint": { "enabled": false }`. A clean
  install of the fork therefore has no listener, and every tool here fails with a refused
  connection while nothing in the game is wrong. Set `"enabled": true` under `server` >
  `console_endpoint` in `<game dir>\bin\x64\Sunrise\settings.json` and restart the game.
- **`notForkBuild`** — the settings carry neither `console_endpoint` nor
  `hold_character_select`, so no fork DLL has run in this install and nothing this server drives
  exists in it. Adding the keys by hand changes nothing; no code reads them. **Two different
  mistakes land here and the verdict cannot tell them apart**: the DLL really is a stock build, or
  it is the right build in the wrong folder. The loader takes `steam_api64.dll` from
  `<game dir>\bin\x64`, so one left beside `destiny2.exe` at the game root is never loaded, Sunrise
  never writes its keys, and the settings look exactly like a stock install's. Check
  `<game dir>\bin\x64\steam_api64.dll` before rebuilding anything.

`install_check` also reports the settings `version` field. The game migrates that file on its own
(upstream's `settings_upgrade.h`, bundled default 6 → 8), so a file written by a newer build is not
a broken one — and this server no longer treats it as such.

## Keeping the fork current

Every tool here talks to a DLL built from the Sunrise fork, so a fork that has fallen behind
upstream is a server answering about a game nobody else runs. Measured on 2026-08-23: six days of
drift was 43 upstream commits, 352 files and 3 conflicting ones. The same drift left for three
months is a project, not an afternoon.

```
npm run sync-fork -- --repo <fork checkout>      # or set SUNRISE_FORK_DIR
```

It fetches upstream, merges **in a throwaway worktree**, builds with MSBuild, and moves your branch
onto the result only when the build is green. It never resolves a conflict, and a failed run leaves
your checkout exactly as it found it.

| Outcome | What it means | Exit | Pings |
|---|---|---|---|
| `upToDate` | nothing upstream | 0 | — |
| `ready` | merged cleanly and compiles | 0 | — |
| `mergedNotBuilt` | merged cleanly, no build run, so unproven | 0 | yes |
| `dirty` | you have uncommitted changes, so nothing was touched | 1 | yes |
| `conflict` | the conflicting files are named; nothing was published | 1 | yes |
| `buildFailed` | merged cleanly, does not compile; nothing was published | 1 | yes |

A message is sent only when the run needs someone. The Actions history already carries green and
red, and GitHub mails a failed run on its own; Telegram is for putting the *reason* in front of
someone who is not looking at a dashboard. `mergedNotBuilt` pings despite exiting 0 — on the
scheduled job it can only mean MSBuild went missing from the runner, so the build silently stopped
being proof of anything.

Flags: `--no-build`, `--no-publish`, `--push`, `--json`. With `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` set, the same summary is sent to Telegram; with neither, it says so and carries
on.

## Run it / connect an MCP client

Point your MCP client at the built entry point, run under Windows node:

```json
{
  "mcpServers": {
    "sunrise": {
      "command": "C:\\nvm4w\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\sunrise-mcp\\dist\\index.js"]
    }
  }
}
```

The endpoint answers from the title screen, before the player has pressed anything — you don't
need to wait for a load after launching before calling `console_run` or `console_describe`.

## The tools

The base tools, registered in `src/index.ts` (`struct_read` and any other capability live below,
under [Capabilities](#capabilities-the-plugin-layer)). `console_run` and `console_describe` talk to
the console endpoint directly; the rest work through the game process, its log, its settings file,
its build, or the on-disk journal:

| Tool | Input | Output |
|---|---|---|
| `console_run` | `line: string` | The endpoint's structured response: `status`, `summary`, `rows`. |
| `console_describe` | — | The full command/variable registry. |
| `install_check` | — | What this install actually is, before believing any other tool's failure: `ok`, `gameDirNotFound`, `settingsMissing`, `settingsUnreadable`, `notForkBuild`, or `endpointDisabled`. Touches nothing. |
| `game_launch` | — | Starts `destiny2.exe` (killing any existing instance first) and waits for its window. |
| `game_kill` | — | `taskkill /IM destiny2.exe /F`, then waits for the process to actually leave the process table. Safe to call when the game isn't running. |
| `log_read` | `lines?: number`, `since?: string`, `filter?: {ev?, level?, channel?, text?}`, `mode?: 'lines' \| 'digest'`, `rareThreshold?: number` | With none of the new arguments, the tail of `sunrise.log` (default 200 lines, capped at 1000), unchanged. `since` (a previous call's `cursor`) reads only what's new and reports `rotated` across a restart. `filter` keeps only matching lines. `mode: "digest"` returns counts instead of lines, with rare events — and every warn/error — quoted verbatim. |
| `game_enter` | `character?: string` | Launches if needed, gets past the title screen, and waits for the world to load. With a character named, enters the world as that character and reports which one actually got in; without one, leaves the game at character selection. |
| `wait_for` | `ev?`, `level?`, `channel?`, `text?`, `count?`, `timeoutMs?`, `since?` | Blocks until a matching log line appears, then returns it plus a digest of everything else read while waiting. Use instead of polling `log_read`. |
| `fork_build` | `repo?: string` | Compiles the Sunrise fork (Release x64) and reports whether it built, without touching the running game. |
| `dll_deploy` | `repo?: string` | Copies the fork's freshly built `steam_api64.dll` into the install's `bin\x64`. Refuses while `destiny2.exe` is running. |
| `journal_note` | `text: string`, `kind?` | Writes one line to the on-disk journal, so it survives this session dying. |
| `journal_resume` | — | What previous sessions left behind: goal, findings, crashes, last character, log cursor. |

`console_describe` is authoritative for which console entries exist (`console.*`, `log.*`,
`movement.*`, `player.*`, `input.*`, `mem.*`, `character.*`, `bootflow.character_step`, and more
as the C++ side grows). The behavior that isn't in a help string — forced-key input, the memory
primitives' gates and blind spots, why `game_enter` owns its own ordering, the wire protocol
itself — is in `NOTES.md`, not repeated here.

> **Known limit — hands-free entry has no spawn.** `game_enter { character }` sets
> `client.hold_character_select = false` so it can pick the character and get in without the
> character screen. But entering that way lands the client in **orbit with no spawned body**:
> `player.position` returns `present: false` and there is nothing in the world to drive. Measured
> 2026-08-21 — a `game_enter { character: "warlock" }` reached orbit (`world_controller … falling
> back to a new character`) with no local player. A spawned, moveable player still needs the real
> character screen, which this path skips; `hold_character_select = false` also persists in the
> settings file, so restore it to `true` afterward or a later normal launch enters broken too.

## Capabilities (the plugin layer)

Beyond the base tools, the server auto-registers **capabilities**: richer MCP tools built by
composing the base primitives, added without touching `src/index.ts` or the game's C++ at all.

A capability is one file, `src/capabilities/<name>.ts`, exporting a `Capability` object —
`{ name, config: { description, inputSchema? }, run(args, ctx) }` — plus one entry in the barrel,
`src/capabilities/index.ts`. The loader (`src/capabilities/register.ts`) registers each as an MCP
tool automatically.

`run(args, ctx)` receives a `CapabilityContext` (`src/capabilities/contract.ts`) with the
primitives already injected:

- `ctx.console` — `runLine`/`describe` against the console endpoint.
- `ctx.mem` — a typed façade over `mem.*`. Currently `read(address: bigint, length: number)`,
  which chunks at 256 bytes (the console's own per-call cap) and reassembles.
- `ctx.game` — `launch`/`kill`/`readLog`/`processInfo`/`paths`.
- `ctx.log` — writes to stderr, same convention as the rest of the server.

### Example: `struct_read`

The first capability. Given a base `address` (decimal or `0x`-hex) and a list of `fields`
(`{ name, offset, type }`, `type` one of `u8/u16/u32/u64/i8/i16/i32/i64/f32/f64/ptr`,
little-endian x64), it reads the covering span in one `ctx.mem.read` call and returns
`{ address, fields: { name: value } }`. `u64`/`ptr` come back as `0x`-hex strings to keep 64-bit
precision, `i64` as a decimal string, everything else as a number.

```json
{
  "address": "0x00007FF612340000",
  "fields": [
    { "name": "e_magic", "offset": 0, "type": "u16" },
    { "name": "e_lfanew", "offset": 60, "type": "u32" }
  ]
}
```

Verified live: at the running image base, this decodes the PE header's `e_magic` as `0x5A4D`
("MZ") — see `scripts/struct-read-live.mjs`.

### `mem_changed_all` and `mem_read_range` — one call instead of a round trip per row

Both exist for the same reason, and it is worth knowing before you reach for `console_run`
directly. A console `Result` carries `kRowCapacity` = 16 rows and nothing more, so
`kMaxReadBytes` is `16 × 16` and `mem.read` answers **256 bytes a call whatever is in them**; a
page-level `mem.changed` spends nine of those rows on counts, leaving **seven addresses a call**.
Neither number is a mistake — naming the eight lowest changed pages and stopping would answer
nothing, because they are the same eight every time — but paying a round trip per seven is a cost
this layer can absorb without touching a core constant everything else depends on.

| Tool | Input | Output |
|---|---|---|
| `mem_changed_all` | `maxAddress?: string` | The whole `mem.changed` list in one call: `{ mode, changed, listed, returned, stoppedEarly, addresses }`. Photograph first with `console_run mem.watch <address>` — this compares, it does not photograph. The list is sorted, so `maxAddress` stops paging once past the range you care about. |
| `mem_read_range` | `address: string`, `length: number`, `joinDistance?: number` | `{ address, length, allZero, zeroBytes, runs }` — only the islands of non-zero bytes, each with its own address. An all-zero page comes back as `allZero: true` with no rows. |

Measured against the live game on 2026-08-26: a 4096-byte page that cost sixteen `mem.read` calls
and 256 hexdump rows by hand came back in **one** call as 4095 zero bytes and a single byte at
`+0xD8B`; and a 99-page comparison restricted to `.data` returned its 58 addresses in **one** call,
spending nine console round trips internally where paging by hand takes fifteen.

### Add a capability

1. Create `src/capabilities/<name>.ts` exporting a `Capability`.
2. Add it to the array in `src/capabilities/index.ts` — one import, one entry.
3. Use `ctx.console` / `ctx.mem` / `ctx.game` for anything that talks to the game; don't reach
   around them.
4. Write `scripts/<name>-smoke.mjs`: build a fake `ctx` (no game, no MCP framework) and assert
   against the decoded/returned result. Wire it into `npm run test:capabilities`.

That's the whole recipe — **no C++ changes, ever**, for a new capability. The design intent (kept
in `docs/superpowers/specs/2026-08-21-sunrise-mcp-capabilities-plugin-design.md`, outside this
repo) is that the C++ side stays a small, frozen set of generic primitives — `mem.*` and the
per-frame input drivers — and everything that tracks a fast-moving upstream lives here instead.

## Development & testing

```
npm run typecheck        # tsc --noEmit, same strictness, no emit
npm run test:capabilities  # builds, then runs the capability smoke scripts against fake ctx
npm run test:endpoint    # the endpoint client against fake TCP servers
npm run test:keys        # game_enter's decision logic, against a temp log file
npm run smoke             # needs a running game + Windows node
```

Tests are `.mjs` smoke drivers run with plain `node`, asserting against fakes — no game, no test
framework. The live-only scripts (`scripts/smoke.mjs`, `scripts/struct-read-live.mjs`) are the
exception: they need both a running game and Windows node, and say so in their own header.

See `NOTES.md` for the deep reference — the wire protocol, the retry policy, `game_enter`'s full
ordering and its measured failure modes, and the testing approach in more detail — and the design
spec above for why the capability layer is shaped the way it is.

## Over a long session

Three things change once you are working for hours rather than minutes.

**Read the log by cursor, not by tail.** Every `log_read` hands back a `cursor`; pass it as `since`
on the next call and you get only what is new. The log runs at roughly 0.3 to 2.4 MB an hour, so a
plain tail is the single largest consumer of an agent's context — and after the first few hours it
can no longer reach the start of the run at all. `mode: "digest"` counts the frequent events and
quotes only the rare ones: on a real 882-line log that is 34 lines out.

**Wait, do not poll.** `wait_for { ev: ["world_loaded"] }` returns the line you were waiting for
plus a count of everything that happened meanwhile. It gives up in about a second if the game dies,
rather than at its deadline. Its timeout is 55s because the *client* — not this server — owns the
request deadline and the MCP SDK's default is 60s; a timeout is not a failure, it hands back a
cursor, so a five-minute wait is six calls.

**The game restarting is handled, and reported.** If the game is found dead, its logs are harvested
into `bin\x64\Sunrise\mcp\crash-NNN\` **before** it is relaunched — the game overwrites its
previous log at every start, so harvesting afterwards would destroy the crash you wanted. The
process comes back; your character does not. The reply names the `game_enter` to call if you want
it. Three crashes in ten minutes stop the relaunching. Set `SUNRISE_MCP_SUPERVISOR=report` to be
told instead of restarted, or `off` to disable it entirely.
