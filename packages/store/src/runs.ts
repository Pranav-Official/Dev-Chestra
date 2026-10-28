import {
  type EventDraft,
  isRunWorkspaceBinding,
  type JsonObject,
  type Path,
  type RunId,
  type RunWorkspaceBinding,
} from "@relay/core";
import { appendEvents } from "./events.js";
import { requireRun } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import type { CreateRunInput, CreateRunResult, RunRecord } from "./types.js";
import { fail, parseJson } from "./util.js";

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

interface StoredIdempotency {
  fingerprint: string;
  runId: RunId;
  runNumber: number;
  createdAt: number;
}

function idempotencyKey(projectId: string, key: string): string {
  return `idem:${JSON.stringify([projectId, key])}`;
}

function parseIdempotency(value: string): StoredIdempotency {
  const parsed = parseJson<StoredIdempotency>(value);
  if (
    typeof parsed.fingerprint !== "string" ||
    typeof parsed.runId !== "string" ||
    !Number.isSafeInteger(parsed.runNumber) ||
    !Number.isSafeInteger(parsed.createdAt)
  ) {
    fail("E_INTERNAL", "Stored idempotency metadata is corrupt");
  }
  return parsed;
}

/**
 * Read-only idempotency lookup. Must run in the same BEGIN IMMEDIATE
 * transaction as the run insert so the claim has no external atomicity gap.
 */
function checkIdempotency(runtime: Runtime, input: CreateRunInput): CreateRunResult | null {
  const claim = input.idempotency;
  if (claim === undefined) return null;
  if (typeof claim.key !== "string" || claim.key.length === 0 || claim.key.length > 512) {
    fail("E_VALIDATION", "idempotency.key must be a non-empty string of at most 512 characters");
  }
  if (
    typeof claim.fingerprint !== "string" ||
    claim.fingerprint.length === 0 ||
    claim.fingerprint.length > 512
  ) {
    fail("E_VALIDATION", "idempotency.fingerprint must be a non-empty string");
  }
  if (claim.scope !== undefined && claim.scope !== input.projectId) {
    fail("E_VALIDATION", "idempotency.scope must equal the run's projectId", {
      scope: claim.scope,
      projectId: input.projectId,
    });
  }
  const finding = runtime.secrets.scanString(claim.key, "$.idempotency.key");
  if (finding) {
    fail("E_VALIDATION", "idempotency.key contains a secret", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }

  const stored = runtime.db
    .prepare("SELECT value FROM kv WHERE key = ?")
    .get(idempotencyKey(input.projectId, claim.key)) as { value: string } | undefined;
  if (!stored) return null;

  const record = parseIdempotency(stored.value);
  const age = now(runtime) - record.createdAt;
  if (age > IDEMPOTENCY_TTL_MS) {
    // ponytail: expired claims are reclaimed lazily per key. Add a periodic
    // kv sweep only if idempotency key cardinality becomes a storage concern.
    runtime.db
      .prepare("DELETE FROM kv WHERE key = ?")
      .run(idempotencyKey(input.projectId, claim.key));
    return null;
  }
  if (record.fingerprint !== claim.fingerprint) {
    fail("E_CONFLICT", "This Idempotency-Key was already used with a different request", {
      scope: input.projectId,
      key: claim.key,
      existingRunId: record.runId,
    });
  }
  return { runId: record.runId, runNumber: record.runNumber, duplicate: true };
}

/** A non-null binding is validated; a malformed one never degrades to legacy. */
function workspaceFor(input: CreateRunInput): RunWorkspaceBinding | null {
  if (input.workspace === undefined) return null;
  if (!isRunWorkspaceBinding(input.workspace)) {
    fail("E_VALIDATION", "workspace must be a valid frozen run workspace binding");
  }
  return input.workspace;
}

function readWorkspace(raw: string | null): RunWorkspaceBinding | null {
  if (raw === null) return null;
  const value: unknown = parseJson(raw);
  if (!isRunWorkspaceBinding(value)) {
    fail("E_INTERNAL", "Stored run workspace binding is corrupt; refusing to run");
  }
  return value;
}

export function createRun(runtime: Runtime, input: CreateRunInput): CreateRunResult {
  const duplicate = checkIdempotency(runtime, input);
  if (duplicate !== null) return duplicate;
  const workspace = workspaceFor(input);

  const budgetKeys = input.budgets ?? {};
  for (const key of Object.keys(budgetKeys)) {
    if (key !== "maxTokens") {
      fail("E_VALIDATION", `budgets.${key} is not supported in P1; only maxTokens is accepted`);
    }
  }
  const finding =
    runtime.secrets.scanString(input.snapshotRaw, "$.snapshotRaw") ??
    runtime.secrets.scanValue(input.snapshot, "$.snapshot") ??
    runtime.secrets.scanValue(input.params ?? {}, "$.params") ??
    runtime.secrets.scanValue(input.budgets ?? {}, "$.budgets");
  if (finding) {
    fail("E_VALIDATION", "Workflow snapshot or run inputs contain a secret", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }
  const project = runtime.db
    .prepare("SELECT next_run_number FROM projects WHERE id = ? AND removed_at IS NULL")
    .get(input.projectId) as { next_run_number: number } | undefined;
  if (!project) fail("E_NOT_FOUND", `Project ${input.projectId} does not exist`);

  const runNumber = project.next_run_number;
  runtime.db
    .prepare("UPDATE projects SET next_run_number = ? WHERE id = ?")
    .run(runNumber + 1, input.projectId);

  const runId = runtime.idGen.runId() as RunId;
  const kind = input.kind ?? "run";
  runtime.db
    .prepare(
      `INSERT INTO runs
         (id, project_id, workflow_id, run_number, kind, status, workflow_hash,
          snapshot_json, snapshot_raw, params_json, budgets_json, base_sha,
          workspace_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      input.projectId,
      input.workflowId,
      runNumber,
      kind,
      input.workflowHash,
      JSON.stringify(input.snapshot ?? null),
      input.snapshotRaw,
      JSON.stringify(input.params ?? {}),
      JSON.stringify(input.budgets ?? {}),
      input.baseSha ?? null,
      workspace === null ? null : JSON.stringify(workspace),
      now(runtime),
    );

  const created: EventDraft = {
    runId,
    path: "" as Path,
    type: "run.created",
    actor: "system",
    payload: {
      workflowId: input.workflowId,
      workflowHash: input.workflowHash,
      runNumber,
      params: (input.params ?? {}) as JsonObject,
      budgets: (input.budgets ?? {}) as JsonObject,
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
      kind,
    },
  };
  const started: EventDraft = {
    runId,
    path: "" as Path,
    type: "run.started",
    actor: "engine",
    payload: {},
  };
  appendEvents(runtime, runId, [created, started]);

  if (input.idempotency !== undefined) {
    const record: StoredIdempotency = {
      fingerprint: input.idempotency.fingerprint,
      runId,
      runNumber,
      createdAt: now(runtime),
    };
    runtime.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?)")
      .run(idempotencyKey(input.projectId, input.idempotency.key), JSON.stringify(record));
  }
  return { runId, runNumber, duplicate: false };
}

export { requireRun };

interface RunRecordRow {
  archived_at: number | null;
  id: string;
  project_id: string;
  project_name: string;
  project_path: string;
  project_kind: "git" | "folder";
  workflow_id: string;
  run_number: number;
  kind: "run" | "node_test";
  status: string;
  workflow_hash: string;
  snapshot_json: string;
  snapshot_raw: string;
  params_json: string;
  budgets_json: string;
  base_sha: string | null;
  workspace_json: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  pause_reason: string | null;
  cost_usd: number;
  tokens: number;
  active_ms: number;
  paused_ms: number;
  supervisor_usd: number;
  result_json: string | null;
}

const RUN_SELECT = `SELECT r.id, r.project_id, p.name AS project_name, p.path AS project_path,
  p.kind AS project_kind, r.workflow_id, r.run_number, r.kind, r.status, r.workflow_hash,
  r.snapshot_json, r.snapshot_raw, r.params_json, r.budgets_json, r.base_sha,
  r.workspace_json, r.created_at,
  r.started_at, r.ended_at, r.pause_reason, r.cost_usd, r.tokens, r.active_ms, r.paused_ms,
  r.supervisor_usd, r.result_json, r.archived_at
  FROM runs r JOIN projects p ON p.id = r.project_id`;

function mapRunRecord(row: RunRecordRow): RunRecord {
  return {
    archivedAt: row.archived_at,
    id: row.id as RunId,
    project: {
      id: row.project_id,
      name: row.project_name,
      path: row.project_path,
      kind: row.project_kind,
    },
    workflowId: row.workflow_id,
    runNumber: row.run_number,
    kind: row.kind,
    status: row.status,
    workflowHash: row.workflow_hash,
    snapshot: parseJson(row.snapshot_json),
    snapshotRaw: row.snapshot_raw,
    params: parseJson(row.params_json),
    budgets: parseJson(row.budgets_json),
    baseSha: row.base_sha,
    workspace: readWorkspace(row.workspace_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    pauseReason: row.pause_reason,
    costUsd: row.cost_usd,
    tokens: row.tokens,
    activeMs: row.active_ms,
    pausedMs: row.paused_ms,
    supervisorUsd: row.supervisor_usd,
    result: row.result_json === null ? null : parseJson(row.result_json),
  };
}

export function getRun(runtime: Runtime, runId: RunId): RunRecord | null {
  const row = runtime.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as
    | RunRecordRow
    | undefined;
  return row ? mapRunRecord(row) : null;
}

export function listActiveRuns(runtime: Runtime): RunRecord[] {
  const rows = runtime.db
    .prepare(
      `${RUN_SELECT}
       WHERE r.status IN ('queued','running','paused','waiting_approval')
       ORDER BY r.created_at ASC`,
    )
    .all() as RunRecordRow[];
  return rows.map(mapRunRecord);
}
