# Contributing to DevChestra

Single-author repo; this file covers the workflow before a second contributor joins.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm setup:global   # one-time machine setup, safe to re-run
```

Requires Node 22+, pnpm 10.14.0, Git 2.30+. Linux or macOS (native Windows is
experimental on `spike/windows-native`; see `docs/windows-native-spike.md`).

## Gates (run before every PR)

```sh
pnpm check   # biome + typecheck + depcruise + check-browser
pnpm test    # build + full test suites
pnpm build
```

CI (`.github/workflows/ci.yml`) runs `check`, `test` and `build` on Node
22/24 × ubuntu/macos for every push and pull request. `pnpm depcruise` must
stay at 0 violations — the allowlist in `.dependency-cruiser.cjs` mirrors the
real `packages/` layout; if you add or delete a package, update both.

## Conventions

- Package names are `@devchestra/*`; every package exposes `src/index.ts`,
  TypeScript ESM with `NodeNext`.
- Exact dependency pins + `pnpm-lock.yaml`; `pnpm audit --audit-level high`
  must pass.
- Strict TS (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`); no `TODO`/`FIXME`/`console.*` in `src`;
  every `biome-ignore` needs a justification comment.
- `docs/loops.md` documents Repeat-until loops; package READMEs document
  their own surface. Update docs with the code, not after.
