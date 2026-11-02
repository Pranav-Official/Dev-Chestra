# @devchestra/e2e-workflows

Bounded acceptance suite for workflow authoring, runs and the editor. It starts the real CLI (`devchestra start`) with an
owned temporary data directory, real SQLite, the real MCP shim, the real fake
agent and the built web app. It never mocks route handlers and never calls a paid
model CLI.

## Commands

```sh
pnpm --filter @devchestra/e2e-workflows typecheck
pnpm --filter @devchestra/e2e-workflows test        # real HTTP/ETag/conflict/security
pnpm --filter @devchestra/e2e-workflows test:e2e    # real Chromium authoring/run/conflicts/models/a11y
```

Root aliases: `pnpm test:workflows`, `pnpm test:e2e:workflows`.

Prerequisites fail the run rather than skipping: `packages/cli/dist`,
`apps/web/dist/index.html`, the MCP shim, `tools/fake-agent/dist/main.js`,
`node:sqlite` and Chromium (`DEVCHESTRA_CHROMIUM_PATH` or `/usr/bin/chromium`).

## Ports and isolation

There is no fixed port. `devchestra start --port 0` chooses an ephemeral loopback
port, read from `<temp-data-dir>/server.json`. Chromium uses a temporary
persistent profile. Every test workspace is under `mkdtemp`; nothing is written
inside the repository or to `~/.devchestra`.

Cleanup stops only the launched server (pid + canonical pidStart), the recorded
agent processes and the run sandboxes owned by that temp data directory. A
sentinel process must survive cleanup. Timeout uses the same cleanup path.

## Coverage

- Managed workflow CRUD, quoted ETags/If-Match, stale conflicts, canonical
  save/load/save, layout-only diffs, invalid drafts, validation and async runs.
- Idempotency, two-editor conflicts, external edits, explicit reload/overwrite,
  in-flight saves, invalid buffers and fresh-revision runs.
- Traversal, encoded paths, symlink/hardlink escapes, foreign projects, missing
  headers, unknown fields, oversize bodies, Host/Origin/CSRF and strict CSP.
- Browser project registration, blank workflow authoring, palette/inspector,
  handles, undo/redo, run modal, live viewer, transcript, close/reopen, snapshot
  immutability, light/dark/narrow, keyboard focus and axe.
- Flexible output: new-Agent Raw JSON object, save/reload/run with unknown nested
  records visible in the viewer, Any-field declaration, and the existing strict
  Structured flow explicitly selected and preserved (points maxItems 8 -> 7
  with items.maxLength 500).
- Automatic handoff: a real two-agent Chrome flow with plain prompts and no
  templates. Agent 1 returns a runtime nonce plus 14 records; Agent 2's actual
  fake process extracts the automatic `<devchestra_input_context>` data block and
  submits the received value through the real MCP/gateway.
- Model selector: a real `codex`/`claude` PATH stand-in, cache-only GET with no
  spawn, explicit app-server `initialize`/`initialized`/`model/list` refresh with
  pagination, fuzzy/default/custom selection, CLI-change undo, stale/failure
  fencing, exact `-m` on the run argv, light/dark/narrow axe and screenshots.
  Test HOME/CODEX_HOME are temporary sentinels; no user auth is read.
- Claude discovery: the built `@devchestra/adapters` uses the published
  `@anthropic-ai/claude-agent-sdk` against the PATH `claude` stand-in. Cold GET
  is lazy `unavailable` with zero spawn; explicit refresh is `ready` /
  `claude-sdk` with dynamic `ModelInfo.value` ids, one SDK child, and only an
  initialize control frame (no user/turn/tool/session/login/config frame).
  Cached GET, context invalidation, single-flight, stale failure, timeout and
  secret-free responses are checked over real HTTP. Chromium loads the dynamic
  models while the picker is open, fuzzy-searches, selects/saves/reloads/undoes
  the exact id, fences an older Claude request across a CLI switch, runs the
  exact `--model` value, and reports light/dark/narrow axe results.

## Not claimed

- Other packages' suites, full `pnpm test`/`pnpm check`, CI and macOS.
- Node 22 locally. This evidence is Node 26.11.1; a user reported Node 22.22.3
  passing, but that was not executed by this driver.
- Maps, pins, imports/exports, live providers or release packaging.
- Duplicate HTTP response observation on the browser double-click path; the
  assertion is one run id/count and one unique run.
- The real Claude CLI was not invoked. The SDK is the published package, but its
  child is a trusted personal stand-in; network/auth/managed-policy side effects
  of a real CLI remain unverified and no provider entitlement is claimed.
