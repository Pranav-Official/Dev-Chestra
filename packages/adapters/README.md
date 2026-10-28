# @relay/adapters

Headless CLI profiles, pure planning, stream parsing and a POSIX process
runner for Relay. The engine depends only on this package's generic interface,
never on a CLI's flags.

No live calls are made by this package itself. Bounded research runs on
2026-10-26 passed fresh+resume submission for Claude Code 2.1.310 and Codex
0.164.0 (including per-server MCP approval `approve` and env_vars forwarding).
Stream fixtures here remain synthetic expectations; permission/sandbox
enforcement is `partial` for Claude and `advisory`/unproven for Codex.

## Public surface

```ts
type CliId = "claude-code" | "codex" | "opencode" | "pi" | "fake";

createAdapter(id, options?): CliAdapter
createAdapterRegistry(options?): { get(id), has(id), ids() }  // prod ids plus fake only when RELAY_ALLOW_FAKE=1
listProviders()/providerIds()  // static registry, no live probes; GET /api/clis serves the same list
createAdapter(id).plan(req: RunRequest): Result<Invocation, RelayError>  // pure
createAdapter(id).parser(): StreamParser
createAdapter(id).classify(exit: ExitInfo, tail: Tail): FailureClass
createAdapter(id).toolRef(tool: string): string
createAdapter(id).probe(ctx, signal): Promise<ProbeResult>              // version/help only

runAgent(inv, hooks, signal, { parser, timeoutMs, silenceMs?, graceMs?,
  maxLineBytes?, maxStderrBytes?, maxStdoutTailBytes?, generation? }): Promise<ExitInfo>
runCommand({ cmd, args?, shell?, cwd, env, stdin?, timeoutMs,
  maxStdoutBytes?, maxStderrBytes? }, hooks, signal?): Promise<CommandResult>
materializeInvocation(inv): Promise<void>  // dirs 0700, files 0600 by default
describeInvocation(inv, redact?): { bin, args, cwd, files }  // safe for logs

buildChildEnv(cli, { base?, nodeEnv?, nodeEnvNames?, cliEnv?, injected?, extraNames? })

readProcessIdentity(pid): Promise<ProcessIdentity | null>
matchesProcess({ pid, pidStart, binary? }): Promise<boolean>
killTree(pid, { graceMs? }): Promise<boolean>
isGroupAlive(pid): boolean
killOrphan(identity, { graceMs? }): Promise<{ matched, killed }>
```

`AdapterOptions` takes absolute `claudeBin`, `codexBin`, `opencodeBin`, `piBin`,
`fakeAgentBin` and `nodeBin` from the composition root. `fakeAgentBin` defaults to the workspace
build at `tools/fake-agent/dist/main.js`; installed builds should pass it.
`fakeScript` (factory) is test-only injection behind `RELAY_ALLOW_FAKE=1`. Fake CLI options are
`checkpoint` and `session` only; everything else is rejected. `opencode`/`pi` are experimental
registry entries backed by a generic adapter until a live contract check lands.

## Process semantics and limits

- POSIX only (Linux/macOS). Children are `detached: true`, so the child pid is
  the process-group id. Kill sends SIGTERM to `-pid`, waits `graceMs` (default
  5 s), then SIGKILL, then re-checks after close.
- `runAgent` calls `onSpawn` **before** writing/closing stdin. `onSpawn`
  receives `{ pid, pidStart, binary, bin, pgid, cwd, generation }` and must persist
  the evidence before returning. Prompt delivery is held until it resolves.
- `runCommand` is gated by a Node wrapper: the wrapper starts first, `onSpawn`
  is awaited, and only then is `GO` written; the command cannot execute before
  the evidence resolves. The wrapper pid/start is the recorded identity and the
  wrapper owns the process group.
- stdout is split incrementally. A line is capped at 8 MiB by default; excess
  bytes are dropped, the line is flagged and delivered as one truncated `raw`
  event. Later complete lines are still parsed.
- stderr is a bounded ring (default 256 KiB). Shell/command stdout is bounded
  separately (default 8 MiB). Transcript entries are capped at 16 KiB
  (head/tail with an omission marker).
- `groupStopped` is false when the group was still alive after the SIGKILL
  window. Engine recovery must not record a confirmed stop/finalize on false.
  `killTree` returns true only for a group it observed alive and then confirmed
  dead; `killOrphan.killed` is true only for that confirmed kill.
- `onEvent` and `onTranscript` may be async. The runner pauses stdout while it
  awaits them, so a slow hook applies backpressure instead of buffering
  unbounded events. Hooks must not call the runner re-entrantly. `onSpawn`
  rejection kills the group and rejects the run.
- `onStderr` receives redacted text; `stderr` entries also flow to
  `onTranscript`. The caller supplies `redact`; register the exec token with
  the store's secret guard as well. `describeInvocation` never prints env,
  stdin, prompt or file contents.
- `runCommand({ shell: true })` takes the whole command in `cmd`; extra `args`
  are rejected to avoid double shell quoting.
- `ExitInfo` includes `tail: { stderr, stdout }` for `classify`. Unknown
  non-zero exits classify as `crash`; no quota/rate-limit/context-overflow
  patterns are guessed. Missing binaries reject with `E_CLI_MISSING`.

## Process identity and orphans

`pidStart` is canonical and includes reboot evidence where available:

- Linux: `linux:<boot_id>:<start_ticks>`
- macOS: `darwin:<ps -o lstart=>`

`binary` is the executable path actually observed, never an argv string.
`matchesProcess` refuses empty `pidStart` and requires exact pidStart (plus
binary basename when supplied); a pid alone is never authority. Boot cleanup
must call `killOrphan` and must mark non-matching records interrupted rather
than signalling them.

**Exact residual gap.** For `runAgent`, the CLI process exists before `onSpawn`
persists it. Stdin is withheld, so stdin-driven agents cannot start their task,
but a CLI may perform startup/config work before reading stdin. A crash in that
window can leave an unrecorded process; a boot scan can only kill processes it
has evidence for. For `runCommand`, the command itself is fully gated, but the
Node wrapper is spawned before persistence: a crash before the evidence write
leaves a wrapper that cannot be matched later; and group cleanup for a live
child whose wrapper has exited is not guaranteed by identity matching. There is
no container or OS-level guarantee here.

## Environment

`buildChildEnv` never copies `process.env` wholesale. It copies a fixed base
allowlist, per-CLI auth names, explicitly declared `nodeEnv`/`nodeEnvNames`,
user `cliEnv`, and trusted `injected` values. `RELAY_*` comes only from
`injected`; declaring it is an error. Loader/injection variables (`NODE_OPTIONS`,
`NODE_PATH`, `LD_PRELOAD`, `DYLD_*`, `BASH_ENV`, `PYTHONPATH`, …) are refused
even when declared. `TERM=dumb` and `CI=1` are forced.

## Token transport

- Claude: the token and MCP env live in `<execDir>/mcp.json`, written mode 0600
  in a 0700 directory; argv contains only the path. This is a real runtime file:
  the engine must delete the exec dir on revocation/exit or explicitly retain an
  owner-only expired config. Do not claim the token is absent from every
  runtime file for Claude; only that it never enters argv/logs/transcripts.
- Codex: `-c mcp_servers.relay.env_vars=["NAME",...]` carries names only; values
  are merged into the child environment from `RunRequest.mcp.env`.
- Fake: `RunRequest.mcp.env` is merged into the fake child's environment.
- Opencode: the token travels in the child environment and inside the
  `OPENCODE_CONFIG_CONTENT` inline JSON (MCP `environment`); no secret file
  is written and nothing secret enters argv.
- Pi: the token travels in the child environment and in the isolated
  `<execDir>/pi-home/mcp.json` (mode 0600), like Claude.
- Never pass a secret in argv. Check `ps` and fixtures for the token value.

## Profiles (pinned, evidence false)

- Claude Code 2.1.310: `-p --output-format stream-json --verbose`,
  `--mcp-config`, `--strict-mcp-config`, `--permission-mode dontAsk`,
  `--allowedTools`/`--disallowedTools`, optional hidden `--max-turns`, model,
  `--add-dir`, `--append-system-prompt`, `--max-budget-usd`; resume re-passes
  MCP/permissions and adds `--resume <uuid>` from the same cwd. No `--sandbox`
  flag exists. `enforcesPermissions: partial`.
- Codex 0.164.0: fresh `exec --json --sandbox read-only|workspace-write --cd
  <cwd>`; resume uses `exec resume <id> -c sandbox_mode=...` with no
  `--sandbox`/`--cd`/`--add-dir`/`-a`/`-p`; cwd comes from spawn. Network is a
  `-c sandbox_workspace_write.network_access=<bool>` override. Per-Relay-server
  MCP approval is `-c mcp_servers.relay.default_tools_approval_mode="approve"`.
  `danger-full-access` and `--dangerously-bypass-*` are never generated.
  `enforcesPermissions: advisory` until negative sandbox evidence exists.
- Fake: real child `node tools/fake-agent/dist/main.js`, prompt stdin, checkpoint
  `--checkpoint`/`--resume`, same cwd. Default checkpoint is
  `<cwd>/.relay/fake-checkpoint.json` on fresh and resume; override with
  `cliOptions.checkpoint` (must stay inside cwd). The fake writes checkpoints
  atomically after each completed step. No-submit fallback belongs to the
  engine. A trusted default script can be injected via `fakeScript` or
  `FAKE_AGENT_SCRIPT`; workflow `cliOptions` can never choose a script or binary.
- Opencode 1.19.4: fresh `run <prompt> --model provider/model --format json
  --dir <cwd>`; resume adds `--session ses_...`. Prompt travels as argv
  (capped at 256 KiB); the relay MCP server attaches via
  `OPENCODE_CONFIG_CONTENT` inline JSON (`type: local`, command
  `[shim, ...args]`, environment, enabled) on fresh and resume alike, and
  `submit_result` is addressed as `relay_submit_result`.
  `step_start`/`text`/`tool_use`/`step_finish`/`error` map to
  session/text/tool/usage/turn_end; `step_finish` tokens are per-step deltas
  emitted directly (`usageIsCumulative: false`). Model catalog is
  `opencode models [--verbose]` (15 s / 1 MiB / 1000 items); ids pass through
  to `-m` verbatim. `enforcesPermissions: advisory`.
- Pi 1.4.0: `-p --mode json --session-dir <execDir>/../pi-sessions
  [--session-id <id>] -- <prompt>`; model via `piProvider.modelArg`, provider
  via `--provider`. Discovery returns provider-qualified `provider/model` ids
  so catalog selection round-trips through `--model`/`--provider` without
  ambiguity. The isolated `PI_CODING_AGENT_DIR` carries relay `mcp.json` plus
  symlinks to the canonical `auth.json`/`models.json`/`settings.json` when
  present (refresh writes persist back); provider API-key variables also pass
  the child-env allowlist. Catalog is `pi --list-models [search]`.
  Each completed message's usage is counted once from `message_end`;
  streaming deltas and the `turn_end` echo are not counted.
  `enforcesPermissions: advisory`.

`classify` does not guess quota messages; live evidence must fill patterns.

## Usage baseline seam

Within one process the parsers subtract cumulative totals and emit `usage`
events as deltas. On a resumed invocation the CLI may report session-cumulative
cost (Claude `total_cost_usd`) or cumulative tokens (Codex), but the generic
adapter interface has no prior-attempt baseline. The first result after resume
is therefore a delta from zero for that process. Budget accounting in the
engine must carry the prior per-session totals across attempts; do not treat
the first post-resume usage event as the whole cost of the run.
