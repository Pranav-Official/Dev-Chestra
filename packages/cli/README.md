# DevChestra CLI

The CLI supports both a durable server-backed interface for agents and the existing embedded runner. Node 22 or newer is required. `--data-dir` defaults to `DEVCHESTRA_DATA_DIR`, then the platform data directory.

Start the local API without a browser or web build in a long-lived terminal:

```sh
devchestra start --headless
```

Run `devchestra skill` for the bundled workflow authoring and CLI guide. Existing project-local `.devchestra/skill.md` files are left untouched and may be out of date. `devchestra project --help` lists the agent command groups.

```sh
devchestra project add /path/to/project
devchestra workflow validate --project /path/to/project --file workflow.json
devchestra workflow create --project /path/to/project --file workflow.json
devchestra run start my-workflow --project /path/to/project --idempotency-key my-request
devchestra run watch <run-id> --jsonl
```

Commands produce JSON; watch produces JSONL. `--file -` reads stdin. Run start takes `--params-file`, repeatable `--param key=value`, `--workspace project|new-worktree|existing-worktree` and `--worktree-path`. To avoid duplicate runs after a lost response, retain the idempotency key and the workflow ETag and use `--if-match` on retries. `workflow show` returns an ETag, which is required by `workflow update` and `workflow delete` to prevent overwriting concurrent edits.

The server owns the run, so disconnecting the watcher leaves it running. `run show`, `run events`, `run execution`, `run transcript`, `run output`, `run children` and `run usage` expose persisted information. `run watch --after <event-id>` replays events after that cursor and continues live; event IDs can have gaps. Watch stops at a terminal state or a human-action state by default; `--until terminal` keeps watching through pauses and `--timeout <seconds>` bounds the wait. Exit codes for watch are 0 succeeded, 1 failed or disconnected, 2 rejected, 3 cancelled and 5 paused or awaiting approval. Inspection commands return success when the inspection succeeds, even if the run failed.

Use `approval list --run <id>` and `approval show <id> --path <path>` to inspect a review. Once the user has made a decision, submit it using `approval resolve <id> --path <path> --decision approve|reject --request-id <id> --expected-attempt <n> --expected-generation <n>`. The request identity prevents a stale approval from resolving a newer request. Run `run cancel` or `run resume` when appropriate. Editing a workflow does not change an existing run's frozen snapshot.

The server binds loopback only and stores owner-only server metadata in the data directory. `devchestra status` reports its status; `devchestra stop` gracefully stops it and refuses while runs are active unless `--force` is provided. Server shutdown pauses active work; startup does not automatically resume it. The embedded `devchestra run <workflow.json> --project <dir> --json` and `devchestra resume <run-id>` commands remain available, and still require exclusive ownership of the data directory. Their `--json` output is the existing NDJSON event stream and summary.

Budget enforcement is not supported by the embedded runner. Provider usage can be missing or estimated; a numeric zero alone does not establish that no cost was incurred. An uncertain shell effect requires inspection and explicit authorization before retrying; embedded resume provides `--retry-uncertain-shell`.
