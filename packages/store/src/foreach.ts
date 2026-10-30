import type { ExecutionIdentity, Path, RunId } from "@devchestra/core";
import { canonicalJson } from "@devchestra/core";
import { hashJsonSync } from "./hash.js";
import { assertRunActive } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import { fail, parseJson } from "./util.js";

export const FOREACH_MAX_ITEMS = 1000;
export const FOREACH_MIN_ITEMS = 1;
/**
 * Total snapshot cap (8 MiB ≈ 1000 ordinary job descriptions).
 * Expression-array sources never reach this: the schema evaluator caps
 * expression results at 64 KiB independently, so only CSV/file sources
 * use the larger budget.
 */
const SOURCE_BYTES_CAP = 8 * 1024 * 1024;
/**
 * Independent per-item bound (64 KiB). Foreach items are not loop state:
 * the 16 KiB loop-state cap does not apply here, so long job descriptions
 * fit while the total snapshot cap still bounds the source as a whole.
 */
const VALUE_BYTES_CAP = 64 * 1024;

export interface CreateSourceInput {
  identity: ExecutionIdentity;
  kind: "expression" | "csv";
  items: unknown[];
  maxItems: number;
  /** Immutable parent capture id (context_captures); reused on resume, never recaptured. */
  parentCaptureId?: string;
}

export interface ForeachSource {
  id: string;
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  kind: "expression" | "csv";
  sourceHash: string;
  total: number;
  maxItems: number;
  items: unknown[];
  parentCaptureId: string | null;
}

export interface ForeachItem {
  sourceId: string;
  index: number;
  status: "succeeded" | "failed" | "rejected" | "skipped";
  result: unknown;
  outputId: string | null;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

/** Immutable snapshot of the resolved source. Idempotent per attempt: same attempt reuses the row. */
export function createForeachSource(
  runtime: Runtime,
  input: CreateSourceInput,
): { source: ForeachSource; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > FOREACH_MAX_ITEMS
  ) {
    fail("E_VALIDATION", "foreach maxItems must be an integer between 1 and 1000");
  }
  if (input.items.length > input.maxItems) {
    fail(
      "E_VALIDATION",
      `foreach source has ${input.items.length} items exceeding maxItems ${input.maxItems}`,
    );
  }
  const existing = runtime.db
    .prepare("SELECT id FROM foreach_sources WHERE run_id = ? AND path = ? AND attempt = ?")
    .get(input.identity.runId, input.identity.path, input.identity.attempt) as
    | { id: string }
    | undefined;
  if (existing) {
    const found = getForeachSource(runtime, existing.id);
    if (found) return { source: found, duplicate: true };
  }
  for (const [index, item] of input.items.entries()) {
    const size = byteSize(item);
    if (size > VALUE_BYTES_CAP) {
      fail("E_VALIDATION", `foreach item ${index} exceeds the 64 KiB bound`, {
        index,
        bytes: size,
      });
    }
  }
  const totalText = canonicalJson(input.items);
  if (Buffer.byteLength(totalText, "utf8") > SOURCE_BYTES_CAP) {
    fail("E_VALIDATION", "foreach source exceeds the 8 MiB snapshot bound");
  }
  const finding = runtime.secrets.scanValue(input.items);
  if (finding) {
    fail("E_VALIDATION", "foreach source contains a secret; remove it before starting", {
      path: finding.path,
    });
  }
  const sourceHash = hashJsonSync(input.items);
  const id = `fs_${hashJsonSync({ run: input.identity.runId, path: input.identity.path, attempt: input.identity.attempt, hash: sourceHash }).slice(0, 32)}`;
  const already = runtime.db.prepare("SELECT id FROM foreach_sources WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (already) {
    const found = getForeachSource(runtime, id);
    if (found) return { source: found, duplicate: true };
  }
  runtime.db
    .prepare(
      `INSERT INTO foreach_sources (id, run_id, path, attempt, generation, kind, source_hash, total, max_items, bytes, json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
      input.kind,
      sourceHash,
      input.items.length,
      input.maxItems,
      Buffer.byteLength(totalText, "utf8"),
      totalText,
      now(runtime),
    );
  try {
    runtime.db
      .prepare("UPDATE foreach_sources SET parent_capture_id = ? WHERE id = ?")
      .run(input.parentCaptureId ?? null, id);
  } catch {
    // Column added by migration 0008; ignore on older test DBs (falls back to live scope).
  }
  const source = getForeachSource(runtime, id);
  if (!source) fail("E_INTERNAL", "Foreach source disappeared inside its transaction");
  return { source: source as ForeachSource, duplicate: false };
}

export function getForeachSource(runtime: Runtime, sourceId: string): ForeachSource | null {
  const row = runtime.db.prepare("SELECT * FROM foreach_sources WHERE id = ?").get(sourceId) as
    | {
        id: string;
        run_id: string;
        path: string;
        attempt: number;
        generation: number;
        kind: string;
        source_hash: string;
        total: number;
        max_items: number;
        json: string;
        parent_capture_id?: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.kind !== "expression" && row.kind !== "csv")
    fail("E_INTERNAL", "Stored foreach source kind is corrupt");
  return {
    id: row.id,
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    kind: row.kind,
    sourceHash: row.source_hash,
    total: row.total,
    maxItems: row.max_items,
    items: parseJson<unknown[]>(row.json),
    parentCaptureId: (row.parent_capture_id ?? null) as string | null,
  };
}

/** Resume lookup: the immutable snapshot for this controller attempt, if already resolved. */
export function getForeachSourceByAttempt(
  runtime: Runtime,
  runId: RunId,
  path: Path,
  attempt: number,
): ForeachSource | null {
  const row = runtime.db
    .prepare("SELECT id FROM foreach_sources WHERE run_id = ? AND path = ? AND attempt = ?")
    .get(runId, path, attempt) as { id: string } | undefined;
  if (!row) return null;
  return getForeachSource(runtime, row.id);
}

export function recordForeachItem(
  runtime: Runtime,
  sourceId: string,
  index: number,
  status: ForeachItem["status"],
  result: unknown,
): { duplicate: boolean } {
  const source = getForeachSource(runtime, sourceId);
  if (!source) fail("E_NOT_FOUND", `Foreach source ${sourceId} does not exist`);
  if (!Number.isSafeInteger(index) || index < 0 || index >= (source as ForeachSource).total) {
    fail("E_VALIDATION", "foreach item index is out of range", { index });
  }
  if (result !== undefined && result !== null) {
    const size = byteSize(result);
    if (size > VALUE_BYTES_CAP)
      fail("E_VALIDATION", `foreach result ${index} exceeds the 64 KiB bound`);
    const finding = runtime.secrets.scanValue(result);
    if (finding) fail("E_VALIDATION", "foreach result contains a secret", { path: finding.path });
  }
  const existing = runtime.db
    .prepare("SELECT status FROM foreach_items WHERE source_id = ? AND idx = ?")
    .get(sourceId, index) as { status: string } | undefined;
  if (existing) return { duplicate: true };
  // Strict ordering: index must equal the decided count so far (no gaps, no concurrent writers).
  const count = runtime.db
    .prepare("SELECT COUNT(*) AS n FROM foreach_items WHERE source_id = ?")
    .get(sourceId) as { n: number };
  if (count.n !== index) {
    fail("E_CONFLICT", "foreach item index must equal the decided count", {
      expected: count.n,
      received: index,
    });
  }
  // Durable per-item output row so API/UI consumers can resolve output_id via
  // the standard outputs read path (/runs/:runId/outputs/:outputId).
  let itemOutputId: string | null = null;
  if (result !== undefined && result !== null) {
    const outputId = runtime.idGen.entryId();
    const outputText = JSON.stringify(result);
    runtime.db
      .prepare(
        `INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at)
         VALUES (?, ?, ?, ?, ?, 'map_result', ?, ?, ?, ?)`,
      )
      .run(
        outputId,
        (source as ForeachSource).runId,
        `${(source as ForeachSource).path}[${index}]`,
        (source as ForeachSource).attempt,
        (source as ForeachSource).generation,
        hashJsonSync(result),
        Buffer.byteLength(outputText, "utf8"),
        outputText,
        now(runtime),
      );
    itemOutputId = outputId;
  }
  runtime.db
    .prepare(
      "INSERT INTO foreach_items (source_id, idx, status, result_json, output_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      sourceId,
      index,
      status,
      result === undefined ? null : JSON.stringify(result),
      itemOutputId,
      now(runtime),
    );
  return { duplicate: false };
}

export interface ForeachSourceMeta {
  id: string;
  runId: RunId;
  path: Path;
  kind: "expression" | "csv";
  sourceHash: string;
  total: number;
  maxItems: number;
}

/** Metadata-only read: never parses the (up to 8 MiB) items snapshot. */
export function getForeachSourceMeta(runtime: Runtime, sourceId: string): ForeachSourceMeta | null {
  const row = runtime.db
    .prepare(
      "SELECT id, run_id, path, kind, source_hash, total, max_items FROM foreach_sources WHERE id = ?",
    )
    .get(sourceId) as
    | {
        id: string;
        run_id: string;
        path: string;
        kind: string;
        source_hash: string;
        total: number;
        max_items: number;
      }
    | undefined;
  if (!row) return null;
  if (row.kind !== "expression" && row.kind !== "csv")
    fail("E_INTERNAL", "Stored foreach source kind is corrupt");
  return {
    id: row.id,
    runId: row.run_id as RunId,
    path: row.path as Path,
    kind: row.kind,
    sourceHash: row.source_hash,
    total: row.total,
    maxItems: row.max_items,
  };
}

export interface ForeachItemRef {
  index: number;
  status: ForeachItem["status"];
  outputId: string | null;
}

/** Bounded item refs for pagination: never selects result_json. */
export function listForeachItemRefs(
  runtime: Runtime,
  sourceId: string,
  options?: { offset?: number; limit?: number },
): ForeachItemRef[] {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("E_VALIDATION", "offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("E_VALIDATION", "limit must be an integer between 1 and 100");
  }
  const rows = runtime.db
    .prepare(
      "SELECT idx, status, output_id FROM foreach_items WHERE source_id = ? ORDER BY idx ASC LIMIT ? OFFSET ?",
    )
    .all(sourceId, limit, offset) as { idx: number; status: string; output_id: string | null }[];
  return rows.map((row) => ({
    index: row.idx,
    status: row.status as ForeachItem["status"],
    outputId: row.output_id,
  }));
}
export function listForeachItems(runtime: Runtime, sourceId: string): ForeachItem[] {
  const rows = runtime.db
    .prepare(
      "SELECT idx, status, result_json, output_id FROM foreach_items WHERE source_id = ? ORDER BY idx ASC",
    )
    .all(sourceId) as {
    idx: number;
    status: string;
    result_json: string | null;
    output_id: string | null;
  }[];
  return rows.map((row) => ({
    sourceId,
    index: row.idx,
    status: row.status as ForeachItem["status"],
    result: row.result_json === null ? null : parseJson(row.result_json),
    outputId: row.output_id,
  }));
}

export function countForeachItems(runtime: Runtime, sourceId: string): number {
  const row = runtime.db
    .prepare("SELECT COUNT(*) AS n FROM foreach_items WHERE source_id = ?")
    .get(sourceId) as { n: number };
  return row.n;
}
