# AGENTS.md — working in sunrise-mcp

Best practices for contributors and AI agents working in this repo. Read `README.md` first for
what the server is; this file is about how to change it.

## Philosophy

The C++ side (the DLL, in the sibling `Sunrise` repo) stays a small, **frozen** set of generic
primitives: `mem.*` (read/scan/write/resolve/module) and the per-frame input drivers (`input.*`).
Everything that needs to track a fast-moving upstream — new object layouts, new interactions, new
composed workflows — grows here, as capabilities, instead. That's a deliberate trade: a generic
`mem.read`/`mem.write` already inspects and can act on any future struct, so the C++ divergence
cost of chasing upstream changes is zero as long as the primitive set doesn't need to grow.

Two purposes, in priority order:

1. **Reverse engineering.** Read, scan, and decode the live game's memory. This is what the
   generic primitives are for, and why they're generic rather than shaped around any one struct.
2. **Control.** Get the game into the world and drive it. Secondary — it rides on the same
   primitives (`input.*`, the log-marker waits) rather than growing its own C++ surface.

See `docs/superpowers/specs/2026-08-21-sunrise-mcp-capabilities-plugin-design.md` (outside this
repo — it lives with the other SDD workspaces) for the full design rationale behind the
capabilities layer.

## Repo layout

- `src/` — the base MCP server: `endpoint.ts` (the wire client), `game.ts` / `tasklist.ts` (Windows
  process/log helpers), `keys.ts` / `game-enter-decision.ts` / `press-record.ts` /
  `character.ts` / `serialize.ts` (the `game_enter` machinery), `index.ts` (wires all of it into
  six MCP tools and registers the capability layer).
- `src/capabilities/` — the plugin layer: `contract.ts` (the `Capability`/`CapabilityContext`
  types), `mem.ts` (the `mem.*` façade), `context.ts` (`buildContext`, assembling the real
  context), `register.ts` (the loader), `index.ts` (the barrel — one array every capability is
  added to), and one file per capability (`struct-read.ts` today).
- `scripts/` — smoke tests (`.mjs`, run with plain `node`) and the PowerShell helpers `game_enter`
  shells out to.
- `dist/` — build output. Never edit by hand; `npm run build` regenerates it.

## Add a capability

1. Create `src/capabilities/<name>.ts` exporting a `Capability`: `{ name, config: { description,
   inputSchema? }, run(args, ctx) }`. Type `args`/`ctx` against `src/capabilities/contract.ts`.
2. Add one import and one array entry in `src/capabilities/index.ts`. Nothing else changes — no
   edit to `src/index.ts`, no edit to the C++ repo.
3. Inside `run`, reach for `ctx.console` (raw `runLine`/`describe`), `ctx.mem` (the typed façade —
   currently just `read(address, length)`), `ctx.game`, or `ctx.log`. Don't import `endpoint.ts` or
   spawn processes directly from a capability — the point of the context is that everything a
   capability needs is injected, so it can be tested against a fake.
4. Write `scripts/<name>-smoke.mjs`: build a fake `ctx` (plain objects/functions, no game, no MCP
   framework) and assert against the decoded/returned result. Add it to the `test:capabilities`
   script in `package.json`.
5. If a live check is worth having (see `scripts/struct-read-live.mjs` for the pattern), keep it as
   a throwaway `.mjs` outside the committed suite — it needs the real game and Windows node, so it
   can't be part of `npm run test:capabilities`.

## Environment gotcha: build anywhere, run on Windows

`npm install`, `npm run build`, `npm run typecheck`, and every fake-based smoke script
(`test:endpoint`, `test:keys`, `test:capabilities`) are ordinary TypeScript/Node and work under WSL
node. **Anything that actually talks to the game — running the server itself, or the live-only
scripts (`smoke.mjs`, `struct-read-live.mjs`)** — needs Windows node, because WSL runs NAT'd here:
a WSL process's `127.0.0.1` is the WSL VM's own loopback, not the Windows host's, and the game
binds `INADDR_LOOPBACK` on the Windows side. Never point a WSL node binary at the endpoint. The
failure mode is not always an obvious error: if nothing else is listening on the WSL VM's loopback
at that port you get connection-refused, but if something else happens to be, you get a silent
hang — the TCP connect succeeds against the wrong host and every request just sits there until the
client's own request timeout fires. See `NOTES.md` for the wire protocol and retry policy this
plays into.

## One connection at a time

The endpoint serves exactly one client, for the life of that client's *process*, not the life of a
single call. A second connection attempt is accepted just long enough to be answered
`{"id":0,"status":"refused",...}` — carrying a `holder_port` row naming the process actually
holding the slot — and then closed. Don't run two servers, two smoke scripts, or a server and a
live smoke script against the game at once; the second one is refused, not queued. If you hit
`EndpointBusyError`, that row is what tells you which process to kill.

## Testing idiom

Everything that doesn't need the real game is a `.mjs` smoke driver asserting against a hand-built
fake — no test framework, no mocks library. `endpoint.ts` is tested against small fake TCP servers
speaking the real wire protocol on ephemeral ports (`scripts/endpoint-smoke.mjs`); the pure
decision logic (`decideGameEnterAction`, `decideCharacterStep`, `decideCharacterVerdict`,
`isPressRecordFresh`, capability decoders like `decodeStruct`) is tested with plain case tables and
no I/O at all; log-marker waiting is tested against a real temp file, not a fake, since the
functions under test only ever touch a path parameter. Live checks (`scripts/smoke.mjs`,
`scripts/struct-read-live.mjs`) run under Windows node against the actual game and are kept
separate from the committed fake-based suite for exactly that reason. When adding a "concurrent" or
"ordering" test, make sure the fake can actually distinguish a correct implementation from a wrong
one that happens to satisfy the same assertions — see `NOTES.md`'s "On testing dispatch
correctness" for a worked example of a test that initially couldn't.

## Privacy / remotes

This repo is private. It pushes to a private `backup` remote only. Never `origin`, never a fork,
never a PR — this is not published anywhere.
