# DevChestra CLI

The CLI supports both a durable server-backed interface for agents and the existing embedded runner. Node 22 or newer is required. `--data-dir` defaults to `DEVCHESTRA_DATA_DIR`, then the platform data directory.

Start the local API without a browser or web build in a long-lived terminal:

```sh
devchestra start --headless
```

Run `devchestra skill` for the skill menu (one focused guide per task: `devchestra skill <name>`), or `devchestra skill --all` for the concatenated guide. Existing project-local `.devchestra/skill.md` files are left untouched and may be out of date. `devchestra project --help` lists the agent command groups.

```sh
devchestra project add /path/to/project
devchestra workflow validate --project /path/to/project --file workflow.json
devchestra workflow create --project /path/to/project --file workflow.json
devchestra run start my-workflow --project /path/to/project --idempotency-key my-request
devchestra run watch <run-id> --jsonl
```

Commands produce JSON; watch produces JSONL. `--file -` reads stdin. Run start takes `--params-file`, repeatable `--param key=value`, `--workspace project|new-worktree|existing-worktree` and `--worktree-path`. For a lost start response, retry with the same idempotency key and workflow ETag (`--if-match`). The server checks the saved workflow revision before idempotency lookup, so an edit in the meantime can produce a conflict; inspect the run list instead of starting again with a new key. `workflow show` returns an ETag, which is required by `workflow update` and `workflow delete` to prevent overwriting concurrent edits.

The server owns the run, so disconnecting the watcher leaves it running. `run show`, `run events`, `run execution`, `run transcript`, `run output`, `run children` and `run usage` expose persisted information. `run watch --after <event-id>` replays events after that cursor and continues live; event IDs can have gaps. Watch stops at a terminal state or a human-action state by default; `--until terminal` keeps watching through pauses and `--timeout <seconds>` bounds the wait. Exit codes for watch are 0 succeeded, 1 failed or disconnected, 2 rejected, 3 cancelled and 5 paused or awaiting approval. Inspection commands return success when the inspection succeeds, even if the run failed.

To monitor a long run without spending context, use `run status <run-id>` (the same as `run show <run-id> --compact`) for one small JSON answer: run status and cost, node counts, the executions that are running, failed or waiting (with attempt and last error), loop `iteration`, `maxIterations` and `state`, foreach `processed`, `failed` and `total`, `activity` for running agents (`idleSec` since the transcript was last written, and `lastTool`), and `needsAttention` for approvals and pauses. Then block with `run wait <run-id> --timeout <seconds> [--until any|node-done|status|approval] [--after <cursor>]` instead of sleeping or re-polling. It returns that same status, plus `timedOut` and `reasons`, when a node finishes or fails, a loop round or foreach item completes, an approval is requested, or the run ends or pauses. Pass the returned `cursor` as `--after` on the next call so nothing between calls is missed and a still-pending approval does not end the wait at once. Exit codes: 0 succeeded, 1 failed, 2 rejected, 3 cancelled, 5 paused or awaiting approval, 10 still running (check `timedOut`). For a running agent, `run transcript <run-id> --path <path> --tail 20` returns its latest lines; continue with `--cursor <endCursor>` to read only new ones.

Use `approval list --run <id>` and `approval show <id> --path <path>` to inspect a review. Once the user has made a decision, submit it using `approval resolve <id> --path <path> --decision approve|reject --request-id <id> --expected-attempt <n> --expected-generation <n>`. The request identity prevents a stale approval from resolving a newer request. Run `run cancel` or `run resume` when appropriate. Editing a workflow does not change an existing run's frozen snapshot.

The server binds loopback only and stores owner-only server metadata in the data directory. Any local browser tab can use the plain URL; `start` runs in the background and returns your shell once the server is up (logs go to `<data-dir>/server.log`; pass `--foreground`/`-f` to keep it attached). Pass `start --secure` to require the session token (cookie or `X-DevChestra-Token` header) instead. `devchestra status` reports its status; `devchestra stop` gracefully stops it and refuses while runs are active unless `--force` is provided. Server shutdown pauses active work; startup does not automatically resume it. The embedded `devchestra run <workflow.json> --project <dir> --json` and `devchestra resume <run-id>` commands remain available, and still require exclusive ownership of the data directory. Their `--json` output is the existing NDJSON event stream and summary.

Budget enforcement is not supported by the embedded runner. Provider usage can be missing or estimated; a numeric zero alone does not establish that no cost was incurred. An uncertain shell effect requires inspection and explicit authorization before retrying; embedded resume provides `--retry-uncertain-shell`.

### Agent contract and recovery

The agent command contract is version 1. Each finite response and each JSONL stream item contains `contractVersion: 1`; errors on stderr include `error.code`, `message`, `retryable` and optional `details` and `hint`. An agent should reject unknown major contract versions. Inspection command success describes the command, not whether the run succeeded. Use `devchestra capabilities --json` for commands and flags; `devchestra workflow schema --json` returns the structural JSON Schema without a server. Graph and project rules require `workflow validate`.

`workflow groups show` and `workflow groups update` read or replace grouping metadata with `--if-match`. `gate test --file <json>` previews a gate without a run. `decision test --file <json>` makes a live model request and can incur cost. `run foreach <run-id> --source <node-id>` pages iteration references. Lists return the underlying API cursor; execution usage represents the current attempt and a `costSource` of `none` means cost is unavailable, not free.

When `run show` reports `uncertain_side_effect`, inspect the interrupted shell and its side effects. After the user explicitly authorizes retry, use `run resume <run-id> --retry-uncertain-shell --path <path> --expected-attempt <n> --expected-generation <n> --expected-event-id <watermark>`. Take the fields from the same `run show` response: execution path/attempt/generation and `watermark`. A stale fence is rejected. If several shell executions are interrupted, this recovery path refuses the request instead of authorizing them all. An accepted retry is recorded by the engine. `run watch` reports timeout and overflow with a last emitted event cursor where available; inspect the run and reconnect using `--after`.
