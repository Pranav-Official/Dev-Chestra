# @relay/core

Browser-safe shared contracts for Relay (working name). Pure types and functions only: no I/O,
no Node built-ins, no runtime dependencies.

## Commands

```sh
pnpm --filter @relay/core build
pnpm --filter @relay/core typecheck
pnpm --filter @relay/core test
pnpm exec biome check packages/core
```

## Public API (`src/index.ts`)

- `Result`, `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `mapResult`.
- `RelayError`, `ErrorCode`, `RelayErrorOptions`.
- `Clock`, `systemClock`, `FakeClock`; `IdGen`, `systemIds`, `FakeIdGen`, `isUlid`.
- `RunId`, `ProjectId`, `WorkflowId`, `NodeId`, `EntryId`, `Brand`.
- `Path`, `Segment`, `parsePath`, `formatPath`, `parent`, `isUnder`, `fsSlug`, `RUN_PATH`,
  `SUPERVISOR_PATH`.
- `canonicalJson`, `sha256Hex`, `hashJson` (async; Web Crypto, no Node imports).
- `ExecutionIdentity`, `createExecutionIdentity`, `sameExecution`, `isCurrentInvocation`,
  `isStaleCallback`, `nextGeneration`, `nextAttempt`, `ToolCallReceiptKey`,
  `createToolCallReceiptKey`, `sameToolCallReceiptKey`.
- Events: `EventEnvelope`, `KnownEventEnvelope`, `UnknownEventEnvelope`, `EventDraft`,
  `EventPayloads`, `EVENT_TYPES`, `KnownEventType`, `EventType`, `Actor`, `NodeKind`, JSON
  value types.
- Transitions: `ExecStatus`, `RunStatus`, `ALLOWED_TRANSITIONS`, `RUN_TRANSITIONS`,
  `canTransition`, `assertTransition`, `canRunTransition`, `assertRunTransition`, terminal
  helpers.
- Reducer/projection: `RunView` (including `pauseReason`/`pauseDetail`/`pausePath`), `ExecView`
  (including `recordedOutput`/`processSpawned`), `emptyRunView`, `reduce`, `project`,
  `AcceptedResultRef`, `ProcessStoppedRef`, `WorkspaceFinalizedRef`, `isDurablyComplete`,
  `acceptedInvocation`, `recoveryDecision`.

## Important conventions

- `Path` is a branded string. `""` is the run-level path. `parsePath` rejects non-canonical
  index/round forms (`[01]`, `#0`, both suffixes).
- `fsSlug` is collision-free. The draft's `-`/`__` substitution collides with legal node ids,
  so structural markers use `+` (impossible in a node id): `[i] -> +i<i>`, `#n -> +r<n>`,
  `/ -> ++`. Example: `refine#2/critic -> refine+r2++critic`. Exact Windows reserved stems get
  a leading `_`.
- Execution identity is `(runId, path, logical attempt, process generation)`, starting at
  `1/1`. Authorize with `isCurrentInvocation` (exact equality); `isStaleCallback` is only a
  diagnostic and does not reject future generations.
- A tool receipt key is the execution identity plus `X-Relay-Call-Id`. A transport retry reuses
  the callId; a fresh model call gets a new callId even with identical arguments. Adapter
  callbacks that emit session/usage/transcript events use actor `engine`; there is no
  `adapter` actor.
- An accepted result is not success. `node.state -> succeeded` requires an accepted result
  when the execution requires submission, plus `node.process.stopped` and
  `node.workspace.finalized` matching the accepted attempt/original generation. Output rows
  alone never imply success.
- Accepted results are immutable and survive recovery by adoption; never re-submit or
  overwrite them. Once an accepted result exists, recovery finalizes under the original
  attempt/generation and must not start a new process generation.
- `reduce` is pure. Duplicate or older event ids are ignored (`id <= lastEventId`). Unknown
  event types and versions newer than `1` advance `lastEventId` and have no view effect, so
  replay remains forward-compatible.
- `run.created` carries `runNumber`; `node.state` may carry `init { kind, requireSubmission }`.
  These are deliberate P0 extensions used by the projection and durable-success gate.

## Limits

- No persistence, transport, filesystem, process execution, credential handling or OS sandbox.
  Relay is not a sandbox; see `docs/adr/0003`.
- No exactly-once promise for shell commands or arbitrary agent side effects.
- `workspace.created`/`workspace.committed`, `node.process.spawned`, and
  `node.output.recorded` require `attempt` and `generation`; late events from an older
  attempt/generation are rejected instead of overwriting the current execution.
- `node.process.spawned` carries only non-secret process evidence
  `{pid,pidStart,binary,cwd}`; argv/tokens are not stored. It is idempotent for identical
  evidence and conflicts on different evidence for one generation.
- `node.output.recorded` is the deterministic non-agent output reference. It never sets an
  agent accepted result. `shell` success additionally requires process-stop and
  workspace-finalization markers; `start`/`end` require only the recorded output.
- `run.paused {reason:'uncertain_side_effect'}` exposes `pauseReason`, `pauseDetail`, and
  `pausePath` on `RunView`. It does not auto-replay an ambiguous shell effect.
- `crashAttempts` increments once per crashing generation from `node.process.stopped
  {reason:'crash'}`, survives new generations and retry attempts, and is the retry budget.
- Retry-from-node clears per-attempt session/workspace/result/last-error provenance.
  `tokensIn`/`tokensOut`/`costUsd` are cumulative; `attemptTokensIn`/`attemptTokensOut`/
  `attemptCostUsd` reset for the new attempt.
- Future catalog events have versioned payloads but no reducer effect in this P0 slice.
- Context banks, pins, maps/loops and persistent user-data conventions are deferred.
- `sha256Hex`/`hashJson` return promises. Synchronous/native hashing belongs in a server layer.
- `budget.activeMs` is approximate and includes quota/human waits. Time budgets are not
  enforced in P1; callers must reject `maxActiveMinutes` before starting rather than accept an
  unenforced cap. Token/USD caps are accepted only when real accounting enforces them.
- `fsSlug` is injective, but callers must still enforce filesystem component length limits for
  very deep paths.
- Relay is a provisional product name.
