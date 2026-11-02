# @devchestra/decisions

System One decision-model provider client. Fixed provider
presets (Jev, Clef, Clef-flash), secret loading, the intersection wire format,
and a fetch-based HTTP client with retries and a per-provider concurrency cap.

Server-only: this package reads `process.env` / `.env` key material and must
never be bundled for the browser. `apps/web` may not import it (enforced by
`.dependency-cruiser.cjs`).

## Entrypoints

Everything public is re-exported from `src/index.ts`. Modules:

- `presets.ts` — `DECISION_PRESETS: Record<DecisionProviderId, DecisionPreset>`
  (URL template, auth env names, body model string, per-call timeout).
- `secrets.ts` — `loadDecisionSecrets()` (`process.env` first, then a cwd
  `.env` parsed with `node:util` `parseEnv`; only the three allowlisted names;
  never mutates `process.env`; reports missing NAMES only).
- `wire.ts` — `buildDecisionBody()` (intersection request format) and
  `parseDecisionPayload()` (bare or `{ result }`-wrapped responses,
  data-driven candidate fields, normalization incl. refusals).
- `http.ts` — timeout/abort fetch, `redirect: "error"`, https-only (loopback
  `http` only via the injected test override), 1 MiB cap, 429/5xx retries,
  redacted errors.
- `client.ts` — `createDecisionClient()` / `createDecisionService()`
  implementing `DecisionClient` (`ask`, `availability`, `test`).

## Tests

`pnpm --filter @devchestra/decisions test`. Unit tests use stub `fetch`
implementations; integration tests use the loopback stand-in at
`tools/fixtures/decisions/standin.mjs` (fake keys only, no live network).
