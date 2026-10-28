# @devchestra/cli — P1 headless runner

Built binary: `packages/cli/dist/main.js` (`devchestra`). The root scripts forward:

```sh
pnpm devchestra start --data-dir <dir> [--port N] [--no-open] [--print-url] [options]
pnpm devchestra run <workflow.json> --project <dir> --data-dir <dir> [options]
pnpm devchestra resume <runId> --data-dir <dir> [options]
pnpm devchestra doctor --data-dir <dir> [--json]
pnpm devchestra version
```

`--data-dir` is required in this milestone. There is no default config and no `~/.devchestra` fallback.

## Browser server (`devchestra start`)

The long-lived listener binds loopback only and serves the browser API plus the built web app at `apps/web/dist`. A missing web build is a startup error; run `pnpm build` first. `--port 0` is ephemeral; an omitted port scans 4821..4890 and falls back to ephemeral. On EADDRINUSE the listener retries ephemerally and reports the actual port.

`--no-open` suppresses the browser; `--print-url` prints the tokenised bootstrap URL once. No token appears in logs, errors or `devchestra` argv.

`<dataDir>/server.json` is written atomically with mode `0600`; a newly created data directory is `0700`:

```json
{"version":"0.1.0","pid":123,"pidStart":"linux:...","port":4821,"token":"<32 random bytes base64url>","instanceId":"<16 random bytes base64url>","startedAt":1790000000000}
```

One machine-readable `devchestra.ready` NDJSON line (no token) is printed after the listener and metadata are ready. A second `devchestra start` attaches only when the lock owner, `pidStart`, metadata owner and `/api/health` instance identity all match; it never mints a second token or overwrites live metadata. A lock held with unverifiable metadata exits 4.

SIGINT/SIGTERM close HTTP/SSE first, then `engine.stop` (pausing active runs for manual resume), then gateway/store and the lock. Clean shutdown removes only this process's `server.json`. Startup recovery never auto-resumes or dispatches a run, and browser startup never starts work.

## Linear example (needs a signed-in provider CLI)

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/project" "$tmp/data"
cp examples/linear-codex.json "$tmp/project/workflow.json"
cat > "$tmp/script.json" <<'JSON'
[{"type":"submit","output":{"summary":"A short note.","points":["one","two"]}}]
JSON
pnpm devchestra run workflow.json \
  --project "$tmp/project" \
  --data-dir "$tmp/data" \
  --param topic=orchestration \
  --json
```

The workflow path must resolve inside `--project`. Supported agent CLIs are `claude-code`, `codex`, `opencode` and `pi` (registry-backed; see `GET /api/clis`) and are official (no opt-in flag). The fake CLI is test-only behind `DEVCHESTRA_ALLOW_FAKE=1`; its script is an explicit caller fixture, never read from workflow `cliOptions`.

## Stopping and checking the server

```sh
devchestra status            # running? url, uptime, active runs; exit 0 if running, 1 if not
devchestra stop              # graceful stop (SIGTERM); refuses while runs are active
devchestra stop --force      # stop anyway; SIGKILL if it will not exit within --timeout (default 15s)
```

Both read the server record in the data dir and verify the recorded process is really the DevChestra server
(pid and start time) before signalling it, so a recycled pid is never touched. `stop` also clears a leftover
record after a crash or reboot. Add `--json` for machine-readable output.

## Options

- `--param k=v` — repeatable; JSON scalars/objects are parsed, otherwise the value is a string.
- `--json` — NDJSON of **all** persisted `EventEnvelope`s, then one `{type:"summary",...}` line.
- `--embedded` — accepted; this milestone is always in-process.
- `--non-interactive` — accepted; the CLI never prompts.
- `--retry-uncertain-shell` — resume only; explicit user approval to retry an interrupted shell that may have had external effects. Without it, an uncertain shell pause exits 5 and is not replayed.
- `--allow-experimental-adapters` — deprecated and ignored; all adapters are official.
- `--fake-script <file>` — test-only fake-agent script for start/run/resume (requires `DEVCHESTRA_ALLOW_FAKE=1`). For `start` it applies to every fake-agent run launched through the API; browser requests cannot inject a script.
- `--force` / `--timeout <secs>` — stop only: stop despite active runs and SIGKILL if the server will not exit; seconds to wait for a clean exit (default 15).
- `--budget-usd N` — rejected in P1; budgets are not enforced by the linear runner.

## Exit codes

`0` succeeded, `1` failed/interrupted, `2` rejected, `3` cancelled, `4` usage/validation/conflict, `5` waiting for a human (uncertain shell or approval), `6` budget/quota stop.

## Recovery

The CLI takes an atomic `devchestra.lock` under the data dir with a token-named owner file containing pid + boot/start identity. A stale lock is reclaimed only when every owner is provably dead; an unknown or unreadable owner fails closed. `doctor` never reclaims a lock.

On SIGINT/SIGTERM the CLI calls `engine.stop()` (resumable shutdown). A hard `SIGKILL` leaves the run recoverable:

```sh
pnpm devchestra resume <runId> --data-dir "$tmp/data" --json
```

## P1 limits

`start → agent → shell → end`, scratch workspaces only, claude-code/codex/opencode/pi adapters (real ones unverified; fake is test-only behind `DEVCHESTRA_ALLOW_FAKE=1`), read-only browser viewer via `devchestra start` when the web app is built, no approval command, no budget enforcement, no worktrees/project writes.
