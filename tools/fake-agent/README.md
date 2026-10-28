# @relay/fake-agent

A scriptable, explicit fake agent. It is a real MCP SDK client: it spawns the
real `@relay/mcp` stdio shim, calls `tools/list`, then executes a JSON script of
`say`, `tool`, `submit`, `submit-from-inputs`, `sleep` and `crash` steps.

It is **not** a recorded Claude Code, Codex, OpenCode or Pi transcript and must
not be used as live-CLI evidence. Its only profile is `relay-fake` (`fake`).

## Launch

Built bin:

```sh
node tools/fake-agent/dist/main.js --prompt "demo" --cwd /tmp/work
# or, when the package bin is linked:
relay-fake-agent --prompt "demo" --cwd /tmp/work
```

Development:

```sh
node --import tsx tools/fake-agent/src/main.ts --prompt "demo" --cwd /tmp/work
```

The fake agent launches the shim from `RELAY_MCP_SHIM_ENTRY`:

- built shim: `packages/mcp/dist/bin/shim.js`
- TypeScript source: `packages/mcp/src/bin/shim.ts` (the agent resolves the
  installed `tsx` loader itself, so the shim can run with any workspace cwd)

## Required environment

The shim needs the normal values; the fake agent checks them before connecting:

| Variable | Meaning |
|---|---|
| `RELAY_MCP_SHIM_ENTRY` | Absolute or cwd-relative path to the shim entry. |
| `RELAY_EXEC_TOKEN` | Exec token for the shim (environment only; never argv). |
| `RELAY_GATEWAY_URL` | Loopback gateway base URL. |
| `RELAY_TOOLSET` | `agent` or `supervisor`. |
| `FAKE_AGENT_SCRIPT` | Optional JSON step array when `--script` is omitted. |
| `FAKE_AGENT_CHECKPOINT` | Optional checkpoint path when `--checkpoint` is omitted. |
| `FAKE_AGENT_PROFILE` | If set, must be `fake`. |
| `FAKE_AGENT_SESSION_ID` | Optional explicit session id. |
| `FAKE_AGENT_PROMPT` | Optional prompt when no `--prompt`/file/stdin is supplied. |

## CLI

```text
--prompt <text>       prompt text (or use --prompt-file / non-TTY stdin / positional)
--prompt-file <path>
--cwd <dir>           working directory evidence; default process.cwd()
--script <json|file>  JSON array, or path to a JSON file
--script-file <path>
--checkpoint <path>   enable atomic resume checkpoint
--resume              continue from the checkpoint's nextStepIndex and sessionId
--session <id>        force a session id (mutually exclusive with a different checkpoint id)
--format relay-fake   only supported profile
```

Paths for `--script`, `--prompt-file` and `--checkpoint` are resolved from the
fake process cwd. No checkpoint is written unless `--checkpoint` or
`FAKE_AGENT_CHECKPOINT` is supplied.

## Script

```json
[
  { "type": "say", "text": "working" },
  { "type": "tool", "name": "context_list", "args": {} },
  { "type": "submit", "output": { "answer": 1 } },
  { "type": "submit", "output": { "answer": "valid" } },
  { "type": "submit-from-inputs", "path": ["agent"], "fallback": { "seed": true } },
  { "type": "sleep", "ms": 10 },
  { "type": "crash", "code": 9 }
]
```

- `tool` calls any tool on the gateway with `args`.
- `submit` always calls `submit_result` with `output` as its arguments.
- `submit-from-inputs` reads the prompt this process actually received over
  stdin and extracts the engine's single-line JSON between the literal
  `<relay_input_context>` and `</relay_input_context>` marker lines. A missing
  or malformed block fails before calling the gateway. With a valid block, the
  step calls `submit_result` with `{ "received": value }` when every own-property
  segment in `path` exists (present `null`, `false`, `0` and `""` count), or
  with the object `fallback` when the path is absent. `path` has 1-32
  non-empty string segments; inherited names are never selected.
- `crash` writes the checkpoint at the crashed step, emits the crash event,
  then exits with `code`; `--resume` retries that step.

## Output

stdout is NDJSON only; diagnostics and shim stderr are on stderr. Every stdout
frame has `type: "relay-fake"`, `profile: "fake"`, `sessionId` and the absolute
`cwd`. Events: `session` (resumed, pid, prompt hash/size), `tools`, `say`,
`tool_result`, `submit_result` (accepted/isError/text), `sleep`, `crash`,
`error`, `end`.

Session id is `--session`, `FAKE_AGENT_SESSION_ID`, a checkpoint's id, or a
new `fake-<uuid>`. Prompt contents are never echoed; only their SHA-256 and
size are emitted.

## Checkpoint / resume

Checkpoints are written atomically after each completed step:

```json
{
  "version": 1,
  "profile": "fake",
  "sessionId": "fake-...",
  "cwd": "/abs/workspace",
  "nextStepIndex": 2,
  "submitted": false
}
```

`--resume` requires the same `cwd` as the checkpoint (documented simple resume),
continues at `nextStepIndex`, and keeps the session id. A missing checkpoint
falls back visibly on stderr to a fresh session. The supplied script is indexed
by the checkpoint, so the resumed script should include the earlier steps.

The MCP session id is not globally durable; this checkpoint is fake-agent
test state, not an engine recovery mechanism.

## Tests

`pnpm --filter @relay/fake-agent test` drives the real shim against a temporary
loopback gateway: invalid-then-valid submission, session/cwd evidence, distinct
call ids, checkpoint resume, scripted crash, missing-shim failure, and
submit-from-inputs marker/path/fallback handling over real stdin. Tests use
temporary directories and listeners only.
