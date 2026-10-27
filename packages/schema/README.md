# @relay/schema

Browser-safe Relay workflow contracts for the P1 single-chain slice: parse, validate, normalize,
hash, parameters, restricted output schemas, JSONata expressions and templates.

No filesystem, process, network or model access. The main entry (`@relay/schema`) has no Node
built-ins; Node expression execution is a separate subpath (`@relay/schema/node`).

## Commands

```sh
pnpm --filter @relay/schema build
pnpm --filter @relay/schema typecheck
pnpm --filter @relay/schema test
pnpm exec biome check packages/schema examples
```

`build` compiles TypeScript and copies `src/node/worker.js` to `dist/node/worker.js`.

## Public API (`@relay/schema`)

```ts
parseWorkflow(raw: unknown): Result<WorkflowFile, RelayError>
parseWorkflowJson(text: string): Result<WorkflowFile, RelayError>

validateWorkflow(file: WorkflowFile, ctx?: ValidationContext): ValidationReport
// ValidationReport = { ok, errors: Issue[], warnings: Issue[], requires: RequiresSummary }

normalizeWorkflow(
  file: WorkflowFile,
  options?: { prompts?: Readonly<Record<string, string>> },
): Result<NormalizedWorkflow, RelayError>
hashWorkflow(workflow: NormalizedWorkflow): Promise<string>

validateParams(source: ParamSource, input?: unknown): ParamValidation
resolveParams(source: ParamSource, input?: unknown): ParamValidation // alias

normalizeOutputSchema(schema: JsonSchemaObject): Result<JsonSchemaObject, RelayError>
hashOutputSchema(schema: JsonSchemaObject): Promise<string>

compileExpression(source: string): Result<CompiledExpression, RelayError>
evaluate(
  compiled: CompiledExpression,
  scope: Readonly<Record<string, unknown>>,
  options?: { timeoutMs?: number; executor?: ExpressionExecutor },
): Promise<Result<unknown, RelayError>>

compileTemplate(
  source: string,
  options?: { shell?: boolean },
): Result<CompiledTemplate, RelayError>
renderTemplate(
  template: string | CompiledTemplate,
  scope: Readonly<Record<string, unknown>>,
  options?: { shell?: boolean; timeoutMs?: number; executor?: ExpressionExecutor },
): Promise<Result<{ text: string; warnings: Issue[] }, RelayError>>

SCHEMA_CAPABILITIES // node types, CLIs, legacy node workspaces, runWorkspaces/defaultRunWorkspace, defaults and unsupported list
```

Types exported include `WorkflowFile`, `NormalizedWorkflow`, `NormalizedNode`, `WorkflowNode`,
`StartNode`, `AgentNode`, `ShellNode`, `EndNode`, `WorkflowParam`, `JsonSchemaObject`, `Issue`,
`RequiresSummary`, `CompiledExpression`, `ExpressionExecutor`, `CompiledTemplate`.

## Public API (`@relay/schema/node`)

```ts
createNodeExpressionExecutor(): ExpressionExecutor
```

Pass it as `options.executor` to `evaluate` or `renderTemplate`. Each evaluation gets a fresh
`node:worker_threads` worker with explicit resource limits (64 MiB old generation, 16 MiB young
generation, 4 MiB stack). On timeout or error the worker is terminated, so a synchronous runaway
cannot continue after the deadline. JSONata's own `timeout` and `stack` options are set as a
second layer. The worker enforces the 64 KiB serialized result cap before `postMessage`; the main
entry checks it again. A browser worker implementation is deliberately deferred; the browser-safe
main entry returns `E_EXPR` if no executor is supplied.

`src/node/worker.js` is intentionally plain ESM JavaScript so the same file runs from `src` under
Vitest and from the `dist` copy. `tsc` does not typecheck it because `checkJs` is disabled; the
public executor and main API are typechecked.

## P1 workflow subset

```jsonc
{
  "schemaVersion": 1,
  "id": "linear-fake",
  "name": "Linear fake-agent demo",
  "description": "optional",
  "graph": {
    "nodes": [ /* start, agent, shell, end */ ],
    "edges": [ { "id": "e1", "from": "start", "to": "draft" } ]
  }
}
```

- Exactly one `start`, exactly one `end`, and the whole graph is one chain:
  start has no inbound/one outbound, end has one inbound/no outbound, every other node has
  exactly one inbound and one outbound. No cycles, forks, joins, dangling edges or unreachable
  nodes.
- Node ids are JSONata-safe (`^[a-z][a-z0-9_]{0,47}$`, no hyphens). The id `start` is reserved
  for the start node because `start` names run parameters in expressions.
- `ui` data on nodes/edges is accepted and preserved by `parseWorkflow`, then stripped by
  `normalizeWorkflow`.
- `agent` supports `cli: "fake" | "claude-code" | "codex"` (`fake` is test-only and warns),
  optional `model`, `prompt` or `promptFile`, restricted `output`, declared `permissions`,
  scratch workspace and bounded limits.
- `shell` supports a scratch workspace, `command` template, `timeoutMin` (default 10) and
  `allowFailure` (default false).
- `end` supports `status` and a JSONata `result` expression.

### Normalization defaults

`normalizeWorkflow` validates first. It fills explicit defaults, inlines `promptFile` from the
supplied prompt map, strips UI, sorts nodes/edges by id and normalizes output schemas. Agent
defaults: `workspace: {mode:"scratch"}`, `limits {timeoutMin:30, validationRetries:2,
crashRetries:1}`, `context {project:"none", workflow:"none"}`, `supervise:"default"`, `env:[]`.
Shell default: `timeoutMin:10`, `allowFailure:false`.

`hashWorkflow` is `core.hashJson(normalized)`. UI and input ordering do not change the hash;
prompts and schemas do.

`promptFile` is never read from disk. Pass its contents as `options.prompts`, keyed either by
the exact `promptFile` value or by `<workflowId>.prompts/<value>`. Missing content is an
actionable `E_WORKFLOW_INVALID`. This package does not validate project-relative workflow paths;
the CLI/workspaces layer owns `.relay/workflows/<id>.json` placement.

### Rejected in P1, with clear diagnostics

Unsupported node types; `opencode`/`pi`; per-node workspace execution (legacy `workspace` metadata
still parses, but fresh runs use the run-level selection); agent context
reads/writes; top-level supervisor; node supervise modes other than `default`; workflow budgets
(`maxUsd`, `maxTokens`, `maxActiveMinutes` are not enforced yet and are not accepted); artifact
`format: "relay-artifact"`; non-empty `cliOptions`; non-empty `env`; project write permission;
`maxQuotaWaitHours`; raw `{{{ }}}` templates; shell heredocs, placeholders in comments or after a
trailing backslash, and placeholders inside quotes, backticks, substitutions or after `$`.

Unsupported/invalid workflow input uses `E_WORKFLOW_INVALID` with a message naming the feature
and the JSON pointer. Invalid params/workflow therefore fail before any engine side effect.

## Expressions

JSONata 2.2.2. The compiler parses the AST, extracts bare scope roots, and enforces:

- Source at most 4 KiB; result canonical JSON at most 64 KiB.
- Scope roots are bare names (`start.topic`, `draft.summary`). `$`/`$$` are allowed.
- Lambdas, partial application, `~>` apply, variable binding (`:=`) and dynamic calls are
  rejected, so `$eval` cannot be reached through an alias. Only a fixed set of pure JSONata
  built-ins is allowed; `$now`, `$millis`, `$fromMillis`, `$random`, `$shuffle`, `$uuid`,
  `$env` and `$eval` are denied. Deep recursion is bounded in the worker.
- Timeout defaults to 250 ms, may be set explicitly up to 2000 ms. The Node executor terminates
  the worker. The main `evaluate` also races a deadline only as a reporting guard; injected
  executors must terminate their own execution context.

Scope values are structured-cloned and deep-frozen before evaluation.

## Templates

`{{ expr }}` inserts a string verbatim, other JSON as compact canonical JSON. `null` or missing
inserts an empty string and emits `W_TEMPLATE_MISSING`. `\{{` escapes a literal `{{`.

For shell commands (`shell: true`), every substituted value is POSIX single-quote escaped:

```sh
printf '%s' {{ draft.summary }}
```

Placeholders are accepted only in unquoted lexical context. These are rejected rather than
silently mis-escaped:

```sh
printf '%s' "{{ draft.summary }}"   # inside double quotes
printf '%s' '{{ draft.summary }}'   # inside single quotes
echo `{{ draft.summary }}`          # inside backticks
echo $(printf %s {{ draft.summary }}) # inside substitution
cat <<EOF ... {{ draft.summary }}   # heredoc
echo # {{ draft.summary }}          # comment; a newline in the value could escape it
printf '%s' \{{ draft.summary }}   # trailing backslash would escape the first quote
```

The command itself is trusted author input; this protects substitution from upstream agent
output, not the author's choice of command.

## Output schema profile

Top-level `type: "object"`. Allowed keywords: `type`, `properties`, `required`,
`additionalProperties: false`, single `items`, `minItems`, `maxItems`, `enum`, `const`,
`minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `$defs` with local `#/$defs/...`
refs, `anyOf` with 1-4 branches, and annotations `description`/`title`/`default` (dropped from
the normalized hash form). Remote refs, recursion, tuples, `if`/`then`/`else`, `allOf`, `not`,
`oneOf`, `patternProperties` and unknown keywords are rejected. Every array must declare
`maxItems`; every object gets `additionalProperties: false`; `required` is sorted. Depth is 8,
total properties 200 and serialized size 64 KiB. Runtime Ajv validation stays in the
server/engine; this package produces the normalized schema and its hash.

## Limits of this slice

- No `gate`, `join`, `decision`, `approval`, `map`, `loop`, context banks, pins, supervisor,
  artifacts, budgets, worktrees, project writes, browser expression worker, graph editor or I/O.
- Live Claude Code/Codex behavior is adapter-owned and not verified here.
- `fake` is only for deterministic tests and examples.
- Relay is not a sandbox.

## Examples

- `/home/pranavpp/Dev Works/DevChestra/examples/linear-fake.json` — deterministic four-node
  scratch-only chain using the test-only `fake` CLI.
- `/home/pranavpp/Dev Works/DevChestra/examples/linear-claude-code.json` — same chain using
  the `claude-code` CLI; live execution/verification is owned by the adapter worker.
