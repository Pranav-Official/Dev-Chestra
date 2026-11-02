# DevChestra workflow authoring guide

This guide is printed by `devchestra skill` and describes the installed version. It is for agents creating, running, and monitoring DevChestra workflows. Project-specific conventions belong in the project’s own agent instructions.

Rules in this guide were checked against the DevChestra schema, validator and engine at the time it was written. If a validator message disagrees with this text, the validator wins; fix the workflow and tell the user about the discrepancy.

## 1. Scope and hard rules

- A workflow is **one JSON file**: `.devchestra/workflows/<id>.json`, where `<id>` equals the `id` field inside the file.
- Do **not** run the workflow unless the user explicitly asked you to run it. Real agent nodes use the user's signed-in CLI accounts, can cost money, and can edit project files.
- Do not invent CLI subcommands, flags, node fields or node types. Use the CLI commands documented in sections 14 and CLI lifecycle.
- Unknown keys are rejected everywhere (the parser is strict). Nodes have **no** `description` field; only the workflow itself does.
- JSON only: no comments, no trailing commas. Use 2-space indentation and end the file with a newline.
- The file must be at most 1 MiB.

## 2. File, ids and naming

| Thing | Rule |
| --- | --- |
| Workflow file | `.devchestra/workflows/<id>.json` |
| Workflow `id` | `^[a-z0-9-]{1,64}$` (lowercase letters, digits, hyphen) and must equal the file name without `.json` |
| Workflow `name` | non-empty, at most 200 characters |
| `schemaVersion` | exactly `1` |
| Node `id` | `^[a-z][a-z0-9_]{0,47}$` (starts with a letter; letters, digits, underscore; **no hyphens**). Node ids are names in expressions, so avoid JSONata words such as `and`, `or`, `in`, `true`, `false`, `null`. |
| Node `name` | non-empty, at most 200 characters (shown in the UI) |
| Reserved node ids | `start` is reserved for the start node. Inside a loop body, `loop` and `result` are also reserved; inside a foreach body, `foreach` and `result` are also reserved. Node ids must be unique within their graph. |
| Edge `id` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, unique |
| Handle names (gate branch ids, join input names, decision branch/band ids) | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| Start parameter `name` | `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (no hyphens) |

Choose a short, descriptive, hyphenated workflow id (`fix-lint-errors`, `release-notes`). If the user asked for a name, derive the id from it. Do not reuse an existing file's id unless you were asked to edit that workflow.

Add `"ui": { "x": <number>, "y": <number> }` to every node (including loop body nodes). It is editor layout only, and without it the editor stacks all nodes at the origin. Lay nodes out left to right about 260 px apart and about 140 px apart vertically for parallel branches. Edges need no `ui`.

## 3. Top-level shape

```json fragment
{
  "schemaVersion": 1,
  "id": "my-workflow",
  "name": "My workflow",
  "description": "Optional one-line description.",
  "graph": { "nodes": [], "edges": [] }
}
```

`budget` and `supervisor` are **not supported** (they are rejected if present). Do not add them.

## 4. A complete minimal runnable workflow

Start with one input, one agent, one end. This validates and is runnable as written:

```json
{
  "schemaVersion": 1,
  "id": "summarize-topic",
  "name": "Summarize a topic",
  "description": "Ask one agent for a short summary of a topic.",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Start",
        "ui": { "x": 80, "y": 160 },
        "params": [{ "name": "topic", "type": "string", "required": true }]
      },
      {
        "id": "summarize",
        "type": "agent",
        "name": "Summarize",
        "ui": { "x": 340, "y": 160 },
        "cli": "claude-code",
        "prompt": "Write a three-sentence summary of: {{ start.topic }}",
        "output": {
          "type": "object",
          "properties": { "summary": { "type": "string" } },
          "required": ["summary"],
          "additionalProperties": false
        },
        "permissions": { "network": false, "write": [] }
      },
      {
        "id": "end",
        "type": "end",
        "name": "End",
        "ui": { "x": 600, "y": 160 },
        "status": "success",
        "result": "{\"summary\": summarize.summary}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "summarize" },
      { "id": "e2", "from": "summarize", "to": "end" }
    ]
  }
}
```

## 5. Graph rules (apply to the top level and to loop bodies)

- Exactly **one `start`** node and **at least one `end`** node.
- Every node must be reachable from `start` and must be able to reach an `end`.
- The graph must be **acyclic**. There are no back edges; repetition is done with a `loop` node (section 11).
- Edge `from`/`to` are node ids, optionally with one `.handle` (see the table below). Nothing else (no `$`-prefixed or multi-dot endpoints).
- `start` has no inbound edges. `end` has no outbound edges and **at most one inbound edge**.
- Every node other than `join` has **at most one inbound edge**. To merge paths, use a `join` (section 9). A node that receives a gate/decision/approval/loop handle edge must have that edge as its only inbound edge.
- A node may have several outbound edges.
- A node with no active inbound edge at run time is **skipped** (recursively), and a skipped node's value reads as `null`. If more than one `end` ends up active in one run, the run fails with `E_WORKFLOW_INVALID`, so give mutually exclusive branches their own ends and make sure parallel paths converge with a `join` before a single end.

Edge endpoints with handles:

| Source node | `from` form | Meaning |
| --- | --- | --- |
| `start`, `agent`, `shell`, `join`, `foreach` | `nodeId` | plain output |
| `gate` | `gateId.branchId` (required) | the named branch; a plain `gateId` source is invalid |
| `decision` | `decisionId.handle` (required) | `true` / `false` (boolean mode) or your branch/band id, plus `uncertain` in every mode |
| `approval` | `approvalId` or `approvalId.rejected` | approved path / rejected path |
| `loop` | `loopId` or `loopId.exhausted` | condition met / iteration budget exhausted |
| `workflow` | `callId` or `callId.failed` | child succeeded / child failed or was rejected; an unwired failure fails the invocation |

| Target node | `to` form | Meaning |
| --- | --- | --- |
| any node except `join` and `start` | `nodeId` | the node's single input |
| `join` | `joinId.inputName` (required) | one declared input; each input has exactly one inbound edge |

```json fragment
[
  { "id": "to-gate", "from": "check", "to": "route" },
  { "id": "gate-clean", "from": "route.clean", "to": "note" },
  { "id": "approve-no", "from": "confirm.rejected", "to": "declined" },
  { "id": "into-join", "from": "note", "to": "merge.passed" },
  { "id": "loop-spent", "from": "refine.exhausted", "to": "spent" }
]
```

## 6. Data flow: params, outputs and references

A node's output is stored under its **node id**; run parameters are under `start`.

| Node | Output other nodes can read |
| --- | --- |
| `start` | the run parameters, e.g. `start.topic` |
| `agent` | the validated object the agent submitted (matches its `output` schema) |
| `shell` | `{ "exitCode", "signal", "stdout", "stderr", "durationMs" }` (stdout/stderr are the last 64 KiB each) |
| `gate` | `{ "branch": "<id of the taken branch>" }` |
| `join` | mode `first`: the active input's value. Mode `all`: an object keyed by input name, with `null` for inputs that did not run |
| `approval` | `{ "decision": "approve" \| "reject", "by": ..., "note"?: ..., "requestId": ... }` |
| `decision` | the provider answer object, including `value`, `kind` and `confidence` (an unknown confidence reads as `0`) |
| `loop` | the envelope `{ "result": ..., "iterations": N, "outcome": "condition_met" \| "iteration_limit" }` |
| `foreach` | `{ "total", "processed", "succeeded", "failed", "rejected", "resultsRef" }`; item values are stored separately, not returned as an array |
| `workflow` | `{ "childRunId", "status", "result" }`; `result` is the child's successful End result, or `null` on failure/rejection |
| `end` | the run result (read by a parent `workflow` call when invoked as a child) |

### Two syntaxes: templates versus bare expressions

DevChestra uses [JSONata](https://jsonata.org) expressions in two forms:

| Form | Used in | Example |
| --- | --- | --- |
| **Template**: free text with `{{ expression }}` placeholders | agent `prompt`, shell `command`, approval `message`, decision `state`, foreach CSV `source.path` | `"Summarize {{ start.topic }} for {{ start.audience }}"` |
| **Bare expression**: the whole field is one expression | gate branch `when`, end `result`, loop `initialState`, `nextState`, `result`, `until`, foreach array `source.expression` and `result`, each workflow `inputs` value | `"check.exitCode = 0"` |

- Do **not** put `{{ }}` in a bare-expression field, and do not omit it in a template field.
- Write a literal `{{` in a template as `\{{`. The raw form `{{{ ... }}}` is rejected.
- A template placeholder that resolves to `null`/missing inserts an empty string (the run records a warning). Strings are inserted as-is; objects and arrays are inserted as canonical JSON.
- `end.result` must evaluate to something JSON-representable; to return an object, write a JSONata object constructor as a string: `"{\"summary\": summarize.summary}"`.
- Expression limits: source at most 4 KiB, each evaluation at most 250 ms (gates: 2 s overall), result at most 64 KiB.
- Only deterministic built-ins are allowed: `$abs $append $assert $average $base64decode $base64encode $boolean $ceil $clone $contains $count $decodeUrl $decodeUrlComponent $distinct $each $encodeUrl $encodeUrlComponent $error $exists $filter $floor $formatBase $formatInteger $formatNumber $join $keys $length $lookup $lowercase $map $match $max $merge $min $not $number $pad $parseInteger $power $reduce $replace $reverse $round $sift $single $sort $split $spread $sqrt $string $substring $substringAfter $substringBefore $sum $toMillis $trim $type $uppercase $zip`. Variable binding (`$x := ...`), lambdas (`function`), `~>`/dynamic calls, the transform operator, and `$now $millis $random $uuid $eval $env $shuffle $fromMillis` are rejected.

### What a node may reference (ancestors only)

An expression or template can use as roots only `start` and the **ancestors** of the node (nodes that have a directed path to it). Anything else is a validation error `E_EXPR_SCOPE`, even if that node exists elsewhere in the workflow. If a node needs another node's output, **wire the dependency with an edge** so it becomes an ancestor; do not try to read a sibling or downstream node.

At run time an ancestor that was skipped (an untaken gate branch), failed or was cancelled reads as `null`. An agent also automatically receives a labelled JSON block with the run parameters and every accepted ancestor output, so a plain prompt is enough to hand data to a connected agent; `{{ }}` references are optional but are the way to put one specific value in the right place.

The editor's variable picker lists values from the whole workflow for discovery, but it inserts only values that are in scope for that field. The validator is the same: discovery is global, access is ancestors-only.

### Missing values and conditions (JSONata semantics that bite)

These were checked against the real evaluator:

- `x.y = true`, `x.y = 0` and `x.y != 'a'` are all `false` when `x` is `null` or `y` is missing. Note that `!=` on a missing value is `false`, not `true`.
- `x.y > 3` and `x.y < 3` on a missing value are **undefined, not boolean**. A gate branch or a loop `until` returning a non-boolean **fails** (`E_EXPR`) and never falls through to `otherwise`. Guard comparisons: `$exists(x.y) and x.y > 3`.
- Join mode `all` stores `null` for inputs that did not run, so guard before reading: `$exists(merge.fast) and merge.fast.ok = true`.
- A missing field inside an object constructor drops the key: `{"a": x.y}` is `{}` when `x.y` is missing, which can then fail the required properties of a loop `output` schema.

### Large data: pass paths, not contents

Outputs are capped (see section 12) and every output is stored and scanned. For anything bulky (a diff, a log, a generated document), have the producing agent or shell step **write a file in the run workspace** and return its **path** in a result field; the consumer reads the file. Do not return file contents in `output`, and do not interpolate large `stdout` into prompts. DevChestra's own instruction to agents is: files produced for later steps must be referenced by path in the matching result field.

## 7. Node reference

### 7.1 `start`

```json fragment
{
  "id": "start",
  "type": "start",
  "name": "Start",
  "ui": { "x": 80, "y": 160 },
  "params": [
    { "name": "topic", "type": "string", "required": true },
    { "name": "depth", "type": "number", "required": false, "default": 2 },
    { "name": "dryRun", "type": "boolean", "required": false, "default": true },
    { "name": "audience", "type": "enum", "options": ["dev", "exec"], "default": "dev", "required": true }
  ]
}
```

- Exactly one per graph. `params` is required (use `[]` for none).
- Param `type`: `string`, `number`, `boolean` or `enum`. `required` is required. `default` must match the type (finite number for `number`; for `enum`, one of `options`). Only `enum` may have `options`; they must be non-empty, unique, non-empty strings.
- A run supplies a value for each parameter (CLI: `--param name=value`; the Run dialog in the browser). Unknown parameters are rejected, missing required ones without a default are rejected, defaults are applied.
- Read parameters as `start.<name>`. Never put secrets in parameters; values are stored and scanned for secrets.
- Timer and HTTP triggers are optional `start.polling` / `start.webhook` blocks (see section 7.12). When `polling` is declared, no param may be named `found` or `dedupeKey`.

### 7.2 `agent`

```json fragment
{
  "id": "review",
  "type": "agent",
  "name": "Review the change",
  "ui": { "x": 340, "y": 160 },
  "cli": "claude-code",
  "model": "optional-exact-model-id",
  "prompt": "Review {{ start.target }}. Report problems you can verify.",
  "output": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "problems": { "type": "array", "items": { "type": "string" }, "maxItems": 20 }
    },
    "required": ["ok", "problems"],
    "additionalProperties": false
  },
  "permissions": { "network": false, "write": [] },
  "limits": { "timeoutMin": 30, "validationRetries": 2, "crashRetries": 1 }
}
```

| Field | Rule |
| --- | --- |
| `cli` | one of `claude-code`, `codex`, `opencode`, `pi`. (`fake` is test-only and must not be used.) |
| `model` | optional. If set it is passed unchanged to the CLI; use an exact id from the CLI's model catalog (the editor's model picker lists them). Omit it to use the CLI's default. Never guess a model id. |
| `prompt` | required, inline text template. See "No `promptFile`" below. Warns if empty. |
| `output` | required JSON Schema for the result (section 8) |
| `permissions` | required: `network` (boolean), `write` (array), optional `shell` (boolean). See below. |
| `mcpServers` | optional list of `{ "name", "scope" }`. See below. |
| `limits` | optional: `timeoutMin` (integer 1-480, default 30), `validationRetries` (integer 0-10, default 2), `crashRetries` (integer 0-10, default 1). `maxQuotaWaitHours` is not supported. |

**No `promptFile` in managed workflows.** The schema accepts `promptFile`, but runs started from the editor/HTTP API reject it (`E_NOT_SUPPORTED`). Always write the prompt inline in `prompt`. Do not set both.

**Required result submission.** Every agent must finish by calling the MCP tool **`submit_result`** (provided by DevChestra's own `devchestra` MCP server, which is always attached) exactly once. Its parameters *are* the `output` schema, and invalid submissions are returned to the agent as errors so it can fix them (up to `validationRetries` times). A plain-text answer is not a result. You cannot turn this off: no permission, option or schema removes `submit_result`, and `permissions.shell: false` only removes the CLI's built-in shell tool. DevChestra appends the "how to finish" instruction itself; do not copy it into prompts, but do tell the agent *what* to report. The top-level `submit_result` argument must be a JSON object. Submitted outputs are scanned for secrets and rejected if one is found, so never ask an agent to echo environment variables, tokens or key files.

**Permissions (the only supported controls).**

| Field | Meaning |
| --- | --- |
| `network` | `true` lets the CLI use its web/network tools; `false` denies them (best effort and enforced differently per CLI, for example tool allow/deny lists or a sandbox network flag). Loopback access to DevChestra's own submit tool always works. |
| `write` | `[]` = read-only agent. `["workspace"]` = may write files in the **run workspace**. `["project"]` is **not supported** and is rejected. |
| `shell` | optional boolean for the CLI's built-in shell tool. When omitted, shell follows `write` (writable means shell allowed). Set `false` for a writable agent that must not run commands, or `true` to let a read-only agent run commands. |

These are tool-level controls on **agent** nodes, not an operating-system sandbox. **Shell nodes are ordinary processes and are not governed by `permissions`.** Least privilege: default to `{"network": false, "write": []}` and add only what the task needs.

**Unsupported (rejected by the validator):** non-empty `cliOptions` (you cannot pass CLI flags such as permission-bypass switches), non-empty `env`, `context` other than `{ "project": "none", "workflow": "none" }` (omit it), `supervise` other than `"default"`, per-node `workspace` (omit it; the workspace is chosen once per run), `limits.maxQuotaWaitHours`, and output format `devchestra-artifact`.

**MCP servers.** `mcpServers` is an optional list of **names only**: `{ "name": "<server name>", "scope": "global" | "project" | "connector" }`. At most 32 entries, no duplicates of the same `scope:name`, name 1-128 characters with no control characters, and the name `devchestra` is reserved. The workflow can only *select* servers the user already has configured for that CLI; it cannot define a server, command, URL, header or token. The editor discovers the selectable servers from the CLI's own configuration. If you cannot confirm that a server exists and which scope it is in, **leave `mcpServers` out** and tell the user which server to pick in the editor rather than guessing.

**Writing good prompts.** State the goal, the inputs (via `{{ }}`), the constraints, and exactly which fields to report. Say what "done" means. Tell the agent which files it may change. Do not ask it to "report back" in prose.

### 7.3 `shell`

```json fragment
{
  "id": "test",
  "type": "shell",
  "name": "Run tests",
  "ui": { "x": 600, "y": 160 },
  "command": "npm test --silent",
  "timeoutMin": 15,
  "allowFailure": true
}
```

- `command` is required and non-empty. It runs in the run workspace directory.
- `timeoutMin`: integer 1-480, default 10. `allowFailure`: default `false`.
- A non-zero exit code **fails the node and the run**, unless `allowFailure` is `true`. Use `allowFailure: true` when you want to *inspect* the exit code (for a gate or a loop `until`); otherwise leave it off so failures stop the run.
- Output is `{ exitCode, signal, stdout, stderr, durationMs }`; `stdout` and `stderr` keep only the last 64 KiB each. On a timeout or signal `exitCode` can be `null`.
- Substituted values are quoted POSIX-style, or PowerShell-style on Windows. Prefer portable commands, or say which platform you targeted.

**Safe interpolation.** Every `{{ }}` value substituted into a shell command is automatically **single-quoted** (POSIX) or PowerShell-quoted, so it arrives as exactly one literal argument. To keep that guarantee the validator rejects placeholders in unsupported contexts: inside single, double or backtick quotes, inside `$(...)` or `${...}`, directly after `$`, after a trailing backslash, inside a `#` comment, and any heredoc (`<<`). So:

```text
OK:      git log --oneline -n {{ start.count }}
OK:      grep -rn -- {{ start.pattern }} src
REJECTED: echo "{{ start.name }}"        (placeholder inside double quotes)
REJECTED: echo $({{ start.cmd }})        (placeholder inside a substitution)
```

Quoting prevents shell injection, not misuse: a quoted value that begins with `-` can still be read as an option by the program, so put `--` before untrusted values where the tool supports it. Never build a command that executes a substituted value (`sh -c {{ x }}`, `eval`, `xargs sh -c`), and never interpolate agent output or file contents into a command that deletes, publishes or pushes anything without an approval node (section 7.5) in front of it.

### 7.4 `gate`

```json fragment
{
  "id": "route",
  "type": "gate",
  "name": "Route on test result",
  "ui": { "x": 860, "y": 160 },
  "branches": [
    { "id": "clean", "when": "check.exitCode = 0" },
    { "id": "findings", "otherwise": true }
  ]
}
```

- Branches are evaluated **in order**; the first `when` that is `true` wins. Exactly one branch is `{ "otherwise": true }`, it must be **last**, and it has no `when`. 1-32 branches.
- Each `when` is a bare expression that must evaluate to a **boolean**; anything else fails the gate (see "Missing values").
- Connect with `route.<branchId>` edges. Untaken branches are skipped. The gate's own output is `{ "branch": "<id>" }`.

### 7.5 `approval`

```json fragment
{
  "id": "confirm",
  "type": "approval",
  "name": "Confirm the plan",
  "ui": { "x": 1120, "y": 160 },
  "message": "The agent proposes: {{ triage.plan }}\nApprove to continue.",
  "criteria": ["The plan changes only files under src/", "Nothing is deleted"],
  "irreversible": false
}
```

- Pauses the run until a person approves or rejects in the viewer.
- `message`: template, 1-4096 characters after rendering. `criteria`: optional, at most 32 strings of 1-256 characters. `irreversible`: required boolean; set `true` for anything that cannot be undone.
- Edges: `confirm` continues on approval; `confirm.rejected` continues on rejection. If `confirm.rejected` is **not** wired, a rejection ends the run as rejected. Auto-approve, timeouts and output editing are not supported.
- Put an approval (with `irreversible: true`) **before** deleting data, pushing, publishing, deploying or any other external side effect.

### 7.6 `decision`

Asks a fixed external model provider one question and routes on the answer. **Requires provider API keys** and sends the rendered `state` to that third-party service, so use it only if the user wants it, and never put secrets in `state`.

```json
{
  "schemaVersion": 1,
  "id": "triage-message",
  "name": "Triage a message",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Start",
        "ui": { "x": 80, "y": 160 },
        "params": [{ "name": "text", "type": "string", "required": true }]
      },
      {
        "id": "urgent",
        "type": "decision",
        "name": "Is it urgent?",
        "ui": { "x": 340, "y": 160 },
        "provider": "cloudflare-clef-flash",
        "state": "{{ start.text }}",
        "instructions": "Is this message urgent and does it need a person right now?",
        "mode": { "kind": "boolean", "trueAt": 0.7, "falseAt": 0.3 },
        "onError": "uncertain"
      },
      {
        "id": "page",
        "type": "end",
        "name": "Page someone",
        "ui": { "x": 640, "y": 40 },
        "status": "success",
        "result": "{\"route\": \"page\"}"
      },
      {
        "id": "queue",
        "type": "end",
        "name": "Queue it",
        "ui": { "x": 640, "y": 160 },
        "status": "success",
        "result": "{\"route\": \"queue\"}"
      },
      {
        "id": "human",
        "type": "end",
        "name": "Ask a person",
        "ui": { "x": 640, "y": 280 },
        "status": "success",
        "result": "{\"route\": \"human\"}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "urgent" },
      { "id": "e2", "from": "urgent.true", "to": "page" },
      { "id": "e3", "from": "urgent.false", "to": "queue" },
      { "id": "e4", "from": "urgent.uncertain", "to": "human" }
    ]
  }
}
```

- `provider`: `typesafe-jev`, `cloudflare-clef` or `cloudflare-clef-flash`. `model` is optional (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`).
- `state`: template (up to 64 KiB rendered). `instructions`: 1-4000 characters. `onError`: `"fail"` (default) or `"uncertain"` (route provider failures to the `uncertain` handle).
- `mode.kind` is one of:
  - `boolean`: optional `trueAt` and `falseAt` thresholds in `[0, 1]` with `falseAt <= trueAt`. Handles: `true`, `false`, `uncertain`.
  - `choice`: `options` (1-255 entries, each `{ "value": 1-100 chars, "description"? }`, unique) and `branches` (`[{ "id", "values": [...] }]`) mapping option values to handle ids; optional `minConfidence` in `[0, 1]`. Handles: each branch id plus `uncertain`.
  - `score`: `levels` (2-10 entries `{ "label", "description"? }`) and `bands` (`[{ "id", "atLeast": number | null }]`, one band with `atLeast: null` as the floor); optional `minConfidence`. Handles: each band id plus `uncertain`.
- Every outgoing edge **must name a handle** (`urgent.true`). The `uncertain` handle exists in every mode: **wire it**, because an uncertain answer with no `.uncertain` edge fails the node.
- Provider keys are environment-variable based (`TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`). Do not read, write or print them.

### 7.7 `join`

Merges parallel or exclusive paths.

```json fragment
{
  "id": "merge",
  "type": "join",
  "name": "Merge paths",
  "ui": { "x": 1400, "y": 160 },
  "mode": "first",
  "inputs": ["passed", "triaged"],
  "output": { "type": "object", "additionalProperties": true }
}
```

- `inputs`: one or more unique handle-style names. Each needs exactly one inbound edge `source -> merge.<input>`.
- `mode: "first"`: expects exactly **one** active input when it resolves (typical after a gate, where only one path ran). More than one active input fails with `E_JOIN_CONFLICT`. Its output is that input's value.
- `mode: "all"`: waits for every input; its output is `{ "<input>": value | null }` with `null` for inputs that were skipped.
- `output` (optional JSON Schema, same profile as agent output, section 8) validates the joined value. **A referenced `first` join whose inputs have different output shapes must declare `output`** (error `E_JOIN_OUTPUT`). Agents and shells have known shapes; approvals and decisions do not, so mixing them gives a warning that the value is checked at run time. Declare a permissive object schema like the one above when sources differ.

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

### 7.11 `end`

```json fragment
{
  "id": "end",
  "type": "end",
  "name": "End",
  "ui": { "x": 1660, "y": 160 },
  "status": "success",
  "result": "{\"report\": merge}"
}
```

- `status`: `success`, `failed` or `rejected`. It is the run's final status.
- `result`: non-empty bare expression over `start` and the end's ancestors; the run result is its value. Use an object constructor for structured results.
- Give failure and rejection paths their own `end` with `status: "failed"` / `"rejected"` so the run's final status tells the truth.

### 7.12 Start triggers (polling + webhook)

Triggers are opt-in config on the `start` node, not graph nodes. A workflow starts manually by default; `polling` lets a timer probe start runs, `webhook` lets signed HTTP deliveries start runs. Both pin the armed revision: editing the workflow (or a called child) makes the trigger `stale` (refresh re-pins); an invalid saved workflow makes it `invalid` while the last valid revision keeps serving. Either block may be present with `enabled: false` while authoring. Triggers are armed and managed in the browser Trigger controls / API, not the agent CLI.

```json fragment
{
  "id": "start",
  "type": "start",
  "name": "Start",
  "ui": { "x": 80, "y": 160 },
  "params": [{ "name": "pr_url", "type": "string", "required": true }],
  "polling": {
    "enabled": true,
    "dedupe": true,
    "workspace": "project",
    "probe": {
      "id": "probe",
      "type": "shell",
      "name": "Poll probe",
      "command": "gh pr list --limit 1 --json url --jq .[0].url",
      "timeoutMin": 10
    }
  },
  "webhook": { "enabled": true, "paramMapping": { "pr_url": "body.pull_request.html_url" } }
}
```

- `polling`: `{ enabled: boolean, probe: <full shell|agent node>, dedupe?: boolean (default true), workspace?: "project" | "worktree" (default "project") }`. `probe.id` must be `"probe"` when present. Shell probes omit engine-owned `workspace`/`allowFailure` (non-zero exit is always a probe failure); agent probes omit generated `output` plus `workspace`/`context`/`promptFile`, with `timeoutMin` under `limits`. Probe `command`/`prompt` must not contain `{{ }}`; agent prompt is at most 1 MiB. The engine prepends a read-only preamble describing the `{ found, params, dedupeKey? }` contract (`dedupeKey` at most 512 chars; params validate like a manual run).
- Shell probe output: trimmed empty/`null` means nothing; a JSON object is the params object itself (only `{"found": false}` is accepted as an envelope); a bare scalar is accepted only with exactly one start param. Agent probe output is `{ "found": boolean, "params": { ... }, "dedupeKey"? }`.
- Arm with `intervalSeconds` (shell 10-86400, agent 60-86400); `probe-now` is the safe dry run (never starts a run, never writes a dedupe claim). Dedupe skips results seen in the last 7 days. Five consecutive probe failures disarm automatically. `project` probes run at the registered root read-only; `worktree` uses a fresh worktree per tick.
- `webhook`: `{ enabled: boolean, paramMapping?: Record<paramName, path> }`. Without a mapping, same-named top-level body keys fill params; with a mapping it is authoritative. Paths are `body.<key...>` (up to 8 segments, `[A-Za-z0-9_-]`, no `__proto__`/`constructor`/`prototype`) or `headers.<allowlisted-name>` (`content-type`, `user-agent`, `x-github-delivery`, `x-github-event`, `x-gitlab-event`, `x-webhook-id`). Null/missing values count as absent. Arming returns a delivery URL plus a 40-char hex secret (shown once) for the sender's secret field; deliveries carry HMAC-SHA256 in `X-Hub-Signature-256` (202 new run, 200 duplicate).

## 8. Agent, join and loop output schemas

Output schemas use a **restricted JSON Schema profile**:

- The top level must be `"type": "object"`.
- Allowed keywords only: `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `description`, `title`, `default`, `$defs`, `$ref`, `anyOf`. Anything else (`oneOf`, `allOf`, `not`, `if`, `patternProperties`, `format`, tuples, ...) is rejected.
- `type` is a single type: `object`, `array`, `string`, `number`, `integer`, `boolean` or `null`.
- `required` may only list properties declared in the same `properties`.
- `additionalProperties` must be a boolean. **Omitted means closed** (`false`). Set `true` only when you genuinely want free-form objects.
- **Arrays must declare `items` (one schema) and `maxItems`.** Bound them realistically.
- `{}` as a property schema means "any JSON value".
- `$defs` is allowed at the root only; `$ref` must be `#/$defs/<name>` and may not be recursive; `anyOf` has 1-4 branches and cannot be mixed with other keywords except annotations.
- Limits: depth 8, at most 200 properties in total, 64 KiB after normalization.

Design schemas for the **consumer**: put exactly the fields later nodes will read, mark them `required`, use `enum` for statuses, and give each field a `description` so the agent knows what to put there. For a pass/fail review use `{"passed": boolean, "feedback": string}`; for lists of work use an array of small objects with a `maxItems` bound; for generated artifacts use a `path` string field (section 6).

```json fragment
{
  "type": "object",
  "properties": {
    "passed": { "type": "boolean", "description": "true only if every acceptance check was verified" },
    "feedback": { "type": "string", "description": "what to fix next; empty when passed" },
    "files": { "type": "array", "items": { "type": "string" }, "maxItems": 50 },
    "reportPath": { "type": "string", "description": "workspace-relative path of the written report" }
  },
  "required": ["passed", "feedback"],
  "additionalProperties": false
}
```

## 9. A complete routing example: gate, join, approval

Runs a lint command, routes on its exit code, asks a person to confirm a proposed plan when there are findings, and merges both paths:

```json
{
  "schemaVersion": 1,
  "id": "lint-and-triage",
  "name": "Lint and triage",
  "description": "Run lint; summarise a clean run, or propose a fix plan for approval.",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Start",
        "ui": { "x": 60, "y": 200 },
        "params": [{ "name": "scope", "type": "enum", "options": ["all", "changed"], "default": "all", "required": true }]
      },
      {
        "id": "check",
        "type": "shell",
        "name": "Run lint",
        "ui": { "x": 320, "y": 200 },
        "command": "npm run lint --silent",
        "timeoutMin": 10,
        "allowFailure": true
      },
      {
        "id": "route",
        "type": "gate",
        "name": "Lint clean?",
        "ui": { "x": 580, "y": 200 },
        "branches": [
          { "id": "clean", "when": "check.exitCode = 0" },
          { "id": "findings", "otherwise": true }
        ]
      },
      {
        "id": "note",
        "type": "agent",
        "name": "Write status",
        "ui": { "x": 840, "y": 80 },
        "cli": "claude-code",
        "prompt": "Lint passed for scope {{ start.scope }}. Write a one-line status message.",
        "output": {
          "type": "object",
          "properties": { "status": { "type": "string" } },
          "required": ["status"],
          "additionalProperties": false
        },
        "permissions": { "network": false, "write": [] }
      },
      {
        "id": "triage",
        "type": "agent",
        "name": "Propose a fix plan",
        "ui": { "x": 840, "y": 320 },
        "cli": "claude-code",
        "prompt": "Lint failed (scope {{ start.scope }}, exit code {{ check.exitCode }}). Output tail:\n{{ check.stdout }}\nPropose a short fix plan. Do not change any files.",
        "output": {
          "type": "object",
          "properties": { "plan": { "type": "string" } },
          "required": ["plan"],
          "additionalProperties": false
        },
        "permissions": { "network": false, "write": [] }
      },
      {
        "id": "confirm",
        "type": "approval",
        "name": "Confirm the plan",
        "ui": { "x": 1100, "y": 320 },
        "message": "Lint found problems. Proposed plan:\n{{ triage.plan }}",
        "criteria": ["The plan only touches files lint reported"],
        "irreversible": false
      },
      {
        "id": "merge",
        "type": "join",
        "name": "Merge paths",
        "ui": { "x": 1360, "y": 200 },
        "mode": "first",
        "inputs": ["passed", "triaged"],
        "output": { "type": "object", "additionalProperties": true }
      },
      {
        "id": "finish",
        "type": "end",
        "name": "Done",
        "ui": { "x": 1620, "y": 200 },
        "status": "success",
        "result": "{\"outcome\": merge}"
      },
      {
        "id": "declined",
        "type": "end",
        "name": "Plan rejected",
        "ui": { "x": 1360, "y": 440 },
        "status": "rejected",
        "result": "{\"reason\": \"plan rejected by reviewer\"}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "check" },
      { "id": "e2", "from": "check", "to": "route" },
      { "id": "e3", "from": "route.clean", "to": "note" },
      { "id": "e4", "from": "route.findings", "to": "triage" },
      { "id": "e5", "from": "triage", "to": "confirm" },
      { "id": "e6", "from": "note", "to": "merge.passed" },
      { "id": "e7", "from": "confirm", "to": "merge.triaged" },
      { "id": "e8", "from": "confirm.rejected", "to": "declined" },
      { "id": "e9", "from": "merge", "to": "finish" }
    ]
  }
}
```

## 10. Run-level workspace and project file safety

- **The workflow does not choose where it runs.** The person starting a run picks one workspace for the whole run: the **project root** (the default; their live files, including uncommitted and untracked ones), an **existing Git worktree**, or a **new per-run worktree** (a clean checkout at the project's committed `HEAD`). Every agent and shell step in the run uses that same directory. Do not add per-node `workspace` fields; they are ignored on fresh runs (and, inside loops, only `scratch` is accepted).
- In the default project-root mode, an agent with `write: ["workspace"]` and every shell step **edit the real project directly**. DevChestra does not copy, commit, roll back, snapshot or sandbox anything. If a workflow modifies files, say so in your summary and suggest the user start it in a new worktree while it is being tried.
- `permissions` are tool-level limits on agents, not an OS sandbox; shell nodes are unrestricted ordinary processes. A step can reach any path the user's account can.
- Keep file operations inside the workspace. Use relative paths. Do not reference `~`, absolute paths outside the project, or other users' files.
- Destructive or outward-facing commands (`rm -rf`, `git reset --hard`, `git clean`, `git push --force`, package publishing, deployments, database migrations, sending messages) need an `approval` node with `irreversible: true` immediately before them. Prefer read-only agents (`write: []`).
- Never place secrets in params, prompts, outputs, shell commands or this file. Node `env` passthrough is not supported, and secrets found in outputs are rejected.
- Do not edit or delete files outside `.devchestra/workflows/` while authoring a workflow, except where the user asked for it.

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
- [ ] Every agent has `cli`, an inline `prompt`, an `output` schema in the restricted profile (arrays have `maxItems`), and `permissions`.
- [ ] Shell placeholders are outside quotes; no heredocs; destructive commands sit behind an approval.
- [ ] Loops: `maxIterations` set, body has one start (no params) and one success end, `result` and `until` are evidence-based, `.exhausted` is wired to a failed end, state/result stay small.
- [ ] Foreach: `source` set (expression over outer scope, or relative csv template), `maxItems`/`onItemFailure` defaulted, body has one start (no params) and one success end, `result` over end ancestors plus `foreach`, per-item `output` set.
- [ ] Child workflows: `workflowId` matches managed id rules, `inputs` are bare expressions over call-site ancestors, plain edge = success and `.failed` wired for failures, no live runs during authoring.
- [ ] Every node has `ui` coordinates.
- [ ] The JSON is valid (no comments or trailing commas) and under 1 MiB.


## CLI lifecycle

Start a local API server with `devchestra start --headless` in a persistent process. Register with `devchestra project add <path>`, then use `devchestra workflow validate --project <path> --file <file>` and `devchestra workflow create --project <path> --file <file>`. `--file -` reads stdin. For edits, use `workflow show` to obtain the ETag and pass it to `workflow update <id> --if-match <etag>`.

Run a saved workflow with `devchestra run start <id> --project <path> --idempotency-key <unique-key>`, retain its run ID, then use `devchestra run watch <run-id> --jsonl`. The server owns the run, so disconnecting the watcher does not cancel it. On a lost start response, reuse the same key and revision; if the workflow was edited meanwhile, the server may return a revision conflict, so inspect the run list before another start. Reconnect using `--after <event-id>`. Inspect with `run show`, `run events`, `run execution --path <path>`, `run transcript --path <path>`, and `run output`. `run cancel` and `run resume` act on existing runs. A workflow edit does not alter an existing run's frozen snapshot; start a new run for the updated workflow.

For human review, use `approval list --run <run-id>` and `approval show <run-id> --path <path>`, present the request to the user, and resolve only with their authorized decision. Pass the returned request ID, attempt, and generation to `approval resolve` with `--request-id`, `--expected-attempt`, `--expected-generation`, and `--decision approve|reject`. Never infer approval. For uncertain shell side effects, inspect the effects and require explicit authorization before retrying.

Agent commands print JSON, and watch prints JSONL. Use `devchestra project --help` for the command overview. Usage data is only as complete as the providers report; do not infer that missing cost information means a run is free.

Polling and webhook triggers are declared in the workflow file (section 7.12) but armed, refreshed, rotated, and probed in the browser Trigger controls / API. The agent CLI has no trigger commands.

## Discovery, tests, and uncertain-shell recovery

`devchestra capabilities --json` enumerates commands and flags. `devchestra workflow schema --json` returns the structural schema; `workflow validate` remains authoritative for graph, expression and project rules. Agent command JSON and JSONL messages carry `contractVersion: 1`; structured errors are on stderr. `workflow groups show` and `workflow groups update` manage group metadata with an ETag. `gate test --project <project> --file <json>` previews routing without a run. `decision test` makes a live provider call and may cost money; use it only when authorized. `run foreach <run-id> --source <node-id>` lists item references.

When a run has an uncertain shell side effect, inspect `run show` and the interrupted execution, assess external effects and obtain the user's explicit authorization. Then submit `run resume <run-id> --retry-uncertain-shell --path <execution-path> --expected-attempt <attempt> --expected-generation <generation> --expected-event-id <watermark>`. Use values from the same run snapshot; do not reuse a stale acknowledgement. If several shells are interrupted, the server refuses this retry until a safe targeted recovery is supported. A watch disconnect or timeout is not a run failure: inspect the run and reconnect with its last emitted event ID. Per-execution usage is for the current attempt and missing cost reports do not mean zero cost.
