import { now, type Runtime } from "./runtime.js";
import type { ContextEntryRecord, UpsertContextEntryInput } from "./types.js";
import { fail, parseJson } from "./util.js";

export const CONTEXT_POOL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CONTEXT_POOL_VALUE_MAX_BYTES = 4 * 1024;
export const CONTEXT_POOL_TOTAL_MAX_BYTES = 32 * 1024;
export const CONTEXT_POOL_MAX_ENTRIES = 128;

interface ContextRow {
  run_id: string;
  key: string;
  value_json: string;
  updated_by_path: string;
  updated_at: number;
  version: number;
}

function mapRow(row: ContextRow): ContextEntryRecord {
  return {
    runId: row.run_id as ContextEntryRecord["runId"],
    key: row.key,
    value: parseJson<unknown>(row.value_json) as string,
    updatedByPath: row.updated_by_path,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function requireRunMatches(runtime: Runtime, runId: string): void {
  const row = runtime.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
  if (!row) fail("E_NOT_FOUND", `Run ${runId} does not exist`);
}

function checkedKey(key: unknown): string {
  if (typeof key !== "string" || !CONTEXT_POOL_KEY_PATTERN.test(key)) {
    fail(
      "E_VALIDATION",
      "Context key must match [A-Za-z0-9._-] (1-64 chars), starting alphanumeric",
    );
  }
  return key;
}

function checkedValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("E_VALIDATION", "Context value must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > CONTEXT_POOL_VALUE_MAX_BYTES) {
    fail("E_VALIDATION", "Context value exceeds the 4 KiB entry cap", {
      bytes: Buffer.byteLength(value, "utf8"),
      limit: CONTEXT_POOL_VALUE_MAX_BYTES,
    });
  }
  return value;
}

/**
 * Mutable run-scoped blackboard. Last writer wins per key; history lives in
 * the `context.written` events appended by the caller, not here. All writes
 * run inside the caller's Store.tx; secret values are rejected before any write.
 */
export function upsertContextEntry(
  runtime: Runtime,
  input: UpsertContextEntryInput,
): ContextEntryRecord {
  requireRunMatches(runtime, input.runId);
  const key = checkedKey(input.key);
  const mode = input.mode ?? "upsert";
  if (mode !== "upsert" && mode !== "append" && mode !== "delete") {
    fail(
      "E_VALIDATION",
      `Unknown context write mode '${String((input as { mode?: unknown }).mode)}'`,
    );
  }

  const existing = runtime.db
    .prepare("SELECT * FROM context_entries WHERE run_id = ? AND key = ?")
    .get(input.runId, key) as ContextRow | undefined;

  if (mode === "delete") {
    if (existing !== undefined) {
      runtime.db
        .prepare("DELETE FROM context_entries WHERE run_id = ? AND key = ?")
        .run(input.runId, key);
    }
    return {
      runId: input.runId,
      key,
      value: "",
      updatedByPath: input.updatedByPath,
      updatedAt: now(runtime),
      version: (existing?.version ?? 0) + 1,
    };
  }

  const incoming = checkedValue(input.value);
  const finding = runtime.secrets.scanValue(incoming);
  if (finding) {
    fail("E_VALIDATION", "Context value contains a registered secret; refusing to store it", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }

  const next =
    mode === "append" && existing !== undefined
      ? `${mapRow(existing).value}\n${incoming}`
      : incoming;
  if (Buffer.byteLength(next, "utf8") > CONTEXT_POOL_VALUE_MAX_BYTES) {
    fail("E_VALIDATION", "Context value exceeds the 4 KiB entry cap after append", {
      limit: CONTEXT_POOL_VALUE_MAX_BYTES,
    });
  }

  const rows = runtime.db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value_json)), 0) AS bytes FROM context_entries WHERE run_id = ?",
    )
    .get(input.runId) as { n: number; bytes: number };
  const existingBytes = existing === undefined ? 0 : Buffer.byteLength(existing.value_json, "utf8");
  const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
  if ((rows.n ?? 0) + (existing === undefined ? 1 : 0) > CONTEXT_POOL_MAX_ENTRIES) {
    fail("E_VALIDATION", "Run context pool exceeds the entry limit", {
      limit: CONTEXT_POOL_MAX_ENTRIES,
    });
  }
  if ((rows.bytes ?? 0) - existingBytes + nextBytes > CONTEXT_POOL_TOTAL_MAX_BYTES) {
    fail("E_VALIDATION", "Run context pool exceeds 32 KiB in total", {
      limit: CONTEXT_POOL_TOTAL_MAX_BYTES,
    });
  }

  const updatedAt = now(runtime);
  const version = (existing?.version ?? 0) + 1;
  runtime.db
    .prepare(
      `INSERT INTO context_entries (run_id, key, value_json, updated_by_path, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by_path = excluded.updated_by_path,
         updated_at = excluded.updated_at,
         version = excluded.version`,
    )
    .run(input.runId, key, JSON.stringify(next), input.updatedByPath, updatedAt, version);
  return {
    runId: input.runId,
    key,
    value: next,
    updatedByPath: input.updatedByPath,
    updatedAt,
    version,
  };
}

export function getContextEntry(
  runtime: Runtime,
  runId: string,
  key: string,
): ContextEntryRecord | null {
  const row = runtime.db
    .prepare("SELECT * FROM context_entries WHERE run_id = ? AND key = ?")
    .get(runId, checkedKey(key)) as ContextRow | undefined;
  return row === undefined ? null : mapRow(row);
}

export function listContextEntries(runtime: Runtime, runId: string): ContextEntryRecord[] {
  const rows = runtime.db
    .prepare("SELECT * FROM context_entries WHERE run_id = ? ORDER BY key ASC")
    .all(runId) as ContextRow[];
  return rows.map(mapRow);
}
