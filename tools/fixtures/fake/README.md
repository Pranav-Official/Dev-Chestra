# Fake agent fixtures

These fixtures describe Relay's explicit fake profile. They are **not** real
CLI captures and must not be used as evidence for Claude Code, Codex, OpenCode
or Pi behavior. Real CLI fixtures belong under `tools/fixtures/<cli>/` and are
owned by the adapter research work.

- `profile.json`: launch/env/script/checkpoint/stream contract.
- `streams/basic.ndjson`: successful submit example.
- `streams/invalid-then-valid.ndjson`: in-session correction example.
