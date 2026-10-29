# Conditional loops: design and implementation plan

Status: implementation reference for `feature/bounded-loops`. See [the usage guide](loops.md) for the supported contract and examples. The original proposal below includes later extensions; run-level spending budgets remain unsupported, despite the initial assumption that enforcement already existed.

## Recommendation

Support an explicit **Repeat until** loop with a bounded body graph. Keep the parent graph and each body acyclic. The editor may draw a return connection, but it must belong to a declared loop; arbitrary edges back into earlier nodes remain invalid.

The proposed if/else plus return edge is a useful visual model. It does not, by itself, define execution semantics. A loop controller supplies the missing iteration boundary, input state, completion rules, and recovery behavior.

Start with sequential, postcondition loops: execute the body at least once, evaluate the condition, then finish or start the next round. Add precondition loops, nested loops, and collection iteration separately once this foundation is reliable.

## Existing foundations and constraints

- `packages/schema/src/types.ts` already defines `gate` (ordered expressions plus otherwise), `decision` (model-assisted branching), and explicit `join` nodes. An if/else node does not need to be invented.
- `packages/schema/src/graph.ts` rejects cycles and permits multiple inbound edges only on joins.
- `packages/core/src/routing.ts` derives readiness from executions indexed by node ID. Successful and skipped nodes remain terminal, and pending incoming edges prevent dispatch.
- `packages/engine/src/graph-plan.ts` validates the graph and calculates ancestor scopes. Cyclic ancestry would also make output visibility ambiguous.
- `packages/store/src/executions.ts` stores executions by run and path, with separate attempt/generation identities. This is a useful foundation for distinct rounds.
- `packages/core/src/path.ts` already supports round paths such as `refine#2/implement` and filesystem-safe encoding. Reuse those helpers rather than creating a second identity format.
- Workflow-wide token, cost, and active-time budgets already exist. Loops must use the same accounting.

## Why simply allowing return edges causes problems

| Problem | Example | Required rule |
| --- | --- | --- |
| First-round deadlock | Implement waits for both Start and the not-yet-run Review | Initial entry and next-round activation are alternatives, not an all-input join |
| Repeated dispatch | Both predecessors activate the same node | Exactly one activation per round; reject ambiguous control flow |
| Stale outputs | Review round 2 reads Implement round 1 | Resolve outputs by round and scope |
| Terminal state reuse | Implement already succeeded, so never executes again | Each round has new execution paths |
| Branch leakage | A skipped branch in round 1 stays skipped in round 2 | Fresh routing state for each round |
| Premature exit | An outside node sees an intermediate result | Publish loop output only after completion |
| Unbounded spending | Agent keeps finding another improvement | Mandatory maximum rounds and shared run budgets |
| Crash ambiguity | Crash occurs between deciding repeat and scheduling work | Durable decision and idempotent next-round activation |
| Repeated effects | A resumed round sends a message or deploys twice | Explicit effect/recovery policy and invocation identity |
| Workspace divergence | Every round starts from a fresh checkout | Define how edits and commits carry forward |
| Tangled cycles | Two loops overlap or enter each other midway | Declared boundaries; reject crossing edges |

Multiple incoming edges can mean “wait for all,” “take one alternative,” or “run once per arrival.” Those are different operations. Keep joins explicit; the loop controller handles the initial-versus-repeat case without changing every node's meaning.

## Proposed user experience

Create a Repeat until block, place nodes inside, select the stop condition, and set maximum rounds. A typical agent workflow is:

```text
Start -> [ Refine loop                              ] -> Publish -> End
         [ Implement -> Test -> Review -> Body result ]
         [                  condition: result.passed  ]
         [ false: repeat       true: complete         ]
```

The body can contain existing gates, decisions, and joins. The stop expression is deterministic and evaluates structured data; a model-assisted review can produce that data using the existing decision/agent mechanisms. A malformed or uncertain answer must follow an explicit branch or fail, rather than silently becoming “passed.”

An initial implementation can use a body editor opened from the loop node. An expanded canvas group and drag-to-connect return gesture can follow. If a return gesture is added, offer to create a loop boundary and validate it instead of accepting an unrestricted cycle.

## MVP contract

Proposed schema shape, subject to parser and expression compatibility review:

```text
type: loop
mode: repeatUntil
maxIterations: 5
initialState: <mapping evaluated once in parent scope>
body: <acyclic graph with one entry and one result boundary>
result: <mapping from current-round outputs>
until: <boolean expression over current result and loop state>
nextState: <mapping evaluated only when continuing>
output: <JSON schema for published result>
```

1. Rounds are numbered from 1. `maxIterations` is required, positive, and subject to a documented system ceiling.
2. Each round receives immutable parent inputs, `loop.iteration`, `loop.maxIterations`, and `loop.state`. Parent inputs are captured once when the loop starts.
3. Child nodes see permitted ancestors within their current body execution. Prior-round outputs are visible only through explicit carried state, not through an implicit “latest output.” Reserve loop context names and validate scope collisions.
4. Every active body path must converge on one result boundary using explicit joins where needed. There must be no remaining active child work before evaluating completion. Body completion does not end the whole run.
5. Validate the result mapping, then evaluate `until` exactly once for that completed round. A non-boolean result or expression error fails the loop. Use the existing bounded expression evaluator.
6. If true, publish the validated result and round count, and complete the loop. The parent successor can then execute once.
7. If false and rounds remain, validate and persist `nextState`, then create the next round. If false on the final allowed round, fail with a specific iteration-limit error. A true condition on the final allowed round still succeeds.
8. Agent retries and crash recovery stay within the same round; they do not consume additional loop rounds. A failed body node follows existing failure policy and does not automatically mean “repeat.”
9. Re-evaluating a finished round must reuse its persisted condition result, never call a decision model again or change branches during recovery.
10. MVP loops execute one round at a time. Nested loops, arbitrary jumps, parallel rounds, break/continue nodes, and zero-round while loops are rejected with clear validation messages.

## Durable execution and recovery

Keep the controller at path `refine`, and use child paths such as `refine#1/implement`, `refine#1/review`, and `refine#2/implement`. Round identity is separate from existing retry attempts and process generations.

Persist controller state and events covering round start, result/condition evaluation, continuation, and completion. Record the input/state snapshot, accepted output references, condition result, and next action. The transaction that records continuation must establish a uniquely identifiable next round; dispatch can happen after commit and be reconstructed from durable state.

Recovery must be correct after a crash before or after every transition: round creation, child completion, condition recording, next-state recording, next-round activation, and final publication. Use existing stale-invocation checks to reject late results from prior generations and rounds. Avoid resetting completed execution rows to pending.

The parent routing view treats the loop as one node. Each round derives a separate routing view for its body. Terminal and skipped states stay local to that view. Update event projections, API responses, and history queries to understand parent/child paths; do not assume that existing path support makes all these layers ready.

Engine bookkeeping can be made idempotent. External shell/agent effects cannot be guaranteed exactly once after a crash without cooperation from the target service. Keep approval requests tied to execution identity, pass idempotency keys where supported, and surface interrupted irreversible work for reconciliation under the existing approval policy.

## Workspaces, sessions, and budgets

- Begin with an explicitly selected shared working directory for the loop. Acquire ownership for its lifetime and serialize conflicting mutating work. Preserve edits between rounds; retain per-round output and change references for inspection.
- Reject per-node worktree modes inside the MVP loop until there is a tested policy for feeding round N's finalized changes into round N+1. Creating unrelated fresh worktrees would defeat refinement.
- Use fresh agent sessions per round initially, with explicit carried context and the shared files. A normal retry/resume inside a round follows existing session behavior. Automatic cross-round session reuse is a later option.
- Charge every invocation, review, and retry to the existing run budget. Enforce budgets before dispatch as well as through existing in-flight limits; preflight cannot predict an agent's final cost exactly.
- Pause prevents new dispatch, cancellation stops active child process trees, and resume restores the current round. Approval waiting and active-time accounting must match existing run semantics.
- Never accumulate every full output in the prompt by default. Bound state size; keep full round history in storage and expose references on demand.

## Implementation sequence

1. **Schema and semantics:** add loop parsing, normalization, serialization, recursive body validation, round limits, reserved context, boundary rules, and workspace restrictions. Preserve current behavior for existing workflows. Decide schema-version handling explicitly: older readers must reject unsupported loop files clearly.
2. **Core and store:** introduce controller lifecycle events/projections, unique round identity, durable carried state and decisions, child queries, and atomic continuation. Review whether current tables suffice or need an additive migration.
3. **Engine:** extract a scoped graph execution primitive, execute the body using current adapters, bind per-round expressions, collect the body result, enforce limits, and drive the durable controller. Audit output acceptance, workspace ownership, approval identity, budgets, and stale-result rejection.
4. **API and editor:** expose nested execution history, configure loop state/condition/limits, support a body editor, show current round and reason for exit, and make errors navigable to the relevant round/node. Existing workflow editor loading/saving must preserve loops.
5. **Acceptance:** build the Implement -> Test -> Review example with fake agents, exercise native shell/process cleanup on Windows and Unix, then perform an explicitly configured live-agent smoke run. Add a real agent integration only with a bounded budget and the required credentials.

Ship these as incremental reviewable changes on a dedicated loop feature branch rather than coupling implementation to Windows portability changes. This proposal itself does not change branches or runtime behavior.

## Required acceptance cases

- Condition true on round 1; false then true; true on final round; false on final round.
- Invalid condition, missing mapped result, invalid carried state, malformed body, crossing edges, nested-loop rejection, and ambiguous body completion.
- Gate/join paths change between rounds with no stale skips, approvals, or outputs.
- Same node ID has separate logs, accepted outputs, workspaces/references, and invocation identities in every round.
- Retry remains in its round; late process results cannot complete a different round; parent successor executes once.
- Crash and restart at each controller transition, including after next-round commit but before dispatch and after loop completion but before parent dispatch.
- Cancel during an agent or shell child, pause/resume during approval, budget exhaustion, workspace contention, and retained edits across rounds.
- Existing acyclic workflows, persistence replay, and Windows/Unix process lifecycle checks continue to pass.

## Later extensions

Add precondition while loops with explicit zero-round output, nested loops with hierarchical budget limits, collection foreach/map with separate concurrency semantics, explicit break/continue, and optional stagnation detection. Consider unrestricted cyclic graphs only if real workflows need them; they require a general activation/token model with explicit merge and correlation rules across the entire runtime.
