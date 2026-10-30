import {
  type EventType,
  type Path,
  project,
  RUN_STATUSES,
  type RunId,
  type RunStatus,
  type RunView,
} from "@devchestra/core";
import {
  decodeEventsCursor,
  decodeOutputsCursor,
  decodeRunsCursor,
  encodeCursor,
  escapeLikePrefix,
  pageLimit,
  queryFingerprint,
} from "./cursor.js";
import { getExecution } from "./executions.js";
import { type EventRow, normalizeCachedView, requireRun, rowToEnvelope } from "./projection.js";
import { getRun } from "./runs.js";
import { type Runtime, withReadTx } from "./runtime.js";
import type {
  EventPage,
  EventPageOptions,
  ExecutionAttemptHistory,
  ExecutionHistory,
  OutputKind,
  OutputProvenancePage,
  OutputProvenanceQuery,
  OutputRecord,
  ProcessHistory,
  RunListFilters,
  RunListPage,
  RunSnapshot,
  RunSummary,
  TranscriptHistory,
} from "./types.js";
import { fail, parseJson } from "./util.js";

const OUTPUT_KINDS: readonly OutputKind[] = ["output", "input", "map_result", "loop_carry"];
const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

function normalizeRunStatuses(
  input: RunStatus | readonly RunStatus[] | undefined,
): RunStatus[] | null {
  if (input === undefined) return null;
  const raw = typeof input === "string" ? [input] : [...input];
  if (raw.length === 0) return null;
  const unique = [...new Set(raw)];
  for (const status of unique) {
    if (!RUN_STATUS_SET.has(status)) fail("E_VALIDATION", `Unknown run status ${status}`);
  }
  return unique.sort();
}

interface RunSummaryRow {
  archived_at: number | null;
  workflow_name?: string | null;
  id: string;
  project_id: string;
  project_name: string;
  project_path: string;
  project_kind: "git" | "folder";
  workflow_id: string;
  workflow_hash: string;
  run_number: number;
  kind: "run" | "node_test";
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  pause_reason: string | null;
  cost_usd: number;
  tokens: number;
  active_ms: number;
  paused_ms: number;
}

function mapRunSummary(row: RunSummaryRow): RunSummary {
  return {
    archivedAt: row.archived_at,
    ...(row.workflow_name === undefined ? {} : { workflowName: row.workflow_name }),
    id: row.id as RunId,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    projectKind: row.project_kind,
    workflowId: row.workflow_id,
    workflowHash: row.workflow_hash,
    runNumber: row.run_number,
    kind: row.kind,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    pauseReason: row.pause_reason,
    costUsd: row.cost_usd,
    tokens: row.tokens,
    activeMs: row.active_ms,
    pausedMs: row.paused_ms,
  };
}

export function listRuns(runtime: Runtime, filters: RunListFilters = {}): RunListPage {
  const statuses = normalizeRunStatuses(filters.status);
  const query = {
    kind: "runs" as const,
    projectId: filters.projectId ?? null,
    workflowId: filters.workflowId ?? null,
    status: statuses,
    archived: filters.archived ?? false,
  };
  const fingerprint = queryFingerprint(query);
  const limit = pageLimit(filters.limit);

  const where: string[] = [
    filters.archived ? "r.archived_at IS NOT NULL" : "r.archived_at IS NULL",
    "p.removed_at IS NULL",
  ];
  const params: unknown[] = [];
  if (filters.projectId !== undefined) {
    where.push("r.project_id = ?");
    params.push(filters.projectId);
  }
  if (filters.workflowId !== undefined) {
    where.push("r.workflow_id = ?");
    params.push(filters.workflowId);
  }
  if (statuses !== null) {
    where.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  if (filters.cursor !== undefined) {
    const cursor = decodeRunsCursor(filters.cursor);
    if (cursor.q !== fingerprint) {
      fail("E_VALIDATION", "Run list cursor does not belong to this query");
    }
    const anchor = runtime.db.prepare("SELECT created_at FROM runs WHERE id = ?").get(cursor.i) as
      | { created_at: number }
      | undefined;
    if (!anchor || anchor.created_at !== cursor.c) {
      fail("E_CONFLICT", "Run list cursor is stale or ahead of the current list");
    }
    where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    params.push(cursor.c, cursor.c, cursor.i);
  }

  const rows = runtime.db
    .prepare(
      `SELECT r.id, r.project_id, p.name AS project_name, p.path AS project_path,
              p.kind AS project_kind, r.workflow_id, r.workflow_hash, r.run_number,
              r.kind, r.status, r.created_at, r.started_at, r.ended_at, r.pause_reason,
              r.cost_usd, r.tokens, r.active_ms, r.paused_ms, r.archived_at
         FROM runs r JOIN projects p ON p.id = r.project_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as RunSummaryRow[];

  const items = rows.slice(0, limit).map(mapRunSummary);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({ v: 1, k: "runs", q: fingerprint, c: last.createdAt, i: last.id })
      : null;
  return { items, nextCursor };
}

/** Bounded lightweight rows per workflow; never loads frozen snapshots into JS. */
export function workflowRunSummaries(runtime: Runtime, projectId: string): RunSummary[] {
  const rows = runtime.db
    .prepare(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY created_at DESC, id DESC) AS position
      FROM runs WHERE project_id = ? AND archived_at IS NULL
    )
    SELECT r.id, r.project_id, p.name AS project_name, p.path AS project_path,
      p.kind AS project_kind, r.workflow_id, r.workflow_hash, r.run_number,
      r.kind, r.status, r.created_at, r.started_at, r.ended_at, r.pause_reason,
      r.cost_usd, r.tokens, r.active_ms, r.paused_ms, r.archived_at,
      CASE WHEN json_type(r.snapshot_json, '$.name') = 'text' THEN json_extract(r.snapshot_json, '$.name') ELSE NULL END AS workflow_name
    FROM ranked JOIN runs r ON r.id = ranked.id JOIN projects p ON p.id = r.project_id
    WHERE ranked.position <= 3 AND p.removed_at IS NULL
    ORDER BY r.workflow_id, r.created_at DESC, r.id DESC
  `)
    .all(projectId) as RunSummaryRow[];
  return rows.map(mapRunSummary);
}

export function snapshotRun(runtime: Runtime, runId: RunId): RunSnapshot {
  return withReadTx(runtime, () => {
    requireRun(runtime, runId);
    const run = getRun(runtime, runId);
    if (run === null) fail("E_INTERNAL", `Run ${runId} disappeared during snapshot`);

    const marker = runtime.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE run_id = ?")
      .get(runId) as { id: number };
    const watermark = Number(marker.id);

    const stored = runtime.db
      .prepare("SELECT view_json, last_event_id FROM run_views WHERE run_id = ?")
      .get(runId) as { view_json: string; last_event_id: number } | undefined;

    let view: RunView;
    if (stored !== undefined && stored.last_event_id === watermark) {
      view = normalizeCachedView(parseJson<RunView>(stored.view_json));
    } else {
      const rows = runtime.db
        .prepare("SELECT * FROM events WHERE run_id = ? AND id <= ? ORDER BY id ASC")
        .all(runId, watermark) as EventRow[];
      view = project(rows.map(rowToEnvelope));
    }
    return { runId, run, view, watermark };
  });
}

function normalizeEventTypes(input: readonly EventType[] | undefined): string[] | null {
  if (input === undefined) return null;
  if (input.length > 100) fail("E_VALIDATION", "types may contain at most 100 entries");
  const unique: string[] = [];
  for (const type of input) {
    if (typeof type !== "string" || type.length === 0 || type.length > 128) {
      fail("E_VALIDATION", "types must contain non-empty event type strings");
    }
    if (!unique.includes(type)) unique.push(type);
  }
  unique.sort();
  return unique.length === 0 ? null : unique;
}

export function pageEvents(
  runtime: Runtime,
  runId: RunId,
  options: EventPageOptions = {},
): EventPage {
  requireRun(runtime, runId);
  const types = normalizeEventTypes(options.types);
  const pathPrefix = options.pathPrefix;
  if (
    pathPrefix !== undefined &&
    (typeof pathPrefix !== "string" || pathPrefix.length > 4096 || pathPrefix.includes("\0"))
  ) {
    fail("E_VALIDATION", "pathPrefix must be a string without NUL");
  }
  const limit = pageLimit(options.limit);
  const cursor = options.cursor === undefined ? null : decodeEventsCursor(options.cursor);
  if (cursor !== null && options.after !== undefined) {
    fail("E_VALIDATION", "Use after or cursor, not both");
  }
  if (cursor !== null && cursor.r !== runId) {
    fail("E_VALIDATION", "Event cursor belongs to a different run");
  }
  if (options.upTo !== undefined && (!Number.isSafeInteger(options.upTo) || options.upTo < 0)) {
    fail("E_VALIDATION", "upTo must be a non-negative safe integer");
  }
  const effectiveUpTo =
    cursor === null ? (options.upTo ?? null) : (cursor.u ?? options.upTo ?? null);
  const fingerprint = queryFingerprint({
    kind: "events",
    runId,
    types,
    pathPrefix: pathPrefix ?? null,
    upTo: effectiveUpTo,
  });
  if (cursor !== null && cursor.q !== fingerprint) {
    fail("E_VALIDATION", "Event cursor does not belong to this run/query");
  }

  const after = cursor === null ? (options.after ?? 0) : cursor.a;
  if (!Number.isSafeInteger(after) || after < 0) {
    fail("E_VALIDATION", "after must be a non-negative safe integer");
  }
  const marker = runtime.db
    .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE run_id = ?")
    .get(runId) as { id: number };
  const watermark = Number(marker.id);

  if (after > watermark) fail("E_CONFLICT", "Event cursor is in the future");
  if (after > 0) {
    const exists = runtime.db
      .prepare("SELECT 1 AS present FROM events WHERE id = ? AND run_id = ?")
      .get(after, runId) as { present: number } | undefined;
    if (!exists) fail("E_CONFLICT", "Event cursor is stale or belongs to another run");
  }
  if (effectiveUpTo !== null) {
    if (effectiveUpTo > watermark) fail("E_CONFLICT", "upTo is beyond the run watermark");
    if (effectiveUpTo < after) fail("E_VALIDATION", "upTo must not be before after");
  }

  const where = ["run_id = ?", "id > ?", "id <= ?"];
  const params: unknown[] = [runId, after, effectiveUpTo ?? watermark];
  if (pathPrefix !== undefined) {
    where.push("path LIKE ? ESCAPE '\\'");
    params.push(`${escapeLikePrefix(pathPrefix)}%`);
  }
  if (types !== null) {
    where.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }

  const rows = runtime.db
    .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as EventRow[];
  const items = rows.slice(0, limit).map(rowToEnvelope);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({
          v: 1,
          k: "events",
          q: fingerprint,
          r: runId,
          a: last.id,
          u: effectiveUpTo,
        })
      : null;
  return {
    items,
    nextCursor,
    nextAfter: last === undefined ? null : last.id,
    watermark,
  };
}

interface OutputDbRow {
  id: string;
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  kind: string;
  hash: string;
  bytes: number;
  json: string;
  created_at: number;
}

function mapOutput(row: OutputDbRow): OutputRecord {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    kind: row.kind as OutputKind,
    hash: row.hash,
    bytes: row.bytes,
    json: parseJson(row.json),
    createdAt: row.created_at,
  };
}

function normalizeKinds(
  input: OutputKind | readonly OutputKind[] | undefined,
): OutputKind[] | null {
  if (input === undefined) return null;
  const raw = typeof input === "string" ? [input] : [...input];
  if (raw.length === 0) return null;
  const unique = [...new Set(raw)];
  for (const kind of unique) {
    if (!OUTPUT_KINDS.includes(kind)) fail("E_VALIDATION", `Unknown output kind ${kind}`);
  }
  return unique.sort();
}

export interface OutputMetadataRow {
  id: string;
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  kind: string;
  hash: string;
  bytes: number;
  created_at: number;
}

function mapMetadata(row: OutputMetadataRow): import("./types.js").OutputMetadata {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    kind: row.kind as import("./types.js").OutputKind,
    hash: row.hash,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

export function getOutputMetadataById(runtime: Runtime, id: string): import("./types.js").OutputMetadata | null {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    fail("E_VALIDATION", "output id must be a non-empty string");
  }
  const row = runtime.db
    .prepare(
      "SELECT id, run_id, path, attempt, generation, kind, hash, bytes, created_at FROM outputs WHERE id = ?",
    )
    .get(id) as OutputMetadataRow | undefined;
  return row === undefined ? null : mapMetadata(row);
}

/** Metadata-only listing; never loads/parses full output JSON. */
export function listOutputsMetadata(
  runtime: Runtime,
  query: OutputProvenanceQuery,
): import("./types.js").OutputMetadataPage {
  requireRun(runtime, query.runId);
  const kinds = normalizeKinds(query.kind);
  const fingerprint = queryFingerprint({
    kind: "outputs-meta",
    runId: query.runId,
    path: query.path ?? null,
    attempt: query.attempt ?? null,
    generation: query.generation ?? null,
    kinds,
  });
  const limit = pageLimit(query.limit);
  const where = ["run_id = ?"];
  const params: unknown[] = [query.runId];
  if (query.path !== undefined) {
    where.push("path = ?");
    params.push(query.path);
  }
  if (query.attempt !== undefined) {
    where.push("attempt = ?");
    params.push(query.attempt);
  }
  if (query.generation !== undefined) {
    where.push("generation = ?");
    params.push(query.generation);
  }
  if (kinds !== null) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (query.cursor !== undefined) {
    const cursor = decodeOutputsCursor(query.cursor);
    if (cursor.q !== fingerprint) fail("E_VALIDATION", "Output cursor does not belong to this query");
    const anchor = runtime.db.prepare("SELECT created_at FROM outputs WHERE id = ?").get(cursor.i) as { created_at: number } | undefined;
    if (!anchor || anchor.created_at !== cursor.c) fail("E_CONFLICT", "Output cursor is stale or ahead of the current list");
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.c, cursor.c, cursor.i);
  }
  const rows = runtime.db
    .prepare(
      `SELECT id, run_id, path, attempt, generation, kind, hash, bytes, created_at FROM outputs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as OutputMetadataRow[];
  const items = rows.slice(0, limit).map(mapMetadata);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({ v: 1, k: "outputs", q: fingerprint, c: last.createdAt, i: last.id })
      : null;
  return { items, nextCursor };
}

export function getOutputById(runtime: Runtime, id: string): OutputRecord | null {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    fail("E_VALIDATION", "output id must be a non-empty string");
  }
  const row = runtime.db.prepare("SELECT * FROM outputs WHERE id = ?").get(id) as
    | OutputDbRow
    | undefined;
  return row === undefined ? null : mapOutput(row);
}

export function listOutputsByProvenance(
  runtime: Runtime,
  query: OutputProvenanceQuery,
): OutputProvenancePage {
  requireRun(runtime, query.runId);
  for (const [name, value] of [
    ["attempt", query.attempt],
    ["generation", query.generation],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      fail("E_VALIDATION", `${name} must be a positive safe integer`);
    }
  }
  const kinds = normalizeKinds(query.kind);
  const fingerprint = queryFingerprint({
    kind: "outputs",
    runId: query.runId,
    path: query.path ?? null,
    attempt: query.attempt ?? null,
    generation: query.generation ?? null,
    kinds,
  });
  const limit = pageLimit(query.limit);

  const where = ["run_id = ?"];
  const params: unknown[] = [query.runId];
  if (query.path !== undefined) {
    where.push("path = ?");
    params.push(query.path);
  }
  if (query.attempt !== undefined) {
    where.push("attempt = ?");
    params.push(query.attempt);
  }
  if (query.generation !== undefined) {
    where.push("generation = ?");
    params.push(query.generation);
  }
  if (kinds !== null) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (query.cursor !== undefined) {
    const cursor = decodeOutputsCursor(query.cursor);
    if (cursor.q !== fingerprint) {
      fail("E_VALIDATION", "Output cursor does not belong to this query");
    }
    const anchor = runtime.db
      .prepare("SELECT created_at FROM outputs WHERE id = ?")
      .get(cursor.i) as { created_at: number } | undefined;
    if (!anchor || anchor.created_at !== cursor.c) {
      fail("E_CONFLICT", "Output cursor is stale or ahead of the current list");
    }
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.c, cursor.c, cursor.i);
  }

  const rows = runtime.db
    .prepare(
      `SELECT * FROM outputs WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as OutputDbRow[];
  const items = rows.slice(0, limit).map(mapOutput);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({ v: 1, k: "outputs", q: fingerprint, c: last.createdAt, i: last.id })
      : null;
  return { items, nextCursor };
}

interface HistoryRow {
  id: number;
  /** `events.ts` is INTEGER epoch milliseconds (migrations/0001_init.sql). */
  ts: number;
  type: string;
  payload: string;
}

/**
 * History timestamps are raw epoch-ms integers, never ISO strings. Parsing the
 * number as a date string yields NaN and silently fabricates epoch 0, so reject
 * corrupt values explicitly instead of inventing a timestamp.
 */
function eventTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    fail("E_INTERNAL", "Stored event timestamp is not a valid epoch-ms integer");
  }
  return value as number;
}

function positiveInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function executionHistory(runtime: Runtime, runId: RunId, path: Path): ExecutionHistory {
  requireRun(runtime, runId);
  const rows = runtime.db
    .prepare(
      `SELECT id, ts, type, payload FROM events
        WHERE run_id = ? AND path = ?
          AND type IN ('node.attempt.started','node.session.captured',
                       'node.process.spawned','node.process.stopped',
                       'node.transcript.ref','node.output.rejected')
        ORDER BY id ASC`,
    )
    .all(runId, path) as HistoryRow[];

  if (rows.length === 0 && getExecution(runtime, runId, path) === null) {
    fail("E_NOT_FOUND", `Execution ${runId}/${path} does not exist`);
  }

  const attempts = new Map<string, ExecutionAttemptHistory>();
  const validation = new Map<number, number>();
  const transcripts: TranscriptHistory[] = [];

  const entry = (attempt: number, generation: number): ExecutionAttemptHistory => {
    const key = `${attempt}:${generation}`;
    const existing = attempts.get(key);
    if (existing !== undefined) return existing;
    const created: ExecutionAttemptHistory = {
      attempt,
      generation,
      mode: null,
      startedAt: null,
      stoppedAt: null,
      stopReason: null,
      exitCode: null,
      cli: null,
      model: null,
      sessionId: null,
      validationAttempts: 0,
      process: null,
    };
    attempts.set(key, created);
    return created;
  };

  const process = (target: ExecutionAttemptHistory): ProcessHistory => {
    target.process ??= {
      pid: null,
      pidStart: null,
      binary: null,
      cwd: null,
      startedAt: null,
      stoppedAt: null,
      stopReason: null,
      exitCode: null,
      spawnedEventId: null,
      stoppedEventId: null,
    };
    return target.process;
  };

  for (const row of rows) {
    const parsed = parseJson<unknown>(row.payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const payload = parsed as Record<string, unknown>;
    const attempt = positiveInt(payload.attempt);
    const generation = positiveInt(payload.generation);
    if (attempt === null || generation === null) continue;
    const ts = eventTimestamp(row.ts);
    const target = entry(attempt, generation);

    switch (row.type) {
      case "node.attempt.started": {
        target.mode = payload.mode === "resume" ? "resume" : "fresh";
        target.cli = optionalString(payload.cli) ?? target.cli;
        target.model = optionalString(payload.model) ?? target.model;
        target.startedAt ??= ts;
        break;
      }
      case "node.session.captured": {
        target.cli = optionalString(payload.cli) ?? target.cli;
        target.model = optionalString(payload.model) ?? target.model;
        target.sessionId = optionalString(payload.sessionId) ?? target.sessionId;
        break;
      }
      case "node.process.spawned": {
        const spawned = process(target);
        const pid = positiveInt(payload.pid);
        spawned.pid = pid;
        spawned.pidStart = optionalString(payload.pidStart) ?? spawned.pidStart;
        spawned.binary = optionalString(payload.binary) ?? spawned.binary;
        spawned.cwd = optionalString(payload.cwd) ?? spawned.cwd;
        spawned.startedAt ??= ts;
        spawned.spawnedEventId = row.id;
        target.startedAt ??= ts;
        break;
      }
      case "node.process.stopped": {
        const stopped = process(target);
        stopped.stoppedAt ??= ts;
        stopped.stopReason = optionalString(payload.reason) ?? stopped.stopReason;
        stopped.exitCode =
          typeof payload.exitCode === "number" ? payload.exitCode : stopped.exitCode;
        stopped.stoppedEventId = row.id;
        target.stoppedAt ??= ts;
        target.stopReason = optionalString(payload.reason) ?? target.stopReason;
        target.exitCode = typeof payload.exitCode === "number" ? payload.exitCode : target.exitCode;
        break;
      }
      case "node.transcript.ref": {
        const file = optionalString(payload.file);
        const bytes = payload.bytes;
        if (file === null || !Number.isSafeInteger(bytes) || (bytes as number) < 0) break;
        transcripts.push({
          attempt,
          generation,
          file,
          bytes: bytes as number,
          eventId: row.id,
          ts,
        });
        break;
      }
      case "node.output.rejected": {
        const validationAttempt = positiveInt(payload.validationAttempt);
        if (validationAttempt !== null) {
          const current = validation.get(attempt) ?? 0;
          if (validationAttempt > current) validation.set(attempt, validationAttempt);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const target of attempts.values()) {
    target.validationAttempts = validation.get(target.attempt) ?? 0;
  }

  const ordered = [...attempts.values()].sort(
    (left, right) => left.attempt - right.attempt || left.generation - right.generation,
  );
  const newestFirst = transcripts.sort((left, right) => right.eventId - left.eventId);
  return {
    runId,
    path,
    attempts: ordered,
    transcripts: newestFirst,
    latestTranscript: newestFirst[0] ?? null,
  };
}
