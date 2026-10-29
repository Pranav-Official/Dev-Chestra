# Reference-backed execution context

The resume-generation failure (`E_OUTPUT_INVALID: Loop parent inputs exceeds
the 16 KiB JSON limit`) came from copying all upstream inputs/outputs into
`loop.parent`. The fix is architectural: capture immutable references instead
of values.

## Principles

- One workflow run owns its context. All references carry `runId`, and the
  capture row is checked against the loop controller path that owns it.
- Node outputs are stored once in the durable `outputs` table; captures pin
  exact accepted output IDs (run/path/attempt/kind), never latest outputs.
- Discovery is global, but execution access follows dependencies and scope.
- `{{ node.property }}` and expression syntax are unchanged.
- No global catalogue is injected into agent prompts.
- 16 KiB bounds remain on loop state, next-state, and round results.
- Parent data stays out of events and projections.
- Reducers remain pure (no storage I/O); legacy inline-parent runs replay.

## Capture shape (tagged/versioned)

`packages/core/src/execution-context.ts` defines the only representation:

- `ExecutionContextRef { kind: "devchestra.execution-context/v1", captureId }`
- `ExecutionContextManifest { version: 1, runId, loopPath, entries }`
- Entries: `{ name, type: "run-params" }`, `{ name, type: "output",
  outputId, path, attempt, nodeKind, hash }`, `{ name, type: "literal",
  value }`.

No heuristics on user JSON keys. Reducers check the `kind` tag; exactly one
of `parent`/`parentRef` is valid on new `loop.started` events.

## Durable persistence and centralized verification

- Table `context_captures` (`migrations/0006…`). `Store.contextCaptures`
  (`packages/store/src/context-captures.ts`) creates (deterministic id for
  idempotent retries), fetches, and resolves captures.
- `verifyOutputReference` is the single verification path used by both
  creation and resolution. For every output reference it checks: run
  ownership, path and attempt provenance, accepted-output kind (`output`;
  `input`/`map_result`/`loop_carry` rows are rejected), and content identity
  recomputed with the project's canonical hashing (`hashJsonSync`), never a
  bare stored-hash comparison. Manifest version/schema, capture run/loop
  ownership, and stored-bytes integrity are rechecked on every resolution.
  Failures are explicit (`E_NOT_FOUND`/`E_CONFLICT`/`E_FORBIDDEN_PATH`);
  nothing falls back to latest output.
- `Store.loops.start` accepts exactly one of `parent` (legacy, 16 KiB
  checked) or `parentRef` (new, ownership + loop-path checked). Creation +
  start commit atomically via nested `store.tx`.
- Literals are capped (`CAPTURE_LITERAL_MAX_BYTES`, 16 KiB) and must be
  canonical-JSON-serializable, so they cannot become a bulk-output escape
  hatch. Manifests are capped at 1 MiB (`CAPTURE_MANIFEST_MAX_BYTES`).
- Secret policy: run params, literal values, and referenced outputs are
  scanned authoritatively at capture time (outputs were also scanned at
  submission/record time). Values are immutable afterwards, so resolution
  verifies ownership and content identity but does not rescan; see
  `resolveCaptureScope`.

## Engine resolution and cache lifetime

- `packages/engine/src/execution-context.ts`: `resolveCaptureScope` reads
  through the store verifier, with a bounded run-scoped cache
  (`ExecutionContextCache`, 200 entries max).
- Cache entries store the owning `runId`; hits recheck ownership and return
  frozen `structuredClone` copies so shared mutation cannot change future
  resolutions.
- `EngineContext.releaseRunContext` evicts a run's entries on terminal
  transitions reached through the engine (`completeRun`, `failRun`).
  Paused/resumable runs keep theirs so resume resolves the same outputs.
  Runs cancelled outside the engine age out via the 200-entry bound;
  correctness never depends on eviction because hits recheck ownership.
- `collectParentContext` is the single ancestor walk shared by capture
  creation and initial-state evaluation (mirroring `chainOutputs`/
  `ancestorValue` semantics: start alias, skipped/failed → null literal,
  succeeded → exact accepted output with the decision `confidence: 0`
  adapter, pending/running → throw). Nonstandard start node ids keep both
  the `start` alias and the real node key, matching legacy scope contents.

## Compatibility

- Legacy `loop.started { parent }` events and cached views (backfilled with
  `parentRef: null`) replay unchanged.
- API event/view schemas accept `parent` XOR `parentRef`.
- Existing agent input behavior is unchanged (covered by engine loop tests).

## Limits (explicit)

- `loop.state`, `nextState`, `result`: 16 KiB JSON each (unchanged).
- `loop.started` event: 64 KiB store cap; reference payloads are < 1 KiB.
- Capture manifests: 1 MiB bound. Literals: 16 KiB each.
- Expression evaluation (64 KiB result) and model-input rendering bounds are
  separate and unchanged.

## Discovery catalogue (Part B)

`packages/schema/src/discovery.ts` (pure, no run needed):

- Declared outputs per node kind; nested/local-`$ref` schemas with bounded
  traversal (depth 6, 200 props, recursion guard); unions expose object
  properties only when every branch qualifies, else whole-value; arrays are
  whole values (no invented indices); open objects and unknown shapes fall
  back to honest whole-value entries.
- Explicit join output schemas via shared `analyzeJoinSources`: `all` mode
  exposes per-input entries (with per-source schema properties where known);
  `first` mode exposes the declared output schema as a nullable whole value.
- Scope rules mirror validation (`allowed = start + ancestors`, loop
  `initialState`/`result`/`until`/`nextState`/body scopes from `loop.ts`).
  Conditional marks cover joins and ancestors upstream of skippable joins
  behind gate/decision branches — not joins alone. Each catalogue operation
  analyzes each graph once and shares the analysis across sources.
- Availability: available / conditional / needs-dependency / unavailable /
  loop-scoped. Loop namespaces (`loop.iteration`, `loop.maxIterations`,
  whole `loop.state`, `loop.parent.*`, `result` where allowed) are real
  selectable entries; unfinished controller results never appear in bodies;
  parent nodes are discoverable in bodies but insert only via `loop.parent.*`.
- References are serialized safely: reserved literals (`true`/`false`/`null`),
  unusual keys, quotes, and escapes are quoted; validity is tested by
  compiling and evaluating, not string comparison. Template safety
  (`{{`/`}}`) is checked separately from expression safety, so
  template-unsafe keys remain insertable as expressions. No new global roots.

## Variable picker (Part C)

`apps/web/.../fields/VariablePicker.tsx` + `useVariableField`:

- Attached `{}` button (subtle until hover/focus, keyboard accessible),
  searchable popover (`role=dialog`), grouped by node, type + availability
  labels, whole-output insertion. One centralized rule,
  `isInsertableForMode`, gates click, keyboard, and drag: in-scope
  availability plus structural insertability plus mode-appropriate syntax
  safety. Unavailable and needs-dependency entries stay visible with
  explanations but are never insertable. No auto-rewiring.
- One shared insertion path: caret remembered on picker-button mousedown
  while the field is focused (never-touched fields append at end); live
  selection trusted only while focused; drop uses the real pointer position
  via `caretRangeFromPoint`/`caretPositionFromPoint` with a documented
  caret fallback where unsupported; selection replacement; focus/caret
  restore; ordinary text drops pass through untouched (dedicated MIME
  `application/x-devchestra-variable`, dragover accepted only for it).
- Popover: Escape closes from every child control, outside click dismisses,
  search input keeps normal mouse interaction.
- `useVariableField` removes repeated ref/scope/insert/drop wiring; fields
  keep their existing buffered/controlled handlers, validation, undo, and
  save/run blocking. Template fields insert `{{ expr }}`; expression fields
  insert `expr`. Eligible: agent prompt, shell command, approval message,
  decision state (templates); gate branch condition, end result, loop
  expressions (expressions). No picker on literal-only fields. Loop-body
  forms use the local draft graph plus the outer parent graph with explicit
  loop identity; Apply persists, Cancel discards.

## Runtime inspection (Part D)

- `Store.outputs.listMetadata/getMetadataById`: metadata without hydrating
  JSON. Shared `OutputPreview` contract reused for values; new
  `OutputMetadata`, `RunContextEntry`, `RunContextResponse` DTOs/schemas
  with response validation and typed `ApiClient` bindings (`getRunContext`,
  `getRunOutput`).
- `GET /api/runs/:runId/context`: bounded pagination (`limit`, `cursor`,
  `pathPrefix`, `status`), execution identity/attempt/generation/status,
  output id/hash/size, capture id — built from execution rows plus one
  bounded metadata query (no projection hydration, no N+1). `loopRound` is
  the enclosing round parsed from body execution paths, or the controller
  iteration derived from loop events. Schemas resolve via the frozen run
  snapshot served by run detail.
- `GET /api/runs/:runId/outputs/:outputId`: ownership-checked; metadata
  bytes are checked first, and oversized values return truncation metadata
  without hydrating or parsing the value (existing 64 KiB preview
  semantics preserved). The picker works without a run; no new panel.
