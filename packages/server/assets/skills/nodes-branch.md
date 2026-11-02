# DevChestra skill: nodes-branch

Use when: nodes-branch — gate/join/approval/decision + routing example.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

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

