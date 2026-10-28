# Engine fixtures

Trusted, deterministic P1 engine fixtures. They are not live-CLI evidence.

- `linear-research.json` — normalized `start -> agent -> shell -> end` workflow used by
  the engine unit tests and smoke scripts.
- `linear-smoke.ts` — one happy-path run through the real store, loopback gateway, MCP
  shim and fake-agent child. Run after the workspace packages are built:

  ```sh
  pnpm exec tsx tools/fixtures/engine/linear-smoke.ts
  ```

- `scenarios.ts` — targeted failure/lifecycle scenarios: invalid then valid submission,
  bounded no-submit, validation exhaustion, crash cap, accepted-then-crash, shell
  failure/allow-failure/quoting, timeout crash budget, graceful shutdown and resume,
  cancellation with token revocation, uncertain shell override, params and unsupported
  mode rejection.

  ```sh
  pnpm exec tsx tools/fixtures/engine/scenarios.ts
  ```

Both scripts create temporary directories, stores and loopback listeners, and use the
real `@devchestra/mcp` stdio shim plus `tools/fake-agent`. They make no paid model calls.
The fake script is supplied by the caller through the adapter registry, never by a
workflow's `cliOptions`.
