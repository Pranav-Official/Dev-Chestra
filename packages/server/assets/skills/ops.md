# DevChestra skill: ops

Use when: ops — workspace safety, limits, authoring checklist, CLI lifecycle, recovery.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

## 10. Run-level workspace and project file safety

- **The workflow does not choose where it runs.** The person starting a run picks one workspace for the whole run: the **project root** (the default; their live files, including uncommitted and untracked ones), an **existing Git worktree**, or a **new per-run worktree** (a clean checkout at the project's committed `HEAD`). Every agent and shell step in the run uses that same directory. Do not add per-node `workspace` fields; they are ignored on fresh runs (and, inside loops, only `scratch` is accepted).
- In the default project-root mode, an agent with `write: ["workspace"]` and every shell step **edit the real project directly**. DevChestra does not copy, commit, roll back, snapshot or sandbox anything. If a workflow modifies files, say so in your summary and suggest the user start it in a new worktree while it is being tried.
- `permissions` are tool-level limits on agents, not an OS sandbox; shell nodes are unrestricted ordinary processes. A step can reach any path the user's account can.
- Keep file operations inside the workspace. Use relative paths. Do not reference `~`, absolute paths outside the project, or other users' files.
- Destructive or outward-facing commands (`rm -rf`, `git reset --hard`, `git clean`, `git push --force`, package publishing, deployments, database migrations, sending messages) need an `approval` node with `irreversible: true` immediately before them. Prefer read-only agents (`write: []`).
- Never place secrets in params, prompts, outputs, shell commands or this file. Node `env` passthrough is not supported, and secrets found in outputs are rejected.
- Do not edit or delete files outside `.devchestra/workflows/` while authoring a workflow, except where the user asked for it.

## 12. Limits: do not confuse these

| Limit | Applies to | Failure |
| --- | --- | --- |
| 1 MiB | the workflow file; also the final text sent to an agent CLI (prompt + automatic input block), measured in UTF-8 bytes. Oversize input fails before the CLI starts with `E_VALIDATION`; nothing is truncated silently. | `E_WORKFLOW_INVALID` / `E_VALIDATION` |
| 16 KiB of JSON each | a loop's `loop.state`, `initialState`/`nextState` values, and a round's mapped `result` | `E_OUTPUT_INVALID` |
| 8 MiB total / 64 KiB per item | a foreach CSV source snapshot (all rows) / one source item or per-item result | `E_VALIDATION` |
| by reference, no 16 KiB cap | `loop.parent`: the outer scope is **captured as references to already-stored outputs**, not copied into the loop's state. Captured literals are capped at 16 KiB each and the capture manifest at 1 MiB. Large parent data is fine; large *state or results* are not. | |
| 4 KiB / 250 ms / 64 KiB | an expression's source / one evaluation (2 s total for a gate) / its result | `E_EXPR` |
| 64 KiB each | a shell step's retained `stdout` and `stderr` tails | silent tail truncation |
| 64 KiB | a `decision` node's rendered `state` | provider error |
| 4096 characters | an `approval` message (after rendering) | `E_VALIDATION` |
| 64 KiB, 200 properties, depth 8 | a normalized output schema | validation error |
| 1000 | loop `maxIterations`, foreach `maxItems`; gates allow at most 32 branches | validation error |
| 8 / 32 | child-workflow freeze depth / total bundle | validation error |

The 16 KiB loop limits are about *what a loop carries between rounds*; the 1 MiB figure is about *prompt size*; the context-capture figures are about *parent data*. They are independent. Keep loop state to short strings and numbers, store large artifacts as files and pass paths.

## 13. Not supported (do not use)

Workflow `budget` and `supervisor`; node `supervise` other than `default`; node `env`; non-empty `cliOptions`; agent `context` other than `none`; per-node `workspace` (ignored) and `permissions.write: ["project"]`; `promptFile` for managed runs; `format: "devchestra-artifact"` outputs; raw `{{{ }}}` templates; shell heredocs, comments and placeholders inside quotes or substitutions; nested loop/foreach controllers, back edges, zero-round loops and parallel rounds; custom node types; `fake` CLI; MCP server definitions (only selection by name). Maps, spending budgets and artifact capture are not built yet. Child `workflow` failure uses `.failed` only (no `.cancelled`).

## 14. Authoring procedure

1. Read the user's request. If the goal, inputs, what may be changed, or a stopping condition is unclear and a wrong guess would be costly, ask one short question; otherwise choose sensible defaults and state them.
2. Look at existing files in `.devchestra/workflows/` and match their conventions. Do not overwrite another workflow.
3. Choose the id, then sketch the graph: one start, the nodes, the edges, the ends. Prefer the smallest graph that does the job (an agent for judgement, a shell step for deterministic commands, a gate for branching on facts, a loop only when repetition is truly needed).
4. Write `.devchestra/workflows/<id>.json` with the structure above, `ui` coordinates, least-privilege permissions, and tight output schemas.
5. Validate with `devchestra workflow validate --project <project> --file <file>`, then create or update it using the CLI lifecycle below.
6. Tell the user what the workflow does, its parameters and permissions. Run it only when the user asked for execution.

### Pre-flight checklist

- [ ] `schemaVersion` is `1`; `id` matches `^[a-z0-9-]{1,64}$` and the file name; `name` is non-empty.
- [ ] No unknown keys; no `budget`, `supervisor`, `env`, `cliOptions`, `context`, per-node `workspace`, `promptFile`.
- [ ] One `start`, at least one `end`, every node reachable and able to reach an end, no cycles.
- [ ] Node ids match `^[a-z][a-z0-9_]{0,47}$` and are unique; edge ids are unique.
- [ ] Every non-join node has at most one inbound edge; every `end` has at most one; joins have exactly one edge per declared input, addressed as `join.input`.
- [ ] Gate/decision/approval/loop edges use handles; every gate has exactly one trailing `otherwise`; every decision's `uncertain` is wired.
- [ ] Every expression/template only references `start` and ancestors (or `loop`/`result` where listed); templates use `{{ }}`, bare-expression fields do not.
- [ ] Gate `when`, loop `until` always return a boolean, even when values are missing.
- [ ] Every agent has a `tier` (or, only if the user asked for one provider, a `cli`), an inline `prompt`, an `output` schema in the restricted profile (arrays have `maxItems`), and `permissions`.
- [ ] Shell placeholders are outside quotes; no heredocs; destructive commands sit behind an approval.
- [ ] Loops: `maxIterations` set, body has one start (no params) and one success end, `result` and `until` are evidence-based, `.exhausted` is wired to a failed end, state/result stay small.
- [ ] Foreach: `source` set (expression over outer scope, or relative csv template), `maxItems`/`onItemFailure` defaulted, body has one start (no params) and one success end, `result` over end ancestors plus `foreach`, per-item `output` set.
- [ ] Child workflows: `workflowId` matches managed id rules, `inputs` are bare expressions over call-site ancestors, plain edge = success and `.failed` wired for failures, no live runs during authoring.
- [ ] Every node has `ui` coordinates.
- [ ] The JSON is valid (no comments or trailing commas) and under 1 MiB.


## CLI lifecycle

Start a local API server with `devchestra start --headless` in a persistent process. Register with `devchestra project add <path>` (a new project is seeded with the `project-tour` and `fix-until-green` starter workflows; pass `--no-starters` to skip, and do not recreate them), then use `devchestra workflow validate --project <path> --file <file>` and `devchestra workflow create --project <path> --file <file>`. `--file -` reads stdin. For edits, use `workflow show` to obtain the ETag and pass it to `workflow update <id> --if-match <etag>`.

Run a saved workflow with `devchestra run start <id> --project <path> --idempotency-key <unique-key>`, retain its run ID, then use `devchestra run watch <run-id> --jsonl`. The server owns the run, so disconnecting the watcher does not cancel it. On a lost start response, reuse the same key and revision; if the workflow was edited meanwhile, the server may return a revision conflict, so inspect the run list before another start. Reconnect using `--after <event-id>`. Inspect with `run show`, `run events`, `run execution --path <path>`, `run transcript --path <path>`, and `run output`. `run cancel` and `run resume` act on existing runs. A workflow edit does not alter an existing run's frozen snapshot; start a new run for the updated workflow.

To monitor a long run without spending context, use `run status <run-id>` (the same as `run show <run-id> --compact`) for one small JSON answer: run status and cost, node counts, the executions that are running, failed or waiting (with attempt and last error), loop `iteration`, `maxIterations` and `state`, foreach `processed`, `failed` and `total`, `activity` for running agents (`idleSec` since the transcript was last written, and `lastTool`), and `needsAttention` for approvals and pauses. Then block with `run wait <run-id> --timeout <seconds> [--until any|node-done|status|approval] [--after <cursor>]` instead of sleeping or re-polling. It returns that same status, plus `timedOut` and `reasons`, when a node finishes or fails, a loop round or foreach item completes, an approval is requested, or the run ends or pauses. Pass the returned `cursor` as `--after` on the next call so nothing between calls is missed and a still-pending approval does not end the wait at once. Exit codes: 0 succeeded, 1 failed, 2 rejected, 3 cancelled, 5 paused or awaiting approval, 10 still running (check `timedOut`). For a running agent, `run transcript <run-id> --path <path> --tail 20` returns its latest lines; continue with `--cursor <endCursor>` to read only new ones.

For human review, use `approval list --run <run-id>` and `approval show <run-id> --path <path>`, present the request to the user, and resolve only with their authorized decision. Pass the returned request ID, attempt, and generation to `approval resolve` with `--request-id`, `--expected-attempt`, `--expected-generation`, and `--decision approve|reject`. Never infer approval. For uncertain shell side effects, inspect the effects and require explicit authorization before retrying.

Agent commands print JSON, and watch prints JSONL. Use `devchestra project --help` for the command overview. Usage data is only as complete as the providers report; do not infer that missing cost information means a run is free.

Polling and webhook triggers are declared in the workflow file (`devchestra skill triggers`) but armed, refreshed, rotated, and probed in the browser Trigger controls / API. The agent CLI has no trigger commands; do not invent `polling`/`webhook` CLI subcommands.

## Discovery, tests, and uncertain-shell recovery

`devchestra capabilities --json` enumerates commands and flags. `devchestra workflow schema --json` returns the structural schema; `workflow validate` remains authoritative for graph, expression and project rules. Agent command JSON and JSONL messages carry `contractVersion: 1`; structured errors are on stderr. `workflow groups show` and `workflow groups update` manage group metadata with an ETag. `gate test --project <project> --file <json>` previews routing without a run. `decision test` makes a live provider call and may cost money; use it only when authorized. `run foreach <run-id> --source <node-id>` lists item references.

When a run has an uncertain shell side effect, inspect `run show` and the interrupted execution, assess external effects and obtain the user's explicit authorization. Then submit `run resume <run-id> --retry-uncertain-shell --path <execution-path> --expected-attempt <attempt> --expected-generation <generation> --expected-event-id <watermark>`. Use values from the same run snapshot; do not reuse a stale acknowledgement. If several shells are interrupted, the server refuses this retry until a safe targeted recovery is supported. A watch disconnect or timeout is not a run failure: inspect the run and reconnect with its last emitted event ID. Per-execution usage is for the current attempt and missing cost reports do not mean zero cost.
