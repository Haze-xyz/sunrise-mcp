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

**Status: a snapshot, frozen on Sunrise 0.5.1.** It is not kept up to date with upstream Sunrise.
Pull requests that bring it forward are welcome, with no promise about when they are looked at.

## What it drives

The tools talk to a console that lives inside the game, in a Sunrise DLL built from the
[`mcp` branch of Haze-xyz/Sunrise](https://github.com/Haze-xyz/Sunrise/tree/mcp): upstream Sunrise
plus one folder, `src/mcp/`, and about fifty lines that call into it. That branch's
[`src/mcp/README.md`](https://github.com/Haze-xyz/Sunrise/blob/mcp/Sunrise/src/mcp/README.md) says
what the layer is and how to add it to your own Sunrise checkout. Against a stock Sunrise build every
tool here fails the same way, with a refused connection, because there is nothing to connect to.

## From nothing to a game that answers

```bash
# 1. this server
git clone https://github.com/Haze-xyz/sunrise-mcp && cd sunrise-mcp && npm install && npm run build

# 2. Sunrise with the MCP layer
git clone -b mcp https://github.com/Haze-xyz/Sunrise
cd Sunrise
msbuild Sunrise.sln /m /v:normal /p:Configuration=Release /p:Platform=x64 /p:PreferredToolArchitecture=x64
#    (without the last flag 0.5.1 can stop with C1060, "compiler is out of heap space")

# 3. copy build\x64\Release\steam_api64.dll into <game dir>\bin\x64\ -- NOT next to destiny2.exe:
#    the loader takes it from bin\x64 and never loads one left at the game root.
#    The dll_deploy tool puts it in the right place.

# 4. switch the console endpoint on. It is off unless this file says otherwise:
#    <game dir>\bin\x64\Sunrise\mcp.json  ->  {"endpoint":{"enabled":true}}
#    (game_enter writes it for you)

# 5. keep the game's log file on. Sunrise 0.5.1 ships it off, and log_read, wait_for and
#    game_enter read that file:
#    <game dir>\bin\x64\Sunrise\settings.json  ->  core > logging > "file_sink": true

# 6. tell this server where the game is
export SUNRISE_GAME_DIR='E:\Your\Destiny_Sunrise'
```

Then ask your MCP client to run `install_check`. It answers `ok`, or names which of six things is
wrong, and none of its answers is about the game.

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

## Configure

Everything is env vars:

| Variable | Default | Meaning |
|---|---|---|
| `SUNRISE_ENDPOINT_HOST` | `127.0.0.1` | Host the console endpoint listens on. |
| `SUNRISE_ENDPOINT_PORT` | `30975` | Port the console endpoint listens on. Match `endpoint.port` in `mcp.json` if you change it there. |
| `SUNRISE_GAME_DIR` | `E:\Destiny_Sunrise` | Game install directory. That default is the author's machine; set your own. |
| `SUNRISE_FORK_DIR` | *(none — refuses)* | Your Sunrise checkout, for `fork_build` and `dll_deploy` when no `repo` argument is given. |
| `SUNRISE_MSBUILD` | *(found via vswhere)* | An explicit `MSBuild.exe`, when vswhere finds the wrong install or none. |

## When nothing connects

Run `install_check` first. Every other tool assumes a game directory, a DLL with the MCP layer and
an `mcp.json` that switches its endpoint on, and when an assumption is wrong they report a *game*
failure rather than the configuration problem it is.

- **`notMcpBuild`** — there is no `bin\x64\steam_api64.dll`, or it was built without the layer
  (it is recognised by the menu page the layer registers, `mcp.console`). A DLL left beside
  `destiny2.exe` at the game root is never loaded, so check `bin\x64` before rebuilding anything.
- **`mcpConfigMissing`**, **`mcpConfigInvalid`**, **`endpointDisabled`** — the layer is there and
  its endpoint is off. Write `{"endpoint":{"enabled":true}}` to `bin\x64\Sunrise\mcp.json` and
  restart the game; `game_enter` does it before launching.

- **`logFileOff`** — everything else is right, but `core.logging.file_sink` is false in Sunrise's
  `settings.json`, so the game writes no `sunrise.log`, and `game_enter`, `log_read` and `wait_for`
  read that file. `game_enter` refuses to launch in that state. Sunrise 0.5.1 ships it false and
  rewrites the file with that default whenever its `version` is older than the build's, so a log
  that silently stopped is worth checking there.

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
| `install_check` | — | What this install actually is, before believing any other tool's failure: `ok`, `gameDirNotFound`, `notMcpBuild`, `mcpConfigMissing`, `mcpConfigInvalid`, `endpointDisabled`, or `logFileOff`. Touches nothing. |
| `game_launch` | — | Starts `destiny2.exe` (killing any existing instance first) and waits for its window. |
| `game_kill` | — | `taskkill /IM destiny2.exe /F`, then waits for the process to actually leave the process table. Safe to call when the game isn't running. |
| `log_read` | `lines?: number`, `since?: string`, `filter?: {ev?, level?, channel?, text?}`, `mode?: 'lines' \| 'digest'`, `rareThreshold?: number` | With none of the new arguments, the tail of `sunrise.log` (default 200 lines, capped at 1000), unchanged. `since` (a previous call's `cursor`) reads only what's new and reports `rotated` across a restart. `filter` keeps only matching lines. `mode: "digest"` returns counts instead of lines, with rare events — and every warn/error — quoted verbatim. |
| `game_enter` | `character?: string` | Makes sure `mcp.json` switches the endpoint on, launches if needed, gets past the title screen, and waits for the world to load. With a character named, enters orbit as that character and reports which one actually got in; without one, leaves the game at character selection. |
| `wait_for` | `ev?`, `level?`, `channel?`, `text?`, `count?`, `timeoutMs?`, `since?` | Blocks until a matching log line appears, then returns it plus a digest of everything else read while waiting. Use instead of polling `log_read`. |
| `fork_build` | `repo?: string` | Compiles your Sunrise checkout (Release x64) and reports whether it built, without touching the running game. |
| `dll_deploy` | `repo?: string` | Copies your checkout's freshly built `steam_api64.dll` into the install's `bin\x64`. Refuses while `destiny2.exe` is running. |
| `journal_note` | `text: string`, `kind?` | Writes one line to the on-disk journal, so it survives this session dying. |
| `journal_resume` | — | What previous sessions left behind: goal, findings, crashes, last character, log cursor. |

`console_describe` is authoritative for which console entries exist (`console.*`, `log.*`,
`movement.*`, `player.*`, `activity.*`, `input.*`, `mem.*`, `character.*`). The behavior that isn't in a help string — forced-key input, the memory
primitives' gates and blind spots, why `game_enter` owns its own ordering, the wire protocol
itself — is in `NOTES.md`, not repeated here.

> **Entering as a named character.** `game_enter { character }` makes the pick before the game
> signs in, so the client walks through the selection screen on its own. On Sunrise 0.5.1 that
> arrives in orbit with the ship, and a destination launched from there has a player in it:
> measured 2026-09-24, `player.position` answered `present: true` in the EDZ and a held key moved
> the character 17.9 units in 3 seconds. Before 0.5 the same route left no player at all.

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

That's the whole recipe — **no C++ changes, ever**, for a new capability. The design intent is that the C++ side stays a small, frozen set of generic primitives — `mem.*` and the
per-frame input drivers — and everything that tracks a fast-moving upstream lives here instead.

## Development & testing

```
npm run typecheck        # tsc --noEmit, same strictness, no emit
npm run test:capabilities  # builds, then runs the capability smoke scripts against fake ctx
npm run test:endpoint    # the endpoint client against fake TCP servers
npm run test:keys        # game_enter's decision logic, against a temp log file
npm run test:install     # install_check and mcp.json, against fixtures
npm run test:build       # fork_build's arguments and verdict
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
