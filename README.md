# sunrise-mcp

An MCP server for the Sunrise console endpoint: it drives and inspects a **running** Destiny 2
"Sunrise" private server (the game process is itself the server) over a loopback line protocol.
Two things it's for, in priority order:

1. **Reverse engineering** — read, scan, and write the live game's memory, and decode structs out
   of it.
2. **Control** — get the game into the world (past the title screen, optionally as a named
   character) and drive input once it's in.

It exposes six base MCP tools over the console endpoint, plus an extensible **capabilities**
layer for composing them into richer tools without touching the game's C++ at all.

## Requirements & where it runs

- **A Sunrise install built from the private Sunrise fork this repo pairs with** —
  `Haze-xyz/Sunrise-build79433`, branch `layer2-entry` — not from upstream `stanuwu/Sunrise`.
  Everything this server talks to — the console endpoint (the `127.0.0.1`-bound listener), the
  `mem.*` primitives, `character.*`, forced-key input — is that fork's addition to the
  `steam_api64.dll`; upstream Sunrise has none of it, so against a stock install nothing here
  connects and every tool fails the same way (connection refused). You need the game with that
  fork's DLL deployed — so access to that fork (or a DLL built from it) — before any of this is
  useful.
- Node ≥ 20.
- The server must run on **whatever machine can reach the game's loopback socket** — and since
  Destiny 2 is Windows-only, that's Windows. This isn't a preference, it's what the endpoint is:
  a `127.0.0.1`-bound TCP listener inside the game process. Point your MCP client at a Windows
  `node.exe`.
- **If you develop under WSL:** `npm install`, `npm run build`, and `npm run typecheck` are
  ordinary TypeScript and work fine there. But *running* the server — anything that actually talks
  to the game — needs Windows node. WSL runs NAT'd on this kind of setup, so a WSL process's
  `127.0.0.1` is the WSL VM's own loopback, not the Windows host's; it can never reach the
  endpoint. See `NOTES.md` for what that looks like when you get it wrong (connection refused, or
  a silent hang against the wrong loopback).
- This repo is private. It pushes to a private `backup` remote only — never a public fork, never
  upstream, never a PR.

## Install & build

```
npm install
npm run build       # tsc -p tsconfig.json, emits dist/
```

Strict TypeScript throughout: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
no `any`, no `@ts-ignore`.

## Configure

Everything is env vars, with Windows-appropriate defaults:

| Variable | Default | Meaning |
|---|---|---|
| `SUNRISE_ENDPOINT_HOST` | `127.0.0.1` | Host the console endpoint listens on. |
| `SUNRISE_ENDPOINT_PORT` | `30975` | Port the console endpoint listens on. |
| `SUNRISE_GAME_DIR` | `E:\Destiny_Sunrise` | Game install directory. `destiny2.exe` and the log both live under here. |

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

Six base tools, all over the console endpoint:

| Tool | Input | Output |
|---|---|---|
| `console_run` | `line: string` | The endpoint's structured response: `status`, `summary`, `rows`. |
| `console_describe` | — | The full command/variable registry. |
| `game_launch` | — | Starts `destiny2.exe` (killing any existing instance first) and waits for its window. |
| `game_kill` | — | `taskkill /IM destiny2.exe /F`, then waits for the process to actually leave the process table. Safe to call when the game isn't running. |
| `log_read` | `lines?: number` | The tail of `sunrise.log` (default 200 lines, capped at 1000). |
| `game_enter` | `character?: string` | Launches if needed, gets past the title screen, and waits for the world to load. With a character named, enters the world as that character and reports which one actually got in; without one, leaves the game at character selection. |

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

Beyond the six base tools, the server auto-registers **capabilities**: richer MCP tools built by
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
