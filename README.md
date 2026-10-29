# DevChestra

Local, single-user workflow orchestrator for headless coding agents. DevChestra runs workflows of `start`, `agent`, `shell`, `gate`, `join`, `approval`, `decision`, `loop` and `end` nodes against the Claude Code, Codex, Opencode and Pi CLIs through a real MCP shim, a SQLite event store and a loopback web server. Use the browser editor to register a project, build and save a workflow with conflict-safe ETags, then run it into the live viewer (events, transcripts and event-based replay) without editing JSON. Each run picks one workspace at Start: the project root (dirty files included), an existing Git worktree, or a new per-run worktree. Gates branch in order with a mandatory `otherwise`, joins resolve with `first` or `all`, and approvals pause the run until a person approves or rejects. Bounded [Repeat until loops](docs/loops.md) preserve separate history for every round. Maps, artifact capture, spending budgets, context banks and release packaging are not built yet.

The product name is provisional (`DevChestra` internally). Do not create durable user-facing paths or publish under a final name until that decision is recorded.

## Prerequisites

- Node.js **22 or newer**. CI runs the test suite on Node 22 and 24; the SQLite canary also covers Node 26.
- pnpm **10.14.0** (declared in `packageManager`)
- Git 2.30+ (required only for the existing-worktree and new-worktree run options; the default project root also works for non-Git folders)
- Linux or macOS. The `spike/windows-native` branch adds experimental native Windows 10/11 x64 support; see [the Windows spike notes](docs/windows-native-spike.md) for setup, evidence and remaining gaps.

## Install

One command sets everything up on your machine and is safe to run again any time (after pulling, or when something looks off):

```sh
pnpm setup:global            # add --dry-run to see what it would do, --no-env / --no-restart to skip a step
```

It installs and builds, links the global `devchestra` command, copies the decision API keys (`TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`; nothing else) from the repo's `.env` to `~/.config/devchestra/.env` with mode 600 without overwriting values already there, tightens a world-readable repo `.env`, and restarts a running server if it has no active runs. If pnpm has no global bin directory yet it tells you to run `pnpm setup` once.

Then start it from anywhere with `devchestra start`. Keys are looked up in the environment, `$DEVCHESTRA_ENV_FILE`, a `.env` in the folder you start from, then `~/.config/devchestra/.env`.

Manual route: `pnpm install` (CI uses `--frozen-lockfile`), `pnpm build`, then `pnpm devchestra ...` from the repo.

## Commands

| Command | What it does |
|---|---|
| `pnpm setup:global` | Install, build, link the global `devchestra` command, set up API keys, restart an idle server (see Install) |
| `pnpm build` | Runs `build` in every workspace package that defines it |
| `pnpm test` | Builds the workspace first, then runs `test` in every package that defines it |
| `pnpm typecheck` | Builds workspace packages (so cross-package types resolve), then runs `typecheck` in every package that defines it |
| `pnpm check` | Biome, build + recursive typecheck, dependency-cruiser and a browser bundle check |
| `pnpm test:root` | Runs root-only Vitest tests (`tests/**/*.test.ts`) |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format (write) |
| `pnpm depcruise` | Dependency direction check over `packages`, `tools` and `apps` |
| `pnpm audit --audit-level high` | Dependency audit at high severity; CI also runs it |
| `pnpm devchestra ...` | Runs the CLI from source with the workspace root as cwd (`devchestra --help`) |
| `devchestra stop` / `devchestra status` | Stop the running server (refuses while runs are active unless `--force`) / show whether it is running, its URL and active runs. `status` exits 0 when running, 1 otherwise |
| `pnpm devchestra:start --data-dir <dir>` | Starts the loopback web server, editor and viewer (requires `apps/web/dist`; the data dir defaults to `~/.local/share/devchestra`) |
| `pnpm devchestra:run ...` | `devchestra run` forwarding |
| `pnpm devchestra:resume <runId> ...` | `devchestra resume` forwarding |
| `pnpm devchestra:doctor ...` | `devchestra doctor` forwarding |
| `pnpm web:build` / `pnpm web:dev` | Vite production build / dev server for `apps/web` |
| `pnpm test:p3` | Runs the bounded P3 real-HTTP/security harness tests |
| `pnpm test:e2e:p3` | Runs the Chromium P3 editor/autosave/conflict/run-and-a11y e2e test |

Recursive scripts use `pnpm -r --if-present`: a package without that script is skipped, while a real package failure still fails the command. Do not replace this with a script that hides failures. `pnpm test` builds first so integration tests that need package `dist` output cannot silently skip on a fresh install.

### P1 linear CLI

A minimal run from the repository root (needs a signed-in provider CLI):

```sh
pnpm devchestra run examples/linear-codex.json \
  --project . \
  --data-dir /tmp/devchestra-dev \
  --param topic=devchestra \
  --json
```

Fresh `devchestra run` defaults to the registered project root; the starter example omits per-node workspace metadata. Add `--workspace new-worktree` for a fresh per-run worktree, or `--workspace existing-worktree --worktree-path <dir>` to reuse one; `resume` keeps the run's frozen choice. The supported agent CLIs are `claude-code`, `codex`, `opencode` and `pi` (see `GET /api/clis`); `fake` is test-only behind `DEVCHESTRA_ALLOW_FAKE=1` with a test-only `--fake-script`. `pnpm devchestra:doctor --data-dir /tmp/devchestra-dev` runs diagnostics. `--data-dir` is optional everywhere: it defaults to `$DEVCHESTRA_DATA_DIR`, else `~/.local/share/devchestra` (never a temp dir).

The Claude Code, Codex, OpenCode and Pi adapters are official. `--allow-experimental-adapters` is still accepted but deprecated and ignored.

Claude Code and Codex adapter contracts are implemented. Basic live fresh + resume was smoke-tested separately, but OS sandbox/permission enforcement, real-CLI crash handling and live mid-run recovery remain unverified.

### P2 loopback API and read-only viewer

Build the workspace first: the server refuses to start without `apps/web/dist` and does not serve a placeholder viewer. Use a **persistent** data directory if you want to open the viewer after the producing process exits. 

Seed one run into a persistent directory, then start the viewer against the same directory:

```sh
pnpm build
data=/tmp/devchestra-view
mkdir -p "$data"
pnpm devchestra run examples/linear-codex.json \
  --project . \
  --data-dir "$data" \
  --param topic=devchestra \
  --json
pnpm devchestra:start --data-dir "$data"
```

`start` holds the data-directory lock; do not run `devchestra run`/`resume` against the same directory while it is live (the intended single-instance rule).

`--data-dir` is required and there is no `~/.devchestra` fallback. `start` binds loopback only and chooses the first free port in 4821–4890 (or an ephemeral port with `--port 0`); a taken explicit port falls back to an ephemeral one and reports the actual URL. The browser opens by default with a session `?t=<token>` bootstrap URL (the token stays valid until the server restarts); `--no-open` and `--print-url` control that. The token is written owner-only to `<dataDir>/server.json` for the CLI and is not printed in `--json` output. A second `start` attaches to a verified live instance instead of creating a second session.

The run viewer keeps workflow snapshots read-only and shows project/run lists, execution attempts, paged transcripts, complete event history and event-based replay with a scrubber. A persistent **Stop run** action cancels a nonterminal live run through the existing cancellation API; it stays in **Stopping…** until the live state confirms termination. Replay uses the shared reducer and can be linked with `?at=<eventId>`; **Stop live run** is explicitly a live-run action, independent of the replay position. Older terminal runs with missing execution-terminal events show **State unresolved** instead of a live spinner; the original execution evidence is retained, not rewritten. SSE reconnects from `Last-Event-ID` and refetches on overflow; the live run stream is separate from the low-volume global hints stream. Execution process times are read from stored integer epoch milliseconds; invalid stored timestamps fail with `E_INTERNAL` instead of rendering a fabricated date. Frozen clean: `pnpm check` **567/1950/4 exit 0** with non-browser **1126/135** (`1074/122` + `50/13`, web **190/24**); independent focused P3.5 **1/1 in 9.21s** on `index-CKcmjq75.js` (`/tmp/codex-p35-browser-clean.log`) + HTTP **9/9** valid. Overall Chromium **8/9** on preceding equivalent source: P3.5 + model pass, **P4 routing fails `waitDeadEdges` after succeeded run** (log `/tmp/codex-p35-e2e-fixed.log`; isolated drag fails) — no claim 9/9. Historical routing **1050/124** (`index-ilEE3nLD.js` 1/1 11.59s + 8/8 122.39s) and P3 **915/105** remain historical. Session replay race fixed, limits `note ≤4096`/`criteria 32×≤256` verified, instrumentation removed. Local Linux only, no CI/macOS/live-provider.

### P3 workflow authoring and editor

P3 introduced the browser editor for the original four node types (`start`, `agent`, `shell`, `end`): palette add, connect/delete/move, undo/redo, parameter/prompt/output-schema/permission fields, Structured output-schema rows or a Raw JSON object, live validation in a Vite module worker, and conflict-safe autosave. The server validates again on save and run. The P4 routing increment adds `gate` and `join` to the same editor with typed branch/input handles. Unsupported node types cannot run or appear fully functional.

#### Run workspace selection

Choose the workspace once, in the Start/Run dialog, for the whole execution. The default is the registered project root: steps run directly in that directory, including uncommitted tracked edits, untracked files and ignored files, and can edit live project files. DevChestra does not copy the project, commit, roll back or sandbox writes in this mode. This is the authorized direct-project execution path, not a read-only mode.

**Existing Git worktree** lists the project's linked worktrees from `git worktree list` with path, branch or detached HEAD and HEAD commit. The registered root is the default and is not repeated as an alternative. DevChestra validates the canonical path and repository identity before starting; a path not in that list is rejected. **Create a new Git worktree** creates a per-run worktree at `<dataDir>/projects/<projectId>/runs/<runId>/worktree` when the run starts, initially detached at the project's committed `HEAD`. It contains the files committed at that revision: uncommitted tracked edits, untracked/ignored files and untracked/ignored dependency directories such as `node_modules` are absent, and no setup command runs.

Every Agent and Shell step in the run uses the same chosen cwd. The selection is frozen into the run record; the internal binding also stores the registered project root, while the browser sees only the selection. Restart/resume and history replay reuse the same workspace and never switch to a later editor choice. A missing or malformed binding fails closed. Runs created before run-level workspaces have no binding and keep their historical per-node scratch/worktree behavior.

Scoped browser acceptance of this selector passed 1/1 in 8.52s with actual Chromium, an ephemeral CLI server, temporary Git/HOME/data and the fake agent. It verified root dirty/untracked visibility, an existing worktree at the exact path, a new checkout under the data directory, one cwd for every agent and shell, no inspector selector, one POST per run, and cleanup sentinel/no-orphan checks. All 7 distinct Chromium regression scenarios are verified: the full suite passed 6/7, the sole failure was a stale old per-node `workspace-review` assertion, and an assertion-only correction plus focused rerun passed 1/1 in 6.59s against unchanged dist. This is not a second full 7/7 invocation.

Agent and Shell inspectors no longer expose a workspace selector. Fresh nodes and templates omit per-node workspace metadata; legacy per-node fields remain parseable for old documents and snapshots but are ignored by fresh runs. DevChestra finalizes each step with bookkeeping under the data directory; it never deletes, auto-commits or cleans up the project root or an existing worktree, and writes no DevChestra marker into a user checkout. A new per-run worktree is not merged, committed, given a retained branch or automatically cleaned up. A new worktree starts detached; later workflow commits may advance its HEAD. The initial base is recorded for evidence only. Worktree `base`, `setup` and `from` options are unsupported. None of these modes is an OS sandbox or read-only mode: steps run with the process's ordinary permissions, and project-root or existing-worktree steps can reach project paths by absolute path.

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
pnpm devchestra:start
```

`devchestra start` serves `apps/web/dist`. After `pnpm build` rebuilds the web app, **restart the server manually** if an older process is already running; it will not load the new assets by itself. Existing definitions and past run history are not rewritten: change an agent node's output mode explicitly if you want the new behavior. Automatic input handoff applies to new invocations only. The command opens the loopback URL with a bootstrap token; `--no-open` and `--print-url` control that. Use your own persistent `--data-dir`; use it only for real runs. `GET /api/clis` lists the registry-backed agent CLIs (`claude-code`, `codex`, `opencode`, `pi`); the test-only fake CLI stays hidden unless `DEVCHESTRA_ALLOW_FAKE=1`.

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
3. Type to filter locally by id, label, provider or alias, then select and save. The exact catalog ID is stored in the existing optional `node.model` and passed to the CLI unchanged (`-m` for Codex, `--model` for Claude). Claude uses `ModelInfo.value` exactly and never substitutes `resolvedModel`; Codex uses the exact `model` value. DevChestra does not substitute another model.

**Use CLI default** clears the override (absent `node.model`). **Use custom model ID** stores an explicit ID. Both CLIs support native discovery; a genuine old-CLI or discovery failure shows **Model listing unavailable**, not an execution-unsupported state, and never an invented catalog. A saved ID missing from a later catalog stays visible as a saved/unverified override and is never auto-replaced. Discovery runs in scratch under DevChestra's data directory (not the registered project cwd) with the same auth environment as execution; if the data directory sits inside a repository, shared ancestor configuration can apply. DevChestra does not copy or rewrite global CLI configuration, auth files or the registered project for discovery; real-CLI internal global cache/auth-refresh and managed-hook side effects are not verified by the stand-in acceptance. The catalog is DevChestra-runtime scoped: not a project-specific inventory, and not a prediction of later per-run files. A listed model is advertised metadata, not a guarantee of entitlement, quota or successful inference. Tests load the actual pinned SDK against harmless CLI stand-ins and real Chromium; no real CLI or provider probe was run, and no user auth/global config was changed. Restart an already-running server manually after `pnpm build`; a second `devchestra start` attaches to the live instance and does not reload new assets. Existing workflow schemas and run history are unchanged.

Test-only fake-agent workflows (hidden unless `DEVCHESTRA_ALLOW_FAKE=1`) require DevChestra to be started with a test-only `--fake-script`; the browser cannot inject a script. Fresh runs use the run-level workspace selection: the registered project root by default, or an explicitly chosen existing/new worktree. Legacy per-node workspace fields are ignored for fresh runs and retained only for old run snapshots. Only explicit workflow saves write project metadata.

A missing launch gate now returns the controlled reason instead of a generic request error; unknown/internal errors remain sanitized. This diagnostic fix does not change OS sandbox/permission enforcement. The Run dialog now states explicitly that a real CLI run uses the signed-in account and may cost money. The Codex/Claude PATH-stub regressions confirm the default CLI engine path without a live provider completion.

#### Workflow file API

Project workflow definitions are plain files at `<project>/.devchestra/workflows/<id>.json`. The server exposes bounded CRUD and validation routes for them. Fresh runs choose one run-level `workspace` selection at Start; omitting it defaults to the registered project root. Legacy per-node workspace metadata remains parseable for old documents, but fresh runs ignore it. `GET /api/projects/:pid/workspaces` returns the trusted catalog (`projectRoot`, worktrees, `git`), with the root excluded from the alternatives.

| Route | Behavior |
|---|---|
| `GET /api/projects/:pid/workflows` | Paged list with per-file validation summary |
| `POST /api/projects/:pid/workflows` | Create `{ name, id?, template: "blank" \| "linear" }` exclusively (legacy `"linear-fake"` still accepted) |
| `GET/PUT/DELETE /api/projects/:pid/workflows/:wid` | Read, save and delete one definition; `PUT`/`DELETE` require a strong `If-Match` |
| `POST /api/projects/:pid/workflows/:wid/validate` | Full semantic report for an unsaved draft |
| `POST /api/projects/:pid/gates/test` | Stateless bounded gate preview (`{ gate, scope } -> GateEvaluation`); no run or definition write |
| `POST /api/projects/:pid/workflows/:wid/runs` | Start the exact saved revision (`{ params?, etag, workspace? }`); the selection is part of the idempotency fingerprint |
| `GET /api/projects/:pid/workspaces` | Read-only run-start catalog: canonical project root, linked worktrees and whether the project is Git |

Files are canonical 2-space JSON with a trailing newline; the unquoted SHA-256 content ETag is returned in the body and quoted in `ETag`/`If-Match`. Drafts that parse but fail semantic rules can be saved and listed; they cannot run. Saves re-check the revision before the atomic rename, so an ordinary external edit conflicts instead of being overwritten. A crash between the exclusive publish link and its temp unlink is reconciled on the next read only when the reserved temp is the same inode/device/owner, private-mode and exactly a two-link pair inside `.devchestra/workflows`; foreign hard links remain rejected. Managed runs reject `promptFile` for now (`E_NOT_SUPPORTED`) until sidecar revisions are covered by the same reviewed ETag. Past runs keep their frozen snapshot when a definition is edited or deleted. Both the managed route and the legacy relative-file `POST /api/projects/:pid/runs` route accept the same optional `workspace` selection and propagate it. The editor uses these routes; the browser never writes project files directly.

`devchestra run` defaults to the project root and accepts `--workspace project|new-worktree|existing-worktree`; use `--worktree-path <dir>` with `existing-worktree`. `devchestra resume` has no workspace flag and reuses the run's frozen selection.

### Decision providers

Decision nodes ask one of three fixed providers: `typesafe-jev` (Jev), `cloudflare-clef` (Clef 27B) or `cloudflare-clef-flash` (Clef-flash 9B). Keys come from environment variables or a `.env` file in the directory you run `devchestra` from (see `.env.example`); real shell exports take priority, and only these three names are ever read: `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`. `devchestra doctor` reports each provider as ready or missing (names only), and the browser tester at `POST /api/projects/:pid/decisions/test` previews one question without creating a run. Keys kept only in `.env` are never passed to agents (DevChestra does not load `.env` into `process.env`), but a `TYPESAFE_API_KEY` exported in the shell IS passed to `pi` agent nodes, because Pi uses the same variable name (a pre-existing, intentional entry in the `pi` agent env allowlist, unrelated to decision nodes).

Live probe (opt-in): `pnpm devchestra:doctor --probe-decisions` (or `devchestra doctor --data-dir <dir> --probe-decisions`) sends ONE trivial boolean question per ready provider through the client's `test()` and prints, per provider, ok/failed, latency, the resolved model and a redacted response-shape summary: top-level key names, the answer's key names and value types, whether the body was wrapped in `result`, and whether `confidence`/`probabilities`/`usage` were present. It never prints values or keys. Cost: one tiny request per ready provider (providers without keys are skipped). Without the flag, doctor makes no network calls.

## Workspace

```text
packages/*        @devchestra/core, schema, api, store, workspaces, adapters, engine, mcp, server, cli
apps/web          React 19 + Vite workflow editor and run viewer
tools/*           test-only fake agent (DEVCHESTRA_ALLOW_FAKE=1), fixtures and browser e2e and acceptance harnesses (p2-smoke, p3-smoke)
examples/*        portable linear workflow examples
```

Conventions:

- Package names are `@devchestra/*`; every package exposes `src/index.ts` and TypeScript ESM with `NodeNext`.
- `@devchestra/core`, `@devchestra/schema` and `@devchestra/api` and `apps/web` must stay browser-safe: no Node built-ins outside build/test configs. `@devchestra/schema/node` is the explicit Node-only subpath; main schema code is forbidden from importing `src/node`. The browser bundle check covers core, schema, api and the web entry.
- The allowed import graph is enforced in `.dependency-cruiser.cjs`. `packages/server` and `packages/cli` are explicit, narrow composition roots; `apps/web` may import only `@devchestra/api`, `@devchestra/core` and the browser-safe `@devchestra/schema` main entry (never `@devchestra/schema/node`). Their allowed deps are documented in the config.
- Dependencies are pinned exactly in package manifests and by the lockfile. New versions must be at least 14 days old and pass `pnpm audit --audit-level high`.
- `better-sqlite3` 13.0.3 ships bundled N-API prebuilds. Its gyp build script is deliberately not allowlisted, so installs do not compile from source. FTS5 canary evidence is in the SQLite canary workflow and build status.

## CI

`.github/workflows/ci.yml` runs check, test and build on Linux and macOS with Node 22 and 24, plus a Chromium-backed P2/P3 browser e2e job. These workflows are configured but have not been confirmed on GitHub; the P4 routing browser scenario is quarantined behind `DEVCHESTRA_E2E_P4=1` and the P3.5 approval browser scenario is intermittent. `.github/workflows/sqlite-canary.yml` verifies the bundled prebuild and FTS5 on Linux/macOS with Node 22, 24 and 26 without a source compile.

The browser jobs install Chromium into the runner cache and export `DEVCHESTRA_CHROMIUM_PATH`; they do not use a developer browser profile. If web/CLI dist, SQLite or Chromium is missing, the browser acceptance fails instead of skipping.
