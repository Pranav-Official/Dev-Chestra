# Opencode fixtures (synthetic)

These fixtures are **not live CLI captures**. Expectations only:

- `1.19.4/*.txt`: pinned `--version` output plus minimal `models` /
  `models --verbose` shapes derived from the documented format
  (`provider/model` id lines; verbose interleaves pretty-printed JSON with a
  `name` label). No model output is claimed.
- `standin.mjs`: hermetic test double for `opencode --version`,
  `opencode models [--verbose]`, `opencode run --help` and `opencode run --format json`. Driven by
  `STUB_SCENARIO` (JSON) and logs argv to `STUB_LOG`. Never touches the
  network, the real config, or the session database.
  `runHelp` supplies synthetic help text; without an advertised `--standalone`
  option the stand-in rejects that flag, reproducing legacy 1.x behavior.
