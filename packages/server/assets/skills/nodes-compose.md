# DevChestra skill: nodes-compose

Use when: nodes-compose — loop/foreach/workflow calls.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

### 7.8 `loop`

See section 11. A loop is a single node in the parent graph that runs an inner acyclic graph repeatedly. Loop bodies may contain `workflow` calls but no `foreach`.

### 7.9 `foreach`

A `foreach` fans out over an array (or a workspace CSV) and runs its body once per item. Direct loop/foreach nesting is disallowed v1; invoke a separate workflow with a loop when you need both.

| Field | Meaning |
| --- | --- |
| `source` | `{ "kind": "expression", "expression": "<bare JSONata over outer scope>" }` or `{ "kind": "csv", "path": "<template relative to workspace>" }`. |
| `maxItems` | optional 1..1000, defaults to 1000. |
| `onItemFailure` | optional `"stop"` (default) or `"continue"`. |
| `body` | graph with exactly one `start` (empty `params`), exactly one `end` with `status: "success"`, ordinary nodes including `workflow` calls, no loop/foreach children. Body ids `foreach` and `result` are reserved. |
| `result` | required bare per-item result expression over the body's end ancestors plus `foreach`. |
| `output` | required per-item JSON Schema (section 8). |

Body data refs use `foreach.parent.start.<name>` / `foreach.parent.<nodeId>` (never bare parent ids in bodies). Item scope: `foreach.item`, `foreach.index` (zero-based), `foreach.number` (one-based), `foreach.total`, `foreach.parent`. The parent sees `{ "total", "processed", "succeeded", "failed", "rejected", "resultsRef" }` under the node id; per-item rows stay in the run store (paginated refs, never hydrated arrays). Empty sources finish natively with `total: 0`.

### 7.10 `workflow` (child-workflow call)

| Field | Meaning |
| --- | --- |
| `workflowId` | same managed-workflow id rules (`^[a-z0-9-]{1,64}$`). |
| `inputs` | object mapping each target param name to a bare JSONata expression in the caller's scope. Keys validate against target params only when the target definition resolves. |
| `output` | optional JSON Schema for the child's successful result (raw fallback is unknown; typed output exposes `result` properties). |

Envelope under the node id: `{ "childRunId", "status": "succeeded" \| "failed" \| "rejected", "result" }`. Plain edge = child succeeded; wire `nodeId.failed` for child failed/rejected. No `.cancelled` handle. Child definitions freeze recursively before side effects (depth <= 8, total <= 32, same project, cycle-checked); missing children fail explicitly.

### 7.10.1 Practical pattern: one complete retry workflow per CSV row

Use **For each + Run workflow**, not a flattened retry state machine. The child workflow may contain its own five-round loop. The parent waits for that entire child to finish before advancing to the next row. Do not copy the child's nodes into the foreach body and do not add unsupported direct nested controllers.

Before using the following example, create a same-project workflow named `single-job-resume` whose Start parameters are `job_description` (string), `candidate_background` (optional string), and `output_directory` (string). Its agents must honor the output-directory input consistently. A CSV named `jobs.csv` needs a `job_description` header; quoted multiline descriptions are supported. Each row is an object whose values are strings. Use `$number(...)` explicitly when mapping a CSV value to a numeric child parameter.

```json
{
  "schemaVersion": 1,
  "id": "batch-job-resumes",
  "name": "Generate a resume for every job",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Batch inputs",
        "params": [
          { "name": "csv_path", "type": "string", "required": false, "default": "jobs.csv" },
          { "name": "batch_id", "type": "string", "required": true },
          { "name": "candidate_background", "type": "string", "required": false, "default": "" }
        ],
        "ui": { "x": 40, "y": 160 }
      },
      {
        "id": "jobs",
        "type": "foreach",
        "name": "One whole workflow per job",
        "source": { "kind": "csv", "path": "{{ start.csv_path }}" },
        "maxItems": 1000,
        "onItemFailure": "continue",
        "result": "call.result",
        "output": { "type": "object", "additionalProperties": true },
        "body": {
          "nodes": [
            { "id": "start", "type": "start", "name": "Start job", "params": [], "ui": { "x": 40, "y": 120 } },
            {
              "id": "call",
              "type": "workflow",
              "name": "Generate and review this job's resume",
              "workflowId": "single-job-resume",
              "inputs": {
                "job_description": "foreach.item.job_description",
                "candidate_background": "foreach.parent.start.candidate_background",
                "output_directory": "'resumes/' & foreach.parent.start.batch_id & '/job-' & $string(foreach.number)"
              },
              "ui": { "x": 320, "y": 120 }
            },
            { "id": "done", "type": "end", "name": "Job completed", "status": "success", "result": "{}", "ui": { "x": 620, "y": 120 } }
          ],
          "edges": [
            { "id": "b1", "from": "start", "to": "call" },
            { "id": "b2", "from": "call", "to": "done" }
          ]
        },
        "ui": { "x": 340, "y": 160 }
      },
      {
        "id": "done",
        "type": "end",
        "name": "Batch processing finished",
        "status": "success",
        "result": "jobs",
        "ui": { "x": 660, "y": 160 }
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "jobs" },
      { "id": "e2", "from": "jobs", "to": "done" }
    ]
  }
}
```

Operational rules:

- `batch_id` should be a new safe identifier for each batch (letters, digits, hyphens/underscores, no path separators or `..`). Child file operations must enforce workspace containment; a mapped path is not a sandbox. A company name alone is not unique across job postings. The engine does **not** automatically assign artifact directories.
- This parent deliberately finishes successfully when collection processing completes, even if individual jobs failed. Check `jobs.failed` and `jobs.rejected`, or add a Gate before End if any unsuccessful item should make the overall batch fail.
- For `onItemFailure: "continue"`, leave `call.failed` unconnected when a failed/rejected child should count as an unsuccessful item. For-each records the item failure and moves on. If you wire `call.failed` to a recovery path ending successfully, that is a handled failure and the successful body counts as succeeded; classify business outcomes explicitly in the mapped result if needed.
- A child returning `{"pass": false}` from a successful End is still an execution success. Make the child take a failed End on exhausted review if you want batch failure counts to reflect unapproved resumes. Cancellation is never treated as an item failure to continue past.
- `result` maps each successful item's result. `output` validates that per-item result, **not** the batch summary envelope. Failed items retain error results. `resultsRef` is an opaque durable collection reference, not a file path or a JSON array; inspect item pages/results in the run UI or through the documented API.
- Empty collections finish with zero processed items. More rows than `maxItems` cause an explicit failure; no rows are silently dropped. Source snapshots are capped at 8 MiB, each item/result at 64 KiB; array expressions also inherit the expression evaluator's 64 KiB result cap, so use CSV for larger collections.
- Item input data is frozen once when For-each begins. Child definitions are frozen before the parent run starts; editing either during a run does not change already-captured work. Resume reuses exact child IDs and completed items; it does not duplicate a finished job. External side effects are still not guaranteed exactly-once.
- An approval or paused child must be resolved in its child run; inspect it using the parent's child-run link. Cancelling the batch cancels active descendants and prevents later items from starting.

## 11. Repeat-until loops

A `loop` node runs its **body** (an inner graph) at least once, evaluates `until`, and either finishes or starts another round. Rounds are sequential and bounded. The parent graph waits for the loop. Both graphs stay acyclic.

```json fragment
{
  "id": "refine",
  "type": "loop",
  "name": "Refine until green",
  "ui": { "x": 340, "y": 160 },
  "mode": "repeatUntil",
  "maxIterations": 5,
  "initialState": "{\"feedback\": \"\"}",
  "result": "{\"passed\": review.passed, \"feedback\": review.feedback}",
  "until": "result.passed = true",
  "nextState": "{\"feedback\": result.feedback}",
  "output": { "type": "object", "properties": { "passed": { "type": "boolean" }, "feedback": { "type": "string" } }, "required": ["passed", "feedback"], "additionalProperties": false },
  "body": { "nodes": [], "edges": [] }
}
```

| Field | Meaning |
| --- | --- |
| `mode` | exactly `"repeatUntil"` |
| `maxIterations` | required integer 1-1000. This is the only bound on cost; keep it small and set per-node `timeoutMin` limits. |
| `initialState` | optional bare expression, evaluated **once in the parent scope** (`start` and the loop's ancestors). Must return an **object**. Defaults to `{}`. |
| `body` | graph with exactly one `start` (with **empty** `params`), exactly one `end` whose `status` is `success`, no nested loops, and ordinary nodes/edges. Body node ids `loop` and `result` are reserved. Converge alternative paths with a `join`. |
| `result` | required bare expression building **this round's result**. It sees `start`, `loop` and the **ancestors of the body's `end`** (by their ids). It does **not** see the end's own output (use `"result": "{}"` in the body's end). |
| `output` | required JSON Schema (section 8) the round's `result` must satisfy. A mismatch fails the loop. |
| `until` | required bare expression returning a **boolean**; `true` finishes the loop. Sees everything `result` sees, plus `result` (this round's mapped result). |
| `nextState` | optional bare expression returning the **next round's state object**; same scope as `until`. Defaults to `loop.state` (state unchanged). Not evaluated on a terminal round. |

### Scopes inside a loop

| Where | Roots available |
| --- | --- |
| Body node templates and expressions | `start` (the body start; it is `{}`), `loop`, and the node's **body ancestors** |
| `loop.iteration` | current round, starting at **1** |
| `loop.maxIterations` | the configured limit |
| `loop.state` | the state object carried from the previous round (the `initialState` value in round 1) |
| `loop.parent` | a snapshot of the parent scope taken when the loop started. Run parameters are at `loop.parent.start.<name>`, and parent ancestors of the loop at `loop.parent.<nodeId>` |

Notes: the body's `start` has **no** parameters, so read run inputs through `loop.parent.start.<name>`. In `initialState`, read `start.<name>` directly (it runs in the parent scope).

### What the parent sees after the loop

The loop's output under its node id is the envelope:

```json fragment
{ "result": { "passed": true, "feedback": "" }, "iterations": 3, "outcome": "condition_met" }
```

`result` is the **last round's** mapped result. Read it as `refine.result.passed`, `refine.iterations`, `refine.outcome`.

### Success versus exhausted

A loop has two outputs:

| Edge `from` | Taken when | `outcome` |
| --- | --- | --- |
| `refine` (plain) | `until` was true on some round up to `maxIterations`, including the last | `condition_met` |
| `refine.exhausted` | `until` was still false after round `maxIterations` | `iteration_limit` |

Exactly one is taken and the other is skipped. **Wire `refine.exhausted` explicitly** and route it to an end with `status: "failed"` (or to an approval) so a spent budget is reported honestly. If `refine.exhausted` is not wired, an unmet condition after the last round **fails the run with `E_LOOP_LIMIT`**. Any other handle name on a loop is invalid. Real errors (expression errors, an output that fails the schema, a failing body node) always fail the run, even when `.exhausted` is wired; they never start another round and are not "exhausted".

### Errors, tests and truthful loops

- A shell step that exits non-zero fails the run, not just the round. When the loop's whole point is to iterate until a test passes, set `allowFailure: true` on the test step and put its `exitCode` in `result`.
- Make `until` depend on **evidence**, not on an agent's say-so alone: for example `result.passed = true and result.testExit = 0`. Let a reviewer agent explain, but base the stop condition on the exit code.
- Use `=` against `true` (`result.passed = true`), not a bare `result.passed`; a missing field in a bare form is not a boolean and fails the loop.
- Agent sessions start fresh each round. Carry what the next round needs in `nextState` (short feedback strings, a path), not whole transcripts or files.
- All rounds share the run workspace, so edits from earlier rounds are still there. Per-round history, outputs and transcripts are kept separately (`refine#1/...`, `refine#2/...`).
- External side effects are not made exactly-once by DevChestra. Put an `approval` in the body before any irreversible action, since each round can repeat it.
- A loop cannot be nested inside a loop; no zero-round (while) loops, no `break`.

### A complete five-round loop

Implement, test, review; stop when the tests pass and the reviewer agrees, with at most five rounds. The exhausted path ends the run as failed with the reviewer's last feedback:

```json
{
  "schemaVersion": 1,
  "id": "build-until-green",
  "name": "Build until green",
  "description": "Implement a goal, run the tests, review, and repeat for at most five rounds.",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Start",
        "ui": { "x": 60, "y": 200 },
        "params": [{ "name": "goal", "type": "string", "required": true }]
      },
      {
        "id": "refine",
        "type": "loop",
        "name": "Implement, test, review",
        "ui": { "x": 340, "y": 200 },
        "mode": "repeatUntil",
        "maxIterations": 5,
        "initialState": "{\"feedback\": \"\"}",
        "result": "{\"passed\": review.passed, \"feedback\": review.feedback, \"testExit\": test.exitCode, \"summary\": implement.summary}",
        "until": "result.passed = true and result.testExit = 0",
        "nextState": "{\"feedback\": result.feedback}",
        "output": {
          "type": "object",
          "properties": {
            "passed": { "type": "boolean" },
            "feedback": { "type": "string" },
            "testExit": { "type": "integer" },
            "summary": { "type": "string" }
          },
          "required": ["passed", "feedback", "testExit", "summary"],
          "additionalProperties": false
        },
        "body": {
          "nodes": [
            {
              "id": "start",
              "type": "start",
              "name": "Start round",
              "ui": { "x": 40, "y": 120 },
              "params": []
            },
            {
              "id": "implement",
              "type": "agent",
              "name": "Implement or fix",
              "ui": { "x": 300, "y": 120 },
              "cli": "claude-code",
              "prompt": "Goal: {{ loop.parent.start.goal }}\nThis is round {{ loop.iteration }} of {{ loop.maxIterations }}.\nFeedback from the previous round (empty in round 1): {{ loop.state.feedback }}\nMake the smallest change that moves the project toward the goal, editing files in the workspace. Do not run the full test suite; a later step does that.",
              "output": {
                "type": "object",
                "properties": { "summary": { "type": "string", "description": "what you changed and why" } },
                "required": ["summary"],
                "additionalProperties": false
              },
              "permissions": { "network": false, "write": ["workspace"] },
              "limits": { "timeoutMin": 30 }
            },
            {
              "id": "test",
              "type": "shell",
              "name": "Run tests",
              "ui": { "x": 560, "y": 120 },
              "command": "npm test --silent",
              "timeoutMin": 15,
              "allowFailure": true
            },
            {
              "id": "review",
              "type": "agent",
              "name": "Review",
              "ui": { "x": 820, "y": 120 },
              "cli": "claude-code",
              "prompt": "Goal: {{ loop.parent.start.goal }}\nChange summary: {{ implement.summary }}\nThe test command exited with code {{ test.exitCode }}. Output tail:\n{{ test.stdout }}\nSet passed to true only if the exit code is 0 and the goal is actually met. Otherwise give concrete feedback for the next round. Do not change files.",
              "output": {
                "type": "object",
                "properties": {
                  "passed": { "type": "boolean" },
                  "feedback": { "type": "string", "description": "empty when passed; otherwise what to fix next" }
                },
                "required": ["passed", "feedback"],
                "additionalProperties": false
              },
              "permissions": { "network": false, "write": [] }
            },
            {
              "id": "round_done",
              "type": "end",
              "name": "Finish round",
              "ui": { "x": 1080, "y": 120 },
              "status": "success",
              "result": "{}"
            }
          ],
          "edges": [
            { "id": "b1", "from": "start", "to": "implement" },
            { "id": "b2", "from": "implement", "to": "test" },
            { "id": "b3", "from": "test", "to": "review" },
            { "id": "b4", "from": "review", "to": "round_done" }
          ]
        }
      },
      {
        "id": "done",
        "type": "end",
        "name": "Succeeded",
        "ui": { "x": 640, "y": 80 },
        "status": "success",
        "result": "{\"outcome\": refine.outcome, \"iterations\": refine.iterations, \"summary\": refine.result.summary}"
      },
      {
        "id": "spent",
        "type": "end",
        "name": "Out of rounds",
        "ui": { "x": 640, "y": 320 },
        "status": "failed",
        "result": "{\"outcome\": refine.outcome, \"iterations\": refine.iterations, \"lastFeedback\": refine.result.feedback}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "refine" },
      { "id": "e2", "from": "refine", "to": "done" },
      { "id": "e3", "from": "refine.exhausted", "to": "spent" }
    ]
  }
}
```

