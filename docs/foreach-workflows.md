# Foreach fan-out and child workflows

`foreach` runs a body once per item; `workflow` calls another managed workflow as a single node. Both keep the top-level graph acyclic.

## Foreach

- `source`: `{ kind: "expression", expression }` over the outer scope, or `{ kind: "csv", path }` (template, relative workspace path). Source snapshot bound 8 MiB total; each item and per-item result bound 64 KiB.
- `maxItems` 1..1000 (default 1000), `onItemFailure` `stop` (default) / `continue`.
- `body`: exactly one `start` (empty params) + one success `end`; ordinary nodes including `workflow`; no direct loop/foreach nesting v1 (invoke a separate workflow with a loop instead). Loop bodies may contain `workflow` but no `foreach`.
- Body scope: `foreach.item`, `foreach.index` (zero-based), `foreach.number` (one-based), `foreach.total`, `foreach.parent`. Data refs use `foreach.parent.start.*` / `foreach.parent.<nodeId>`. Body `foreach`/`result` ids are reserved.
- `result`: per-item result expression over end ancestors plus `foreach`. `output`: per-item schema.
- Parent envelope: `{ total, processed, succeeded, failed, rejected, resultsRef }`. `resultsRef` points at paginated per-item rows (never hydrated). Empty sources finish natively (`total: 0`).

## Child workflow

- `workflowId`: managed id (`^[a-z0-9-]{1,64}$`). `inputs`: bare JSONata per target param (keys checked only when the target definition resolves). `output`: optional successful child-result schema (untyped = unknown whole result, typed = `result` properties).
- Envelope: `{ childRunId, status: succeeded|failed|rejected, result|null }`. Plain edge = success; `.failed` handles child failed/rejected; no `.cancelled`.
- Freeze: definitions freeze recursively before side effects via the project-bound resolver (same project, depth <= 8, total <= 32, cycle-checked). Missing children fail explicitly (`E_NOT_SUPPORTED`/`E_NOT_FOUND`), never silently. Loops may live inside the *called* workflow; they must not nest directly in the caller body.
- Inspection: parent-child provenance and foreach items are paginated ref lists (`GET /api/runs/:id/children`, `GET /api/runs/:id/foreach/:sourceId/items`), no giant hydrated payloads.
