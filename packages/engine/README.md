# @relay/engine

Durable linear workflow engine for the P1 headless runner. It executes
`start -> agent -> shell -> end` chains against real temp SQLite, scratch
workspaces and a caller-provided loopback gateway. It is not the full §12
scheduler.

## Scope

Implemented:

- one linear chain with exactly one `start` and one `end`;
- `agent` nodes through the real MCP stdio shim and gateway `submit_result`;
- `shell` nodes with a structured `{ exitCode, signal, stdout, stderr, durationMs }` output;
- scratch workspaces only, acquired per generation and never the project directory;
- immutable run snapshot and normalized workflow hash (UI stripped);
- durable accepted results, persistent validation budgets, bounded no-submit fallback;
- process generations, persistent crash budget, finish-grace kill after acceptance;
- token issue/revoke through `GatewayPort`; token only in adapter-owned env/config;
- serialized per-run execution; store writes are synchronous and authoritative;
- boot recovery: orphan identity check, accepted-result finalization, uncertain shell pause;
- explicit one-shot override for an uncertain shell (`resume(..., { allowUncertainSideEffectRetry: true })`);
- SIGINT/SIGTERM style `stop()` leaves a resumable paused run, not a user cancellation.

Rejected before a run is created: unsupported node types, non-scratch workspaces,
project writes, context banks, artifacts, `promptFile`, `cliOptions`, budgets and
`baseSha`. There is no silent drop.

Deferred: gate/join/decision/approval/map/loop/supervisor nodes, containers,
worktrees, project mode, artifacts, context banks, retry-from-node, terminal
retry, multi-run fairness, quotas, UI and the full scheduler.

## API

```ts
import { createEngine, type EngineDeps } from "@relay/engine";
```

```ts
interface EngineDeps {
  store: Store;
  adapters: AdapterRegistry;
  workspaces: {
    acquire(request): Promise<Result<ScratchWorkspace, RelayError>>;
    finalize(workspace, request): Promise<Result<FinalizeScratchInfo, RelayError>>;
    release(workspace): void;
  };
  gateway: {
    url: string;
    issue(scope: {
      identity: ExecutionIdentity;
      outputSchema: Record<string, unknown>;
      outputSchemaHash: string;
      validationLimit: number;
      expiresAt: number;
    }): { token: string; revoke(): void };
  };
  dataDir: string;
  nodeBin: string;
  mcpShimEntry: string;
  clock?: Clock;
  finishGraceMs?: number;
  shutdownGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  extraEnvNames?: readonly string[];
  maxNodeTimeoutMs?: number;
  allowExperimentalClis?: readonly ("claude-code" | "codex")[];
}
```

```ts
const engine = createEngine(deps);
await engine.start(); // boot recovery only; never auto-dispatches runs

// Durable create + async dispatch (HTTP 202 semantics).
const launched = await engine.launch({
  projectId,
  workflowId,
  snapshot,
  snapshotRaw,
  params,
  idempotency: { scope: projectId, key, fingerprint },
});
if (!launched.ok) throw launched.error;
// resolve before the workflow completes
const { runId, duplicate, completion } = launched.value;
// duplicate === true never dispatches or spawns; completion is the original
// run's promise when active, otherwise its current durable outcome.

// Compatibility: run/resume await launch(...).completion.
const started = await engine.run({
  projectId,
  workflowId,
  snapshot,      // normalized WorkflowFile snapshot from @relay/schema
  snapshotRaw,
  params,
});              // blocks until terminal or paused

await engine.resume(runId); // paused shutdown or recovery
await engine.resume(runId, {
  allowUncertainSideEffectRetry: true,
  approvedBy: "user",       // audited by the store
});

await engine.cancel(runId); // revoke tokens first, then kill; user cancellation
await engine.stop();        // graceful shutdown; runs resume later

const unsubscribe = engine.subscribe((event) => {});
const view = engine.view(runId);
const outcome = await engine.getRun(runId);
```

The CLI owns store opening, the data directory, the project registry, the
workflow file/normalization, the loopback gateway listener and the adapter
registry. The gateway `issue`/`revoke` must map to the server's real
`ExecTokenRegistry`; the engine never opens a listener.

`run()`/`resume()` return `RunOutcome { runId, status, result?, pausedReason?, error? }`.
Pauses include `shutdown` and `uncertain_side_effect`.

## Execution order

1. validate the linear chain, params, budgets, adapters and snapshot;
2. `store.runs.create` writes the immutable snapshot and `run.created` + `run.started`;
3. nodes are ensured lazily; readiness is recomputed from persisted outputs;
4. `start`/`end` record deterministic outputs and need no process markers;
5. `agent` acquires scratch, renders scope + submit contract, issues a scoped token,
   spawns through the adapter, persists pid/pidStart/binary/cwd before stdin is released,
   records session/usage/transcript, accepts only gateway submissions, waits for the
   actual process-group stop, finalizes scratch, then completes;
6. `shell` renders the template with shell quoting, runs through the adapter process
   runner, persists the structured output and stop/finalize evidence;
7. `end` evaluates its result and completes the run.

A tool token is revoked before every kill and on every exit/failure path. Transcripts
are redacted and written under the canonical data directory with `O_NOFOLLOW`.
A failed process group stop leaves the execution live, pauses the run and retains
the process evidence for a later recovery attempt; it never records a false stop.

## Recovery

`start()` is the only boot path:

- kills an orphan only when `pid`, canonical `pidStart` and binary still match; a
  reused PID is never killed;
- records a crash stop for unaccepted running/validating executions;
- finalizes accepted-but-unfinalized executions under the original attempt/generation
  (`completeAcceptedAfterRecovery`); a missing workspace is an error, never recreated;
- converts an interrupted shell into `run.paused { reason: "uncertain_side_effect" }`;
- isolates one bad run with `error.logged` and continues recovering other runs;
- never auto-dispatches; the CLI calls `resume()` explicitly.

There is no exactly-once claim for shell commands or arbitrary agent side effects.
An interrupted shell is retried only after an explicit human override.

## Tests

```sh
pnpm --filter @relay/engine build
pnpm --filter @relay/engine typecheck
pnpm --filter @relay/engine test
pnpm exec biome check packages/engine
pnpm exec tsx tools/fixtures/engine/scenarios.ts
```

`scenarios.ts` uses real temp SQLite, the real loopback gateway, the real MCP shim and
test-only fake-agent child processes (RELAY_ALLOW_FAKE=1). It covers happy path, invalid-then-valid submission,
no-submit budget, validation exhaustion, crash cap, accepted-then-crash finalization,
shell failure/allow-failure/quoting, timeout crash budget, shutdown/resume, cancellation
and the uncertain-shell override. It is not live Claude Code/Codex evidence.
