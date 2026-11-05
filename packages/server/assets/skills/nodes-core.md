# DevChestra skill: nodes-core

Use when: nodes-core — start/agent/shell/end + output schemas.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

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
- Timer and HTTP triggers are optional `start.polling` / `start.webhook` blocks; see `devchestra skill triggers`. When `polling` is declared, no param may be named `found` or `dedupeKey`.
- Param `type`: `string`, `number`, `boolean` or `enum`. `required` is required. `default` must match the type (finite number for `number`; for `enum`, one of `options`). Only `enum` may have `options`; they must be non-empty, unique, non-empty strings.
- A run supplies a value for each parameter (CLI: `--param name=value`; the Run dialog in the browser). Unknown parameters are rejected, missing required ones without a default are rejected, defaults are applied.
- Read parameters as `start.<name>`. Never put secrets in parameters; values are stored and scanned for secrets.

### 7.2 `agent`

```json fragment
{
  "id": "review",
  "type": "agent",
  "name": "Review the change",
  "ui": { "x": 340, "y": 160 },
  "tier": "medium",
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
| `tier` | `high`, `medium` or `low`. **Use this by default.** Each machine maps the tier to a provider and model in its own settings (see "Model tiers" below), so a committed workflow runs on any developer's machine without edits. An agent sets either `tier` or `cli`, never both, and a tiered agent must not set `model`. |
| `cli` | only when the user asks for one specific provider: one of `claude-code`, `codex`, `opencode`, `pi`. Excludes `tier`. (`fake` is test-only and must not be used.) |
| `model` | optional, only with `cli`. If set it is passed unchanged to the CLI; use an exact id from the CLI's model catalog (the editor's model picker lists them). Omit it to use the CLI's default. Never guess a model id. |
| `prompt` | required, inline text template. See "No `promptFile`" below. Warns if empty. |
| `output` | required JSON Schema for the result (section 8) |
| `permissions` | required: `network` (boolean), `write` (array), optional `shell` (boolean). See below. |
| `mcpServers` | optional list of `{ "name", "scope" }`. See below. |
| `limits` | optional: `timeoutMin` (integer 1-480, default 30), `validationRetries` (integer 0-10, default 2), `crashRetries` (integer 0-10, default 1). `maxQuotaWaitHours` is not supported. |

#### Model tiers

A tier is a machine-specific choice of provider and model. Pick by the job: `high` for hard reasoning and code changes, `medium` as the everyday default, `low` for cheap routing, extraction and summaries.

Mappings live in the project's `.devchestra/` folder in two files with the same shape, and the local one wins per tier:

- `settings.local.json`: this machine only, ignored by git. Created for you when a project is registered (every tier points at the first installed provider's default model).
- `settings.json`: committed and shared. Use it for a team default. Never put secrets in either file.

```text
{ "version": 1, "models": { "high": { "cli": "claude-code", "model": "opus" }, "medium": { "cli": "claude-code" }, "low": { "cli": "pi" } } }
```

Read and change mappings with `devchestra settings show [--scope effective|local|project]`, `devchestra settings set <high|medium|low> <cli> [model] [--scope local|project]` and `devchestra settings unset <tier>`. Tiers are resolved once when a run starts, so editing settings never changes a run that is already going. If a tier a workflow uses is not mapped on the machine, the run is refused before it starts with `E_MODEL_TIER` naming the tier: map it and start again. Do not edit another developer's `settings.local.json`.

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
