# @devchestra/store

Authoritative SQLite store for DevChestra: one synchronous writer, forward-only
migrations, event log as source of truth, transactional projection through
`@devchestra/core`'s reducer, durable agent tool receipts, immutable accepted
outputs, and process-generation fencing.

The store implements the tables created by `migrations/`. See
[Scope and limits](#scope-and-limits) for what it deliberately omits.

## Install / drivers

- Default driver: `better-sqlite3` 13.0.3 (N-API prebuild; no source build).
- Fallback: `node:sqlite` via explicit `nodeSqliteDriver` from
  `@devchestra/store/driver-node-sqlite`. It never triggers native compilation.
- Startup refuses to open unless `sqlite_compileoption_used('ENABLE_FTS5')`
  is true.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5000`, `wal_autocheckpoint=1000`, `temp_store=MEMORY`,
  `trusted_schema=OFF`. `PRAGMA quick_check` runs at open.
- The parent directory of `file` is created. Use a real file for WAL tests;
  `:memory:` is accepted but not the tested durability path.

```ts
import { openStore } from "@devchestra/store";
const store = openStore({ file: "/abs/path/devchestra.db" });
```

## Transaction model

`store.tx(fn)` opens `BEGIN IMMEDIATE` once. Nested `tx` calls (and every
public method) join the outer transaction. Async callbacks are rejected before
they run, and any thenable return value rolls the transaction back (the public
type also refuses promise-returning callbacks). A nested failure poisons the
outer transaction even if the caller catches it: the outer `COMMIT` is refused
and every write rolls back. This is not async cancellation; never schedule work
outside the callback. Events are queued in memory during the transaction and `store.bus.publish`
runs only after `COMMIT`, in event order. A rollback discards both rows and
queued events.

`appendEvents` is the only writer of `events`, `run_views`, `executions` and
run status. Each append inserts rows, reduces them with the shared core
reducer, saves the `RunView` JSON, and materializes execution/run rows in the
same transaction. Subscribers never throw into the commit path.

## Public API

```ts
type Identity = { runId: RunId; path: Path; attempt: number; generation: number };
```

### Runs / executions

```ts
store.runs.get(runId): RunRecord | null
store.runs.listActive(): RunRecord[]  // queued|running|paused|waiting_approval
// RunRecord: immutable snapshot + snapshotRaw + params + budgets + project
// {id,name,path,kind} + status/counters/timestamps/result.
store.executions.list(runId): ExecutionRow[]
store.executions.getProcess(identity): ProcessRecord | null
store.processes.active(): ActiveProcess[]
// Only executions currently running/validating at their current generation,
// with a real pid and no stop marker. Intended for boot orphan cleanup.
```

Snapshots are returned as fresh parsed copies; mutating a returned object cannot
change stored data. Only `budgets.maxTokens` is accepted; any other budget key
(including `maxUsd`, `maxActiveMinutes`, typos) is rejected with `E_VALIDATION`
before the run number is allocated, rather than silently ignored. Active time
remains approximate and unenforced.

```ts
store.projects.ensure({ id, name, path, kind: "git" | "folder" }): void
store.runs.create({
  projectId, workflowId, workflowHash, snapshot, snapshotRaw,
  params?: JsonObject, budgets?: JsonObject, baseSha?, kind?: "run" | "node_test"
}): { runId, runNumber }
// Inserts the run and appends run.created + run.started in one transaction.

store.executions.ensure({
  runId, path, nodeId, kind?: NodeKind,
  requireSubmission?: boolean, validationLimit?: number
}): ExecutionRow
// Appends the initial node.state from pending -> ready. Agent nodes should pass
// kind:"agent" so core records requiresAcceptedResult.

store.executions.get(runId, path): ExecutionRow | null
store.executions.recordSpawned({
  identity, pid, pidStart, binary, cwd
}): ProcessRecord
// Call AFTER the OS spawn and BEFORE releasing the prompt. Exact current
// identity/active run/running status. Persists pid_start/binary/cwd in
// process_generations and appends node.process.spawned. Same evidence is
// idempotent; changed evidence or a non-positive pid/empty/NUL/newline field
// is rejected. A reused PID is distinct because pidStart differs.
store.executions.beginInvocation({
  runId, path, attempt, pid?, lstart?, mode?, resolvedConfigHash?,
  allowUncertainSideEffectRetry?, approvedBy?
}): Identity
// Bumps generation, records process_generations, appends node.attempt.started
// and node.state ready|interrupted -> running. An interrupted shell additionally
// requires the audited user approval described under Recovery.
```

### Atomic submissions (gateway's only write path)

```ts
store.submissions.submit({
  identity, callId, request,
  ok: true, output, schemaHash?
}): { kind: "accepted"; duplicate: boolean; receipt; output; eventId }
```

One transaction commits the immutable `outputs` row (`kind='output'`), the
`node.output.validated` event, and the `tool_receipts` row. `request` is
hashed with canonical JSON and only the fingerprint is stored.

- Same `callId` + same fingerprint: returns the committed receipt
  (`duplicate: true`), even if the execution is already terminal or the
  validation budget is exhausted. It never consumes budget or appends again.
- Same `callId` + different request: `E_CONFLICT`.
- Different `callId` while an accepted output already exists for this
  `(run,path,attempt)`: returns `{ kind:"already_accepted", output,
  acceptedEventId }`. It does not throw and does not write.
- Stale/future/mismatched attempt or generation: `E_CONFLICT`.

```ts
store.submissions.submit({
  identity, callId, request,
  ok: false, errors: [{path,message}], errorCode?, validationAttempt?
}): { kind:"rejected"; duplicate; receipt; validationAttempt;
      validationAttemptsLeft; eventId }
```

One transaction commits the `tool_receipts` row, the `node.output.rejected`
event, and increments the durable validation count exactly once per receipt.
The store owns the next counter; `validationAttempt` is an optional optimistic
equality check only. Over budget on a new callId: `E_ATTEMPTS_EXHAUSTED`.
The budget (`executions.validation_limit`, default 3) is checked inside the
transaction.

Reads:

```ts
store.submissions.get(identity, callId): Receipt | null
store.submissions.accepted({ runId, path, attempt }): AcceptedOutput | null
store.submissions.validationLeft(identity): number
store.submissions.countNoSubmit({ runId, path, attempt }): number
// Committed rejected receipts with errorCode E_NO_SUBMIT across all
// generations of this logical attempt. Duplicate callIds count once.
```

### Deterministic outputs (start / shell / end)

```ts
store.outputs.recordDeterministic({ identity, output }): {
  output: AcceptedOutput; eventId: number; duplicate: boolean
}
store.outputs.get({ runId, path, attempt }): AcceptedOutput | null
```

One transaction writes the immutable `outputs` row (`kind='output'`) and the
`node.output.recorded` event. There is no MCP receipt, no validation budget and
no `acceptedResult`; this never pretends a tool was called. Replaying the same
output hash returns the existing record (`duplicate:true`); a different hash or
a different way of claiming the same completed attempt is `E_CONFLICT`.
Secrets are rejected before insert.

Completion gates:

- `start` / `end`: a recorded output is required; no process/workspace markers.
- `shell`: recorded output plus `processStopped` and `workspaceFinalized` for
  the exact current attempt/generation.
- `agent`: accepted result plus both markers.

### Acceptance is not success

`accepted` only means a validated result row exists. It never changes status
to `succeeded`.

```ts
store.executions.recordProcessStopped({ identity, reason, exitCode? }): void
store.executions.recordWorkspaceFinalized({ identity, dir, commitSha? }): void
store.executions.complete({ identity }): { status:"succeeded", eventId }
```

Both evidence calls require the exact current identity and are idempotent only
for identical evidence. `complete` requires, for an accepted result, that
`processStopped` and `workspaceFinalized` carry the accepted attempt and
generation; otherwise `E_CONFLICT`. The core reducer enforces the same gate.

Recovery completion of an already accepted attempt, without resubmitting and
without a new generation:

```ts
store.executions.completeAcceptedAfterRecovery({
  identity,                                   // original accepted identity
  processStop: { reason, exitCode? },         // boot established process death
  workspace: { dir, commitSha? }              // actual finalization evidence
}): { status:"succeeded", eventId }
```

Call it only after the process is known gone and the workspace was really
finalized. Restarting with an accepted-but-not-finalized execution leaves it
`validating`/unfinished.

### Events, view, rebuild, recovery

```ts
store.events.append(runId, drafts): EventEnvelope[]   // authoritative
store.events.list(runId, { after?, limit?, types?, pathPrefix? }): EventEnvelope[]
store.view.get(runId): RunView
store.view.rebuild(runId): RunView                    // full replay, same tx
store.recovery.recover(runId): RecoveryReport         // rebuild, then core recoveryDecision
store.security.registerSecret(value, name?): () => void  // in-memory only
store.security.scan(value): SecretFinding | null
store.close(): void
```

`recovery.recover` rebuilds the projection from the full log before deciding.

### Read ports and durable start idempotency

All reads are synchronous, bounded and use the single store connection. No
driver, raw `SqliteDb` or SQL string is exported.

```ts
// Projects (server owns filesystem realpath/existence/data-dir checks)
store.projects.list(): ProjectRecord[]
store.projects.get(id): ProjectRecord | null
store.projects.findByPath(path): ProjectRecord | null
store.projects.relink({ projectId, path, name?, kind?, missing? }): ProjectRecord
// ProjectRecord { id, name, path, kind, addedAt, nextRunNumber, missing }

store.runs.list({ projectId?, workflowId?, status?, cursor?, limit? }):
  { items: RunSummary[]; nextCursor: string | null }
store.view.snapshot(runId): { runId, run: RunRecord, view: RunView, watermark }
store.events.page(runId, { after?, cursor?, upTo?, limit?, types?, pathPrefix? }):
  { items: EventEnvelope[]; nextCursor: string | null; nextAfter: number | null; watermark }
store.outputs.getById(id): OutputRecord | null
store.outputs.listByProvenance({ runId, path?, attempt?, generation?, kind?, cursor?, limit? }):
  { items: OutputRecord[]; nextCursor: string | null }
store.executions.history(runId, path): ExecutionHistory
```

- `runs.list` includes active and terminal runs, newest first by
  `(created_at, id)`. Cursors are opaque, query-bound and error on a foreign,
  malformed, stale or ahead anchor instead of silently truncating.
- `view.snapshot` runs one `BEGIN DEFERRED` read transaction (or joins an
  existing write transaction) and captures the run header, `RunView` and
  `watermark = MAX(events.id)` together. The view reflects exactly events with
  `id <= watermark`; events appended afterwards never leak into it.
- `events.page` is run-scoped, caps `limit` at 500 and validates `after` against
  the run watermark. `pathPrefix` is literal (`%`, `_` and `\` are escaped), not
  a SQL pattern. `upTo` pins a backlog to a snapshot watermark. Cross-run,
  future and vanished positions are errors.
- `outputs.listByProvenance` exposes immutable `output`, `input`, `map_result`
  and `loop_carry` rows for historical attempts; the existing `outputs.get`
  still returns only an accepted `kind='output'`.
- `executions.history` reconstructs attempts, process generations (spawn/stop
  evidence, PIDs, exit reasons) and transcript refs from immutable events only.
  Its timestamps are the stored raw `events.ts` epoch milliseconds; a corrupt
  value fails with `E_INTERNAL` instead of fabricating epoch zero.

Start idempotency is atomic with run creation:

```ts
store.runs.create({ ...input, idempotency?: { scope?, key, fingerprint } }):
  { runId, runNumber, duplicate: boolean }
```

The claim lives in the existing `kv` table as
`idem:` + JSON `[projectId, key]` -> `{ fingerprint, runId, runNumber, createdAt }`.
`scope` defaults to and must equal `projectId`. A same-key/same-fingerprint
retry inside 10 minutes returns the original run with `duplicate: true` and
allocates no run row, event or run number. A different fingerprint is
`E_CONFLICT`. Expired claims are replaced. The write is in the same
`BEGIN IMMEDIATE` transaction as the run and its `run.created`/`run.started`
events, so it survives process restart; no new migration or dependency is
needed. The runtime/engine must not dispatch a `duplicate: true` launch.

Recovery policy:

- Terminal runs are skipped entirely (`rebuilt:false`, no writes).
- Accepted-but-unfinalized: a running/validating execution is interrupted but
  never moved to ready. The engine records the real crash stop, finalizes the
  workspace, and calls `completeAcceptedAfterRecovery` with the original
  accepted identity. Report decision: `await_accepted_finalization`.
- Unaccepted agent interrupted -> `ready`; a later `beginInvocation` opens a
  new generation (session resume is the engine's choice).
- Interrupted (or boot-running) shell: stays/becomes `interrupted` and pauses
  the run with `run.paused {reason:'uncertain_side_effect'}`. It is never
  replayed automatically. `beginInvocation` refuses it unless the caller passes
  `allowUncertainSideEffectRetry:true` and `approvedBy:<user>` while the run is
  paused for that reason; the approval is written to `uncertain_retries` and a
  user `run.resumed` event. Report decision: `pause_uncertain_side_effect`.
- `crashAttempts` persists across generations/reopen and increments only for
  `node.process.stopped {reason:'crash'}`; `killed`, `grace_timeout` and
  shutdown interruptions do not consume a crash retry.

## Identity and fencing

- `attempt` is the logical try; `generation` is the process invocation.
- Pending/initial execution identity uses `attempt=1, generation=1` (core
  forbids generation 0). The first `beginInvocation` therefore yields
  `generation=2`; later spawns in the same attempt are 3, 4, ...
- Authorization is exact equality via `@devchestra/core`'s
  `isCurrentInvocation`: older, future, other run/path, other attempt and
  other generation are all rejected.
- `beginInvocation` from `pending` or `interrupted` first emits an allowed
  `-> ready` transition, then `ready -> running` with the new generation; it
  never emits an illegal direct transition.
- Terminal runs accept no new submissions, invocations, process/workspace
  markers or completion. A committed receipt replay and an existing accepted
  output remain readable/idempotent. Recovery skips terminal runs entirely, so
  their events and `ended_at` do not move.
- `process_generations` records pid/lstart and stop evidence. The store never
  verifies an OS pid itself; callers record real evidence.
- Tokens are not part of the schema and the token-to-scope map lives outside
  the store; receipts store only `(identity, callId, requestFingerprint)`.
- `security.registerSecret(value, name)` adds an in-memory value (for example
  the current exec token) to a fail-closed guard. `openStore({ secrets })` can
  preload values. A valid submission whose output (including keys) contains a
  registered value or a built-in token pattern is rejected with `E_VALIDATION`
  and nothing is written; the error carries only the JSON path/label, never
  the value. Secret-bearing `callId`s are rejected. Event payloads and receipt
  error text are redacted (`[redacted]` / `[redacted:<name>]`) before insert.
  Request bodies are never persisted, only their canonical fingerprint.
  Registration/unregistration does not touch disk. `runs.create` also rejects
  secrets found in `snapshotRaw`, the snapshot, params or budgets before it
  allocates a run number.

## Schema (migration `0001_init.sql`)

`schema_migrations`, `projects`, `runs`, `run_views`, `events`, `executions`,
`process_generations`, `outputs`, `tool_receipts`, `kv`.

- `outputs` has `UNIQUE(run_id, path, attempt) WHERE kind='output'`; one
  accepted output per logical attempt. `kind` may be `input`, `map_result` or
  `loop_carry`; these never imply success because accepted reads and the
  reducer use only `kind='output'` plus `node.output.validated`.
- Migrations are forward-only, one transaction each, recorded in
  `schema_migrations` and mirrored in `PRAGMA user_version`. `0002` is
  additive: `process_generations.pid_start/binary/cwd`,
  `executions.kind`, and the `uncertain_retries` audit table; databases
  upgrade in place and existing rows/events are preserved. Earlier migrations
  are never rewritten. There is no automatic backup before migration: take a
  copied canary database before upgrading production data; this gap is
  intentional and documented. A database newer
  than the build is refused. Runtime lookup is `new URL('../migrations/...')`
  from both `src/` and `dist/`, so it resolves `packages/store/migrations`;
  the package `files` list ships that directory. The SIGKILL test imports
  `dist` and therefore exercises built migration loading.
- Event payloads are capped at 64 KiB; larger data must be stored as an output
  reference by the caller. Payload strings get best-effort token-pattern
  redaction; this is defense in depth, not the primary secret boundary.

## Scope and limits

- There are no `artifacts`, `pins`, `provider_state`, `supervisor_recs`,
  context banks/FTS or `cli_probe_cache` tables, and no backups, retention,
  `stats()` or `VACUUM INTO`.
- Redaction/rejection uses built-in token patterns plus explicitly registered
  in-memory values; it is not wired to the config redactor or an exhaustive
  entropy scan. Request bodies are not persisted but are still caller-owned;
  keep secrets out of them. Validated outputs are rejected rather than silently
  mutated.
- Projections are stored as the serialized core `RunView` plus materialized
  execution/run rows (rather than only row-level incremental code). Both
  incremental appends and `rebuild` use the same core reducer; tests assert
  equality.
- `validation_limit` is operational configuration stored on `executions`; it
  is preserved across projection rebuilds. There are no per-execution
  `active_ms` or `quota_resume_at` columns because nothing derives them;
  run-level active time lives in `runs.active_ms`/events.
- There is no generic retry/attempt-advance API; the only exception is the
  audited uncertain-shell generation retry. Terminal run retry is forbidden.
- Deterministic outputs share the per-attempt unique output index, so a
  new generation in the same logical attempt cannot write a second output;
  a retry needs a new logical attempt.
- No transcript files, WAL checkpoint tuning, backup-before-migration, or
  cross-process single-instance lock. The server owns that lock.
- Process stop/workspace evidence is caller-recorded; the store cannot prove
  external effects. The store never claims exactly-once side effects.

## Test evidence

Tests use real temporary SQLite files (not `:memory:`) and cover: WAL and
foreign keys, reopen, rollback plus post-commit bus, valid/invalid duplicate
receipts, same-callId altered payload, stale/future generation rejection,
accepted != succeeded, input row is not an accepted output, output uniqueness,
incremental == full replay == rebuild == reopened, `node:sqlite` fallback,
registered/pattern secret rejection with an on-disk absence check, and a
child-process SIGKILL prefix/replay boundary. Real-file tests also cover
project relink identity/duplicate paths, active+terminal run pages with tied
timestamps, snapshot/live watermark races, literal `%`/`_` event prefixes,
cross-run and future cursors, historical output/input provenance, event-derived
attempt/process/transcript history, and restart-safe idempotent starts
(including rollback of the claim with the run).

```sh
pnpm --filter @devchestra/store build
pnpm --filter @devchestra/store typecheck
pnpm --filter @devchestra/store test
```

The kill test imports `dist`, so run `build` first (the test skips if `dist`
is absent).
