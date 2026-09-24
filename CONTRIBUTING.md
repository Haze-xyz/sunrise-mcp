# Contributing

This project is a **snapshot, frozen on Sunrise 0.5.1**. It is not kept up to date with upstream
Sunrise by its author. Pull requests are welcome — bringing it forward to a newer Sunrise is the most
useful one — but there is no promise about when, or whether, one is looked at.

## Where a change goes

There are two repositories, and a change goes to the one that holds the code it touches.

| What you change | Open the pull request against |
|---|---|
| This MCP server (TypeScript: tools, capabilities, docs) | `main` of [Haze-xyz/sunrise-mcp](https://github.com/Haze-xyz/sunrise-mcp) |
| The C++ layer inside the game (`Sunrise/src/mcp/`, console entries, the endpoint) | the **`mcp`** branch of [Haze-xyz/Sunrise](https://github.com/Haze-xyz/Sunrise/tree/mcp) |

**Check the base of a C++ pull request before you create it.** `Haze-xyz/Sunrise` is a fork, and
GitHub proposes the upstream repository (`stanuwu/Sunrise`) as the base by default. The MCP layer is
not part of upstream Sunrise; a pull request for it belongs on `Haze-xyz/Sunrise`, branch `mcp`.

## Before you open one

**TypeScript side**

```bash
npm ci
npm run build
for t in scripts/*-smoke.mjs; do node "$t" || echo "FAILED: $t"; done
```

The smoke tests run against fakes: no game and no Windows are needed. `scripts/smoke.mjs` and
`scripts/struct-read-live.mjs` are the exception, they need a running game. `wrapper-smoke.mjs` is
known to fail about one run in three on a timing case; run it again before reporting it.

**C++ side**

- Keep the branch's shape: new code under `Sunrise/src/mcp/`, and only the calls into it in
  upstream files. `Sunrise/src/mcp/README.md` lists every one of those calls; add yours there.
- Build Release x64 with `/p:PreferredToolArchitecture=x64` (0.5.1 can run the compiler out of heap
  without it).
- A console entry you add or change should be answered by `console_describe`; say in the pull
  request what you checked in the game.

## What makes a pull request easy to take

- One change per pull request, with a description of what it does and how you checked it.
- Nothing in a comment or a doc that the code does not do.
- No secrets, tokens or personal paths in code, logs or fixtures.
