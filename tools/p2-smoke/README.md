# @relay/p2-smoke

Bounded P2 acceptance driver. It starts the real CLI (`relay start`) as an
owned child with a temporary data directory, real SQLite, the real MCP shim and
the real fake agent, then drives the browser API, SSE and the built web app.
No route handler is mocked, no paid model CLI is called and no user/global
configuration is touched.

## Commands

```sh
pnpm --filter @relay/p2-smoke typecheck
pnpm --filter @relay/p2-smoke test        # live API/SSE + paging + security
pnpm --filter @relay/p2-smoke test:e2e    # Playwright viewer/replay/theme/axe
pnpm --filter @relay/p2-smoke demo        # all scenarios, JSON summary
```

Missing build outputs (`packages/cli/dist`, `apps/web/dist`,
`packages/mcp/dist/bin/shim.js`, `tools/fake-agent/dist/main.js`) or Chromium
fail the run; they never pass or skip. Chromium is taken from
`RELAY_CHROMIUM_PATH` or `/usr/bin/chromium`, launched headless with a temporary
profile.

The demo prints screenshot paths under `tools/p2-smoke/artifacts/<timestamp>/`.
It never prints the session token.

## Cleanup

Every scenario records the launched process identity (pid + canonical pidStart,
reused from `@relay/adapters`) and every `node.process.spawned` agent identity.
Cleanup stops only those owned processes/groups. A sentinel process is started
before each scenario and asserted alive after cleanup. Timeout uses the same
path and fails rather than leaving an agent or server behind.

## Not claimed by this driver

- SSE queue overflow at the production limit (5000) is not reachable through the
  public browser server; the stream hub owns the bounded queueLimit test.
- Live Claude/Codex runs, paid model calls and release packaging are out of
  scope.
- macOS browser execution is CI-configured, not locally executed.
