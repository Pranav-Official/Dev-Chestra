# Adapter fixtures (synthetic)

These fixtures are **not live CLI captures**. They are expectations derived
from the pinned help output and the documented stream shapes in the build
inputs. `behaviorVerified` remains false for Claude Code 2.1.310 and Codex
0.164.0 until the bounded live smoke records real evidence.

- `golden/*.json`: expected argv for the adapter `plan()` functions. They
  contain no token values. Cwd/execDir are placeholders (`/work`, `/run`).
- `streams/claude/*.ndjson`, `streams/codex/*.jsonl`, `streams/opencode/*.ndjson`:
  synthetic parser expectations labelled UNVERIFIED. No model output is claimed.
- `streams/fake/*.ndjson`: shape of the explicit Relay fake stream; not a live
  provider capture.

Live captures belong under `tools/fixtures/<cli>/<version>/` and are owned by
the CLI research worker. Do not copy them here as if they were generated.
