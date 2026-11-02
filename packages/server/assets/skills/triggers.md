# DevChestra skill: triggers

Use when: triggers — `start.polling` and `start.webhook` trigger blocks, arming, and delivery contracts.

> Validator wins over this text. Triggers are declared in the workflow file but armed and managed in the browser UI (Trigger controls), not the agent CLI. Never put secrets in trigger blocks; secrets are issued at arm/rotate time and shown once.

## Start triggers are opt-in config, not graph nodes

- A workflow starts manually by default. Add `polling` and/or `webhook` blocks to the `start` node to allow timer polls and HTTP deliveries to start runs of the saved workflow.
- Both are closed over the saved revision: arming pins the armed revision. Editing the workflow (or a transitively called child) makes the trigger `stale`; refresh re-pins. An invalid saved workflow makes it `invalid`, and the last valid armed revision keeps serving until refreshed or disarmed.
- Either block may be present with `enabled: false` while authoring. The browser reports `supported` from the saved file and `off`/`current`/`stale`/`invalid` (`polling` adds `failing` while the last probe failed).
- Management is browser/API only: `GET/POST .../workflows/<id>/polling[/arm|/disarm|/refresh|/probe-now]`, `GET/POST .../workflows/<id>/webhook[/arm|/disarm|/rotate|/refresh]`, plus `GET/PUT /api/settings/webhooks`. There are no agent-CLI trigger commands; use `devchestra skill ops` for the CLI lifecycle.

## `start.polling`: timer probe that returns start params

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
  }
}
```

- Shape: `polling: { enabled: boolean, probe: <full shell|agent node>, dedupe?: boolean (default true), workspace?: "project" | "worktree" (default "project") }`.
- The probe is config inside `start`, not a graph member. `probe.id` must be `"probe"` when present; `name` defaults to `"Poll probe"`.
- Shell probe: same fields as a graph shell node, except engine-owned `workspace` and `allowFailure` must be omitted (non-zero exit is always a probe failure). `command` is required, non-empty, and must not contain `{{ }}`. `timeoutMin` is 1-480, default 10.
- Agent probe: same fields as a graph agent node, except `output` is generated from the start params (omit it), and `workspace`, `context`, `promptFile` are not accepted. `timeoutMin` moved to `limits.timeoutMin`. `prompt` is required inline, non-empty, at most 1 MiB, and must not contain `{{ }}`. `permissions` follow the agent rules; `cli` is one of `claude-code`, `codex`, `opencode`, `pi`. The engine prepends a read-only preamble (`Inspect the current state ... never change files, branches or remote state`) describing the `{ found, params, dedupeKey? }` contract.
- Reserved names: when `polling` is declared, no start param may be named `found` or `dedupeKey` (they are envelope keys).
- Probe output contract (validated with `validateParams`, failure is `E_POLL_PROBE`, never silent "nothing"):
  - Agent probe returns `{ "found": boolean, "params": { ... }, "dedupeKey"?: string }`. `found: false` means nothing. `params` holds only start params (missing values fall back to defaults; required checks still apply). `dedupeKey` is at most 512 chars.
  - Shell probe `stdout` trimmed to empty or `null` means nothing. A JSON object means the params object itself, e.g. `{"pr_url": "..."}` (only `{"found": false}` is accepted as an envelope; `dedupeKey` may ride alongside). A bare scalar is accepted only when the start node declares exactly one param. Non-zero exit always fails the probe.
- Arming: `intervalSeconds` with shell probes 10-86400, agent probes 60-86400. Arming again with a new interval updates it; the poller row is created on the first arm. `probe-now` runs one on-demand probe against the saved workflow: it never starts a run, never writes a dedupe claim, and reports `wouldSkipAsDuplicate`.
- Dedupe (default on): a `found` result whose key (explicit `dedupeKey`, else the params hash) was seen in the last 7 days is recorded as `duplicate` and skipped. Set `dedupe: false` only for idempotent workflows.
- Runtime: states `off`/`current`/`stale`/`invalid`/`failing`. A tick with a still-running probe is `skipped`. Five consecutive probe failures disarm the poller automatically (`lastError` kept, cleared by the next success). `workspace: "project"` runs the probe at the registered project root (read-only, no checkout); `"worktree"` uses a fresh worktree per tick. Probe deadline is bound by the interval.

## `start.webhook`: signed HTTP delivery that maps into start params

```json fragment
{
  "id": "start",
  "type": "start",
  "name": "Start",
  "ui": { "x": 80, "y": 160 },
  "params": [{ "name": "pr_url", "type": "string", "required": true }],
  "webhook": {
    "enabled": true,
    "paramMapping": { "pr_url": "body.pull_request.html_url" }
  }
}
```

- Shape: `webhook: { enabled: boolean, paramMapping?: Record<paramName, path> }`. Without `paramMapping`, each same-named top-level body key fills that param. With `paramMapping`, it is authoritative: unmapped params take their default or fail as missing.
- Path: `body.<key>[.<key|index>...]` (up to 8 segments, each 1-64 chars `[A-Za-z0-9_-]`, no `__proto__`/`constructor`/`prototype`) or `headers.<allowlisted-name>`. Allowlisted headers only: `content-type`, `user-agent`, `x-github-delivery`, `x-github-event`, `x-gitlab-event`, `x-webhook-id`. Anything else is rejected (`E_WEBHOOK_PATH`); a mapping target must name a declared param (`E_WEBHOOK_MAPPING`).
- Delivery values read as `null`/missing count as absent, so defaults and required checks apply exactly like a manual run.
- Arming returns a copyable delivery URL (from `publicBaseUrl` in webhook settings, else the request origin) and a 40-char hex secret shown once. Configure the secret in the sender (e.g. GitHub's Secret field). Deliveries POST the raw JSON body with HMAC-SHA256 in `X-Hub-Signature-256`. Delivery ID headers in precedence order: `x-github-delivery`, `x-webhook-id`, `idempotency-key`. Ingress answers 202 for a new run, 200 for a duplicate delivery. `hookId` is stable across disarm and re-arm; `rotate` issues a new secret immediately.
- Runs start from the armed revision in a fresh `new-worktree` workspace. Deleting the workflow removes the trigger.

## Authoring checklist for triggers

- [ ] `polling.enabled` / `webhook.enabled` is a boolean; omit or set `false` until the user asks for arming.
- [ ] No start param named `found` or `dedupeKey` when `polling` is declared.
- [ ] Probe has no `{{ }}` in `command`/`prompt`; shell probe has no `workspace`/`allowFailure`; agent probe has no `output`/`workspace`/`context`/`promptFile`.
- [ ] Every `webhook.paramMapping` target is a declared param and every path parses (`body.` depth <= 8, allowlisted `headers.`).
- [ ] No secrets in the workflow file. Tell the user arming/URL/secret/interval are browser-UI steps, and `probe-now` is the safe dry run for polling.
