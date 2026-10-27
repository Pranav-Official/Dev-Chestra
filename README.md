# Relay / DevChestra

Local, single-user workflow orchestrator for headless coding agents. **P3 plus the first P4 routing increment (complete and frozen) plus P3.5 human-approval (integrated non-browser verified, focused browser 1/1, full suite pending; full P4/G4 open):** the P1 runner and P2 loopback server/run viewer now include a browser graph editor for `start`, `agent`, `shell`, `gate`, `join`, `approval` and `end`, a per-CLI fuzzy model selector for Agent nodes (native Codex and Claude catalogs), and a top-level gate/join/approval DAG. Gate branches evaluate in order with a mandatory last `otherwise`; joins support exclusive `first` and `all` with `null` for skipped inputs; skipped paths are explicit; the bounded gate tester previews expressions without starting a run. Approval pauses `waiting_approval` for manual approve/reject with optional note (WIP ≤4096 / criteria 32×≤256) and durable atomic request/resolution via stable `requestId`+`attempt`/`generation` fence and optional `approvalId.rejected` edge; inbox/replay are event-based, no auto-approve/timeout. You can register a project, create a blank workflow, add and configure nodes, connect them, save with conflict-safe ETags, reload, and run it into the live viewer without editing JSON. The runner still uses the real MCP shim, SQLite event store, workspace safety, engine and fake/Claude/Codex adapter contracts. Each workflow execution chooses **one workspace at Start**: the registered project root by default (dirty and untracked files included; direct execution is authorized), an existing Git worktree, or a new per-run worktree (initially detached). Every Agent and Shell step uses that same cwd; the per-node workspace selector is gone, and legacy per-node metadata only affects old run snapshots. Remaining P4 work is decisions, maps, loops and operations/editor controls. There is **no** artifact pin/capture, node-test/pin workflow, import/export, budget enforcement, context bank or release packaging yet. See [docs/build-status.md](docs/build-status.md) for evidence and open gates, and [docs/p4-routing-plan.md](docs/p4-routing-plan.md) for the routing increment.

The product name is provisional (`Relay` internally). Do not create durable user-facing paths or publish under a final name until that decision is recorded.

## Prerequisites

- Node.js **22 or newer** (local development in this workspace uses Node 26.11.1)
- pnpm **10.14.0** (declared in `packageManager`)
- Git 2.30+ (required only for the existing-worktree and new-worktree run options; the default project root also works for non-Git folders)
- Linux or macOS; Windows is not supported natively (WSL2 only)

## Install

```sh
pnpm install
```

The lockfile is present in the workspace. CI installs with `pnpm install --frozen-lockfile`.

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Runs `build` in every workspace package that defines it |
| `pnpm test` | Builds the workspace first, then runs `test` in every package that defines it |
| `pnpm typecheck` | Builds workspace packages (so cross-package types resolve), then runs `typecheck` in every package that defines it |
| `pnpm check` | Biome, build + recursive typecheck, dependency-cruiser and a browser bundle check |
| `pnpm test:root` | Runs root-only Vitest tests (`tests/**/*.test.ts`) |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format (write) |
| `pnpm depcruise` | Dependency direction check over `packages`, `tools` and `apps` |
| `pnpm audit --audit-level high` | Dependency audit at high severity; CI also runs it |
| `pnpm relay ...` | Runs the CLI from source with the workspace root as cwd (`relay --help`) |
| `pnpm relay:start --data-dir <dir>` | Starts the loopback web server, editor and viewer (requires `apps/web/dist`; add a trusted `--fake-script` for fake agent nodes) |
| `pnpm relay:run ...` | `relay run` forwarding |
| `pnpm relay:resume <runId> ...` | `relay resume` forwarding |
| `pnpm relay:doctor ...` | `relay doctor` forwarding |
| `pnpm web:build` / `pnpm web:dev` | Vite production build / dev server for `apps/web` |
| `pnpm demo:p0` | Runs the bounded P0 happy + recovery demo with the fake agent |
| `pnpm demo:p1` | Historical P1 scratch-only CLI smoke with true backend SIGKILL/resume (predates run-level workspaces) |
| `pnpm demo:p2` | Runs the real loopback API/SSE viewer replay and browser acceptance demo |
| `pnpm demo:p3` | Runs real workflow authoring, conflicts, restart, run and browser editor acceptance |
| `pnpm test:p3` | Runs the bounded P3 real-HTTP/security harness tests |
| `pnpm test:e2e:p3` | Runs the Chromium P3 editor/autosave/conflict/run-and-a11y e2e test |

Recursive scripts use `pnpm -r --if-present`: a package without that script is skipped, while a real package failure still fails the command. Do not replace this with a script that hides failures. `pnpm test` builds first so integration tests that need package `dist` output cannot silently skip on a fresh install.

### P0 demo

```sh
pnpm demo:p0
```

Runs the bounded P0 slice with the fake agent (no live model calls): real stdio MCP shim, loopback gateway, SQLite store, accepted-output finalization, plus a recovery scenario where the agent is SIGKILLed and the store is closed/reopened. It prints a JSON summary and exits 0 on success. The recovery scenario sets `backendProcessKilled: false`, so P0 does not itself prove backend SIGKILL recovery; see the P1 demo for that fake-agent proof. Real-CLI mid-run crash recovery remains open. See [tools/p0-demo/README.md](tools/p0-demo/README.md) and [docs/build-status.md](docs/build-status.md).

### P1 linear CLI and demo

A minimal fake-agent run from the repository root:

```sh
cat > /tmp/relay-fake-script.json <<'JSON'
[{"type":"submit","output":{"summary":"Relay README smoke","points":["one","two"]}}]
JSON

pnpm relay run examples/linear-fake.json \
  --project . \
  --data-dir /tmp/relay-dev \
  --param topic=relay \
  --fake-script /tmp/relay-fake-script.json \
  --json
```

Fresh `relay run` defaults to the registered project root; the starter example omits per-node workspace metadata. Add `--workspace new-worktree` for a fresh per-run worktree, or `--workspace existing-worktree --worktree-path <dir>` to reuse one; `resume` keeps the run's frozen choice. The fake CLI is test-only. `pnpm relay:doctor --data-dir /tmp/relay-dev` runs diagnostics. `relay run` requires an explicit data dir in this milestone.

For an interrupted/non-terminal fake run, resume with the same script; the checkpoint does not embed it:

```sh
pnpm relay:resume <runId> --data-dir /tmp/relay-dev \
  --fake-script /tmp/relay-fake-script.json --json
```

For a real Claude Code/Codex run, pass `--allow-experimental-adapters` again on resume as well as on run.

The historical `pnpm demo:p1` proved the bounded P1 path: it SIGKILLs the CLI process that hosts SQLite, the engine and the gateway, then resumes the same run in a fresh process. It also exercised accepted-output recovery and an explicitly retried uncertain shell effect. It uses the fake agent and makes no paid model calls. That demo predates run-level workspaces and is preserved as P1 evidence; see [docs/build-status.md](docs/build-status.md) for the current gate state.

Claude Code and Codex adapter contracts are implemented. Basic live fresh + resume was smoke-tested separately, but OS sandbox/permission enforcement, real-CLI crash handling and live mid-run recovery remain unverified; see [docs/build-status.md](docs/build-status.md).

### P2 loopback API and read-only viewer

Build the workspace first: the server refuses to start without `apps/web/dist` and does not serve a placeholder viewer. Use a **persistent** data directory if you want to open the viewer after the producing process exits. The P0/P1/P2 demos use throwaway temp directories and delete them, so their runs are not viewable afterwards.

Seed one fake-agent run into a persistent directory, then start the viewer against the same directory:

```sh
pnpm build
data=/tmp/relay-view
mkdir -p "$data"
cat > /tmp/relay-fake-script.json <<'JSON'
[{"type":"submit","output":{"summary":"Viewer seed","points":["one","two"]}}]
JSON
pnpm relay run examples/linear-fake.json \
  --project . \
  --data-dir "$data" \
  --param topic=relay \
  --fake-script /tmp/relay-fake-script.json \
  --json
pnpm relay:start --data-dir "$data"
```

`start` holds the data-directory lock; do not run `relay run`/`resume` against the same directory while it is live (the intended single-instance rule).

`--data-dir` is required and there is no `~/.relay` fallback. `start` binds loopback only and chooses the first free port in 4821–4890 (or an ephemeral port with `--port 0`); a taken explicit port falls back to an ephemeral one and reports the actual URL. The browser opens by default with a session `?t=<token>` bootstrap URL (the token stays valid until the server restarts); `--no-open` and `--print-url` control that. The token is written owner-only to `<dataDir>/server.json` for the CLI and is not printed in `--json` output. A second `start` attaches to a verified live instance instead of creating a second session.

The viewer is read-only: project and run lists, run detail, execution attempts, paged transcripts, complete event history and event-based replay with a scrubber. Replay uses the shared reducer, disables mutation affordances, and can be linked with `?at=<eventId>`. SSE reconnects from `Last-Event-ID` and refetches on overflow; the live run stream is separate from the low-volume global hints stream. Execution process times are read from stored integer epoch milliseconds; invalid stored timestamps fail with `E_INTERNAL` instead of rendering a fabricated date. Frozen clean: `pnpm check` **567/1950/4 exit 0** with non-browser **1126/135** (`1074/122` + `50/13`, web **190/24**); independent focused P3.5 **1/1 in 9.21s** on `index-CKcmjq75.js` (`/tmp/codex-p35-browser-clean.log`) + HTTP **9/9** valid. Overall Chromium **8/9** on preceding equivalent source: P3.5 + model pass, **P4 routing fails `waitDeadEdges` after succeeded run** (log `/tmp/codex-p35-e2e-fixed.log`; isolated drag fails) — no claim 9/9. Historical routing **1050/124** (`index-ilEE3nLD.js` 1/1 11.59s + 8/8 122.39s) and P3 **915/105** remain historical. Session replay race fixed, limits `note ≤4096`/`criteria 32×≤256` verified, instrumentation removed. Local Linux only, no CI/macOS/live-provider.

`pnpm demo:p2` exercises the real server, temp SQLite, MCP shim, fake agent and built web app: project/run views, live events, tab close/reopen, offline reconnect banner, replay matching the server projection, HTML escaping, keyboard/theme checks and axe with zero serious/critical violations. It also runs bounded API paging and negative security scenarios. It makes no paid model calls and needs a local Chromium; the Playwright e2e entry is `pnpm --filter @relay/p2-smoke test:e2e`.

### P3 workflow authoring and editor

P3 introduced the browser editor for the original four node types (`start`, `agent`, `shell`, `end`): palette add, connect/delete/move, undo/redo, parameter/prompt/output-schema/permission fields, Structured output-schema rows or a Raw JSON object, live validation in a Vite module worker, and conflict-safe autosave. The server validates again on save and run. The P4 routing increment adds `gate` and `join` to the same editor with typed branch/input handles. Unsupported node types cannot run or appear fully functional.

#### Run workspace selection

Choose the workspace once, in the Start/Run dialog, for the whole execution. The default is the registered project root: steps run directly in that directory, including uncommitted tracked edits, untracked files and ignored files, and can edit live project files. Relay does not copy the project, commit, roll back or sandbox writes in this mode. This is the authorized direct-project execution path, not a read-only mode.

**Existing Git worktree** lists the project's linked worktrees from `git worktree list` with path, branch or detached HEAD and HEAD commit. The registered root is the default and is not repeated as an alternative. Relay validates the canonical path and repository identity before starting; a path not in that list is rejected. **Create a new Git worktree** creates a per-run worktree at `<dataDir>/projects/<projectId>/runs/<runId>/worktree` when the run starts, initially detached at the project's committed `HEAD`. It contains the files committed at that revision: uncommitted tracked edits, untracked/ignored files and untracked/ignored dependency directories such as `node_modules` are absent, and no setup command runs.

Every Agent and Shell step in the run uses the same chosen cwd. The selection is frozen into the run record; the internal binding also stores the registered project root, while the browser sees only the selection. Restart/resume and history replay reuse the same workspace and never switch to a later editor choice. A missing or malformed binding fails closed. Runs created before run-level workspaces have no binding and keep their historical per-node scratch/worktree behavior.

Scoped browser acceptance of this selector passed 1/1 in 8.52s with actual Chromium, an ephemeral CLI server, temporary Git/HOME/data and the fake agent. It verified root dirty/untracked visibility, an existing worktree at the exact path, a new checkout under the data directory, one cwd for every agent and shell, no inspector selector, one POST per run, and cleanup sentinel/no-orphan checks. All 7 distinct Chromium regression scenarios are verified: the full suite passed 6/7, the sole failure was a stale old per-node `workspace-review` assertion, and an assertion-only correction plus focused rerun passed 1/1 in 6.59s against unchanged dist. This is not a second full 7/7 invocation.

Agent and Shell inspectors no longer expose a workspace selector. Fresh nodes and templates omit per-node workspace metadata; legacy per-node fields remain parseable for old documents and snapshots but are ignored by fresh runs. Relay finalizes each step with bookkeeping under the data directory; it never deletes, auto-commits or cleans up the project root or an existing worktree, and writes no Relay marker into a user checkout. A new per-run worktree is not merged, committed, given a retained branch or automatically cleaned up. A new worktree starts detached; later workflow commits may advance its HEAD. The initial base is recorded for evidence only. Worktree `base`, `setup` and `from` options are unsupported. None of these modes is an OS sandbox or read-only mode: steps run with the process's ordinary permissions, and project-root or existing-worktree steps can reach project paths by absolute path.

### P4 routing increment (gate + join)

This is the first P4 increment, for the **top-level graph only**. Gate and Join do not create container scopes; approvals, decisions, maps, loops and operations/editor controls remain later increments.

- **Gate** branches are ordered. The first `when` that evaluates to `true` wins; the mandatory last `otherwise` runs only when no earlier branch matched. A non-boolean result or expression error fails the gate with `E_EXPR` and never falls through to `otherwise`. The editor blocks duplicate/missing/early `otherwise` branches, limits a gate to 32 branches, and exposes typed `out:<branchId>` handles.
- **Join** supports `first` and `all`. `first` requires exactly one active input at resolution; more than one is `E_JOIN_CONFLICT`. `all` waits for every declared input and stores `null` for dead/skipped inputs. Inputs are declared names and edges target `in:<inputName>`; an optional output schema is validated when set, and is required for a referenced `first` join with differing source schemas.
- **Skipped paths** are explicit: zero active inbound edges skips a node recursively, edges become dead, and a skipped branch's value resolves to `null`. Once all settled work is complete, more than one active End fails the run with `E_WORKFLOW_INVALID`.
- **Gate tester:** the inspector previews a gate against a JSON sample scope through `POST /api/projects/:pid/gates/test` (`{ gate, scope } -> GateEvaluation` with `branch`, `evaluated` and optional `error`). It runs the same bounded evaluator as the engine, writes no run/event/output/definition, and spawns no CLI or workflow subprocess. Limits are 32 KiB scope, 64 KiB request body, 4 KiB per expression, 250 ms per branch and 2 s overall; the worker is allowed.
- **Viewer and recovery:** run views project `gateDecision` and `joinResolution`, show the chosen/failed branch and active/skipped join input names, and style dead edges. Both are rebuilt from persisted events on replay/resume; a restart does not re-decide a gate or re-resolve a join.

Routing source remains historical **1050/124** (1046/123 + 169/22, 543/1828); post-fix integrated is **1126/135** (1074/122 + 50/13, web 190/24) with 567/1950; focused P3.5 1/1 + HTTP 9/9 valid, full suite 8/9 with routing dead-edges failure.

Build first, then start against a data directory you already use. Starting does not seed projects or rewrite project files; it reads the existing registry and serves the built app.

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$HOME/relay-data"
pnpm relay:start --data-dir "$HOME/relay-data" \
  --fake-script tools/fixtures/p3/scripts/summary.json
```

`relay start` serves `apps/web/dist`. After `pnpm build` rebuilds the web app, **restart the server manually** if an older process is already running; it will not load the new assets by itself. Existing definitions and past run history are not rewritten: change an agent node's output mode explicitly if you want the new behavior. Automatic input handoff applies to new invocations only. The command opens the loopback URL with a bootstrap token; `--no-open` and `--print-url` control that. Use your own persistent `--data-dir`; do not point the P0–P3 demos at it because they use throwaway temporary directories. The bundled fake script submits `{ "summary", "points" }`; configure the agent output schema to match it, or pass your own trusted `--fake-script` file.

In the browser, with no JSON editing:

1. Register the project once if it is not already listed (absolute path).
2. Create a blank workflow from the project's Workflows tab.
3. Drag Start, Agent, Shell and End onto the canvas.
4. Configure the start parameters, agent prompt/output schema, shell command and end result in the inspector.
5. Connect Start → Agent → Shell → End. Invalid or duplicate connections are blocked with a visible explanation.
6. Save and reload; the canonical file and layout persist. If the file changed on disk, resolve the conflict instead of overwriting blindly.
7. Run the workflow and follow the same run in the live viewer.

#### Flexible agent output

Agent nodes have two output modes. **Structured fields** is the existing JSON Schema row editor. **Raw JSON object** accepts free-form objects without enumerating properties and is the default for newly added palette Agent nodes; existing workflows and templates keep their saved contract until you explicitly change the mode. Switching back to Structured preserves your existing custom constraints rather than silently replacing them.

A property whose schema is `{}` is shown as **Any** and accepts any JSON value. Explicit `additionalProperties: true` is supported for object schemas, including nested objects. Existing omitted/false `additionalProperties` stays closed and its normalized strict hash is unchanged. The top-level `submit_result` argument must still be a JSON object for MCP; put arrays or scalars under an Any property, for example `{ "value": [1, 2] }`.

A connected agent now receives its inputs automatically: every invocation gets a clearly labelled JSON reference block with the resolved Start parameters and every accepted ancestor output. Fresh, resumed and no-submit corrective calls all include it. Plain prompts are enough; `{{agent}}`-style references are optional and are not required to hand data to a connected agent. A Raw workflow therefore needs no schema change or rewiring to consume its inputs; a plain prompt such as `Sort by total_stars (desc)` is enough.

Only agent input is automatic. Shell commands still interpolate values through their normal templates/quoted interpolation, and End results still need an explicit result expression; no automatic command append or End inference is added. The final CLI-bound prompt is capped at 1 MiB UTF-8 and oversize input fails before spawning with `E_VALIDATION`, with no silent truncation. The editor's 48 KiB preview truncation is display metadata only and never drops CLI input.

Raw output is not an arbitrary-text completion fallback. Authenticated submit, JSON representability and byte bounds, secret guards, durable receipts, identity fencing and verified finalization still apply. Existing accepted history is not rewritten.

#### Agent model selector

The Agent inspector's model field is a fuzzy-searchable selector backed by the selected CLI's catalog. Opening it reads the cache only (`GET /api/projects/:pid/clis/:cli/models`) and never spawns a CLI. **Load models** / **Refresh models** triggers the explicit, CSRF-protected `POST .../models/refresh`.

1. Choose the Agent node's CLI (Codex or Claude).
2. Press **Load models** to run bounded native metadata discovery. Codex uses the app-server `initialize` plus paginated `model/list` path (no thread or turn). Claude uses the published Agent SDK with a prompt-free, never-yielding input: only the initialize handshake runs, with no user frame or model turn. The cache is per project/CLI with a five-minute TTL, 64 entries, 2 concurrent discoveries, single-flight and stale-last-good behavior.
3. Type to filter locally by id, label, provider or alias, then select and save. The exact catalog ID is stored in the existing optional `node.model` and passed to the CLI unchanged (`-m` for Codex, `--model` for Claude). Claude uses `ModelInfo.value` exactly and never substitutes `resolvedModel`; Codex uses the exact `model` value. Relay does not substitute another model.

**Use CLI default** clears the override (absent `node.model`). **Use custom model ID** stores an explicit ID. Both CLIs support native discovery; a genuine old-CLI or discovery failure shows **Model listing unavailable**, not an execution-unsupported state, and never an invented catalog. A saved ID missing from a later catalog stays visible as a saved/unverified override and is never auto-replaced. Discovery runs in scratch under Relay's data directory (not the registered project cwd) with the same auth environment as execution; if the data directory sits inside a repository, shared ancestor configuration can apply. Relay does not copy or rewrite global CLI configuration, auth files or the registered project for discovery; real-CLI internal global cache/auth-refresh and managed-hook side effects are not verified by the stand-in acceptance. The catalog is Relay-runtime scoped: not a project-specific inventory, and not a prediction of later per-run files. A listed model is advertised metadata, not a guarantee of entitlement, quota or successful inference. Tests load the actual pinned SDK against harmless CLI stand-ins and real Chromium; no real CLI or provider probe was run, and no user auth/global config was changed. Restart an already-running server manually after `pnpm build`; a second `relay start` attaches to the live instance and does not reload new assets. Existing workflow schemas and run history are unchanged.

Fake-agent workflows require Relay to be started with a trusted CLI `--fake-script`; the browser cannot inject a script. Real-adapter workflows require the caller to start with `--allow-experimental-adapters` after a live contract check; those adapters remain experimental. Fresh runs use the run-level workspace selection: the registered project root by default, or an explicitly chosen existing/new worktree. Legacy per-node workspace fields are ignored for fresh runs and retained only for old run snapshots. Only explicit workflow saves write project metadata.

A missing launch gate now returns the controlled reason instead of a generic request error; unknown/internal errors remain sanitized. This diagnostic fix does not change adapter gating, OS sandbox/permission enforcement or experimental status. The Run dialog now states explicitly that a real CLI run uses the signed-in account and may cost money; fake-agent runs remain the no-paid path. The Codex/Claude PATH-stub regressions confirm the default CLI engine path without a live provider completion.

#### Workflow file API

Project workflow definitions are plain files at `<project>/.relay/workflows/<id>.json`. The server exposes bounded CRUD and validation routes for them. Fresh runs choose one run-level `workspace` selection at Start; omitting it defaults to the registered project root. Legacy per-node workspace metadata remains parseable for old documents, but fresh runs ignore it. `GET /api/projects/:pid/workspaces` returns the trusted catalog (`projectRoot`, worktrees, `git`), with the root excluded from the alternatives.

| Route | Behavior |
|---|---|
| `GET /api/projects/:pid/workflows` | Paged list with per-file validation summary |
| `POST /api/projects/:pid/workflows` | Create `{ name, id?, template: "blank" \| "linear-fake" }` exclusively |
| `GET/PUT/DELETE /api/projects/:pid/workflows/:wid` | Read, save and delete one definition; `PUT`/`DELETE` require a strong `If-Match` |
| `POST /api/projects/:pid/workflows/:wid/validate` | Full semantic report for an unsaved draft |
| `POST /api/projects/:pid/gates/test` | Stateless bounded gate preview (`{ gate, scope } -> GateEvaluation`); no run or definition write |
| `POST /api/projects/:pid/workflows/:wid/runs` | Start the exact saved revision (`{ params?, etag, workspace? }`); the selection is part of the idempotency fingerprint |
| `GET /api/projects/:pid/workspaces` | Read-only run-start catalog: canonical project root, linked worktrees and whether the project is Git |

Files are canonical 2-space JSON with a trailing newline; the unquoted SHA-256 content ETag is returned in the body and quoted in `ETag`/`If-Match`. Drafts that parse but fail semantic rules can be saved and listed; they cannot run. Saves re-check the revision before the atomic rename, so an ordinary external edit conflicts instead of being overwritten. A crash between the exclusive publish link and its temp unlink is reconciled on the next read only when the reserved temp is the same inode/device/owner, private-mode and exactly a two-link pair inside `.relay/workflows`; foreign hard links remain rejected. Managed runs reject `promptFile` for now (`E_NOT_SUPPORTED`) until sidecar revisions are covered by the same reviewed ETag. Past runs keep their frozen snapshot when a definition is edited or deleted. Both the managed route and the legacy relative-file `POST /api/projects/:pid/runs` route accept the same optional `workspace` selection and propagate it. The editor uses these routes; the browser never writes project files directly.

`relay run` defaults to the project root and accepts `--workspace project|new-worktree|existing-worktree`; use `--worktree-path <dir>` with `existing-worktree`. `relay resume` has no workspace flag and reuses the run's frozen selection.

## Workspace

```text
packages/*        @relay/core, schema, api, store, workspaces, adapters, engine, mcp, server, cli
apps/web          React 19 + Vite workflow editor and run viewer
tools/*           fake agent, fixtures and bounded P0/P1/P2/P3 demos and acceptance
examples/*        portable linear workflow examples
docs/             build plan, status, ADRs and spike reports
```

Conventions:

- Package names are `@relay/*`; every package exposes `src/index.ts` and TypeScript ESM with `NodeNext`.
- `@relay/core`, `@relay/schema` and `@relay/api` and `apps/web` must stay browser-safe: no Node built-ins outside build/test configs. `@relay/schema/node` is the explicit Node-only subpath; main schema code is forbidden from importing `src/node`. The browser bundle check covers core, schema, api and the web entry.
- The allowed import graph is enforced in `.dependency-cruiser.cjs`. `packages/server` and `packages/cli` are explicit, narrow composition roots; `apps/web` may import only `@relay/api`, `@relay/core` and the browser-safe `@relay/schema` main entry (never `@relay/schema/node`). Their allowed deps are documented in the config.
- Dependencies are pinned exactly in package manifests and by the lockfile. New versions must be at least 14 days old and pass `pnpm audit --audit-level high`.
- `better-sqlite3` 13.0.3 ships bundled N-API prebuilds. Its gyp build script is deliberately not allowlisted, so installs do not compile from source. FTS5 canary evidence is in the SQLite canary workflow and build status.

## CI

`.github/workflows/ci.yml` runs check, test and build on Linux and macOS with Node 22 and 24, plus demo jobs for P0/P1/P2/P3 and Chromium-backed P2/P3 browser e2e jobs. These workflows are configured; they have not been executed on GitHub. Post-fix `pnpm check` is 567/1950 with non-browser **1126/135** (1074/122 + 50/13, web 190/24); focused P3.5 **1/1** + HTTP **9/9** valid, full suite **8/9** with routing dead-edges failure (not 9/9). Historical routing was 1050/124 with 8/8. Full P4/G4 remain open. `.github/workflows/sqlite-canary.yml` verifies the bundled prebuild and FTS5 on Linux/macOS with Node 22, 24 and 26 without a source compile.

The browser jobs install Chromium into the runner cache and export `RELAY_CHROMIUM_PATH`; they do not use a developer browser profile. If web/CLI dist, SQLite or Chromium is missing, the browser acceptance fails instead of skipping.

## Documentation

- [Build plan](docs/build-plan.md)
- [Build status](docs/build-status.md)
- [P2 root integration](docs/p2-root.md)
- [P2 acceptance driver](docs/p2-acceptance.md)
- [P3 root integration](docs/p3-root.md)
- [P3 acceptance driver](docs/p3-acceptance.md)
- [P4 routing delivery plan](docs/p4-routing-plan.md)
- [Worktree acceptance driver (historical per-node selector)](docs/worktree-acceptance.md)
- [Run workspace acceptance](docs/run-workspace-acceptance.md)
- [Implementation spec](relay-implementation-spec.md)
- [High-level design](agent-workflow-orchestrator-design.md)
- [UI mock](relay-ui-mock.html) (reference only, not production code)
