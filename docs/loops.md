# Repeat until loops

A loop runs its body at least once, checks a condition, and either publishes its result or starts another round. The parent workflow waits for the loop to finish. Both the parent graph and body remain acyclic; unrestricted backward connections are invalid.

## Configuration

| Field | Meaning |
| --- | --- |
| `mode` | `repeatUntil` |
| `maxIterations` | Required integer from 1 to 1000 |
| `initialState` | JSONata expression evaluated once in the parent scope; defaults to `{}` |
| `body` | Graph with one Start, one successful End, and no nested loops |
| `result` | JSONata expression evaluated over the current round's ancestors of End |
| `output` | JSON schema validating each round's result |
| `until` | JSONata expression returning a boolean; true completes the loop |
| `nextState` | JSONata expression returning the next round's state; defaults to `loop.state` |

Body nodes can use `loop.iteration`, `loop.maxIterations`, `loop.state`, and `loop.parent`. `loop.parent` is a snapshot of the outer scope when the loop starts; run parameters are available at `loop.parent.start`. The body's Start has no parameters and produces `{}`. Body node IDs `loop` and `result` are reserved.

`initialState` and `nextState` must return objects. `until` and `nextState` also see the current round's mapped `result`. Results, state, and captured parent inputs are each limited to 16 KiB of JSON. Carry only the data needed for the next round; store large artifacts in files and pass references.

After completion, a downstream node sees this envelope under the loop's node ID:

```json
{"result": {"passed": true}, "iterations": 3, "outcome": "condition_met"}
```

`outcome` is `condition_met` when `until` matched within `maxIterations`, or `iteration_limit` when the iteration budget was exhausted (see below). `result` is always the last round's mapped result. Expression errors, invalid output, and body failures fail the loop. They do not automatically request another round. Retries belong to the same round.

## Success and exhausted outputs

A loop has two outputs:

| Edge `from` | Taken when |
| --- | --- |
| `refine` (plain, the success output) | `until` matched on any round up to `maxIterations`, including the last one |
| `refine.exhausted` | `until` was still false after round `maxIterations` |

Exactly one branch is activated; the other is skipped, so a downstream join sees it as a skipped input. No round beyond `maxIterations` ever runs. Any other handle name (for example `refine.success`) is rejected by validation. In the editor the loop node shows labeled **success** and **exhausted** handles.

Exhaustion routes only when `refine.exhausted` is wired. With no exhausted edge, a condition that is false on the final permitted round still fails the run with `E_LOOP_LIMIT`, exactly as before, so existing workflows never silently succeed on a spent budget. Real errors (expression errors, invalid output, body node failures) always fail the run, even when the exhausted output is wired; only an honestly exhausted budget is routed.

Durably, each terminal round records an explicit `outcome` on its `loop.iteration.decided` event. `done` keeps meaning "the stop condition matched": an exhausted round is `done: false, outcome: "iteration_limit"` and carries no `nextState`. A terminal round (either outcome) rejects any later decision and is idempotent on replay, so a restart after the final decision publishes the recorded outcome instead of running another round. Events and runs recorded before this field existed stay valid: `done: true` is read as `condition_met`, and a legacy exhausted `false` round is not terminal, so it still fails with `E_LOOP_LIMIT`.

## Example

This complete workflow needs no agent credentials and finishes on round 3:

```json
{
  "schemaVersion": 1,
  "id": "repeat-example",
  "name": "Repeat example",
  "graph": {
    "nodes": [
      {"id": "start", "type": "start", "name": "Start", "params": []},
      {
        "id": "refine", "type": "loop", "name": "Refine",
        "mode": "repeatUntil", "maxIterations": 5,
        "initialState": "{\"previous\": 0}",
        "nextState": "{\"previous\": result.round}",
        "result": "{\"round\": loop.iteration, \"previous\": loop.state.previous}",
        "until": "result.round >= 3",
        "output": {"type": "object", "additionalProperties": true},
        "body": {
          "nodes": [
            {"id": "start", "type": "start", "name": "Start round", "params": []},
            {"id": "done", "type": "end", "name": "Finish round", "status": "success", "result": "{}"}
          ],
          "edges": [{"id": "body-edge", "from": "start", "to": "done"}]
        }
      },
      {"id": "end", "type": "end", "name": "End", "status": "success", "result": "refine"}
    ],
    "edges": [
      {"id": "enter", "from": "start", "to": "refine"},
      {"id": "exit", "from": "refine", "to": "end"}
    ]
  }
}
```

To branch on exhaustion, add a second edge such as `{"id": "spent", "from": "refine.exhausted", "to": "give-up"}`; the plain `exit` edge keeps its meaning as the success output.

For an agent refinement workflow, replace the body with Implement -> Test -> Review -> End. Return a structured review result, use it in `result`, and set `until` to `result.passed = true`. Existing gates and joins can route alternative paths inside a round.

## History, recovery, and workspaces

Each body execution has its own path, for example `refine#1/implement` and `refine#2/implement`. Outputs, transcripts, approvals, retries, and process identities remain distinct. A recorded round decision survives restart; the engine resumes from it rather than rerunning a completed round. An interrupted shell still follows the existing uncertain-side-effect approval policy.

All rounds use the prepared run workspace, preserving edits. While a loop run is active or parked, other runs in the same store cannot use an overlapping project/existing-worktree directory. Use a new per-run worktree for independent concurrent work. This ownership rule does not prevent manual edits or programs outside DevChestra. Per-node worktree mode is unsupported inside a loop. Agent sessions start fresh for each round; explicit carried state and files provide continuity. A retry within the same round follows normal session recovery.

External effects cannot be made exactly once by the orchestrator alone. Use service idempotency keys or approval steps for irreversible actions. Cancellation uses the same native child-process cleanup as other workflow nodes.

## Current limits

- Sequential postcondition loops only; no nesting, arbitrary jumps, parallel rounds, break/continue, or zero-round while loops.
- A loop body has exactly one successful End; converge alternative branches with joins.
- The required iteration limit bounds repeated invocation count. Existing workflow/run spending-budget settings remain rejected by the runner; this feature does not add a monetary ceiling. Choose conservative round limits and per-node timeouts.
- Review real agent permissions and commands as for a normal workflow. Each new round can perform those actions again.

The original design and implementation rationale are in [the plan](loops-plan.md).
