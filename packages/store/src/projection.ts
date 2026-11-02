import {
  type Actor,
  type EventEnvelope,
  type EventType,
  type ExecView,
  emptyRunView,
  type Path,
  project,
  type RunId,
  type RunStatus,
  type RunView,
} from "@devchestra/core";
import type { Runtime } from "./runtime.js";
import { fail, nodeIdFromPath, parseJson } from "./util.js";

export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export interface EventRow {
  id: number;
  run_id: string;
  ts: number;
  path: string;
  type: string;
  actor: string;
  v: number;
  payload: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  workflow_id: string;
  run_number: number;
  kind: string;
  status: string;
  created_at: number;
}

export interface ListEventsOptions {
  after?: number;
  limit?: number;
  types?: readonly EventType[];
  pathPrefix?: string;
}

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function assertRunActive(runtime: Runtime, runId: RunId): RunRow {
  const run = requireRun(runtime, runId);
  if (isTerminalRunStatus(run.status as RunStatus)) {
    fail("E_CONFLICT", `Run ${runId} is ${run.status}; terminal runs accept no new writes`);
  }
  return run;
}

export function requireRun(runtime: Runtime, runId: RunId): RunRow {
  const row = runtime.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
    | RunRow
    | undefined;
  if (!row) fail("E_NOT_FOUND", `Run ${runId} does not exist`);
  return row;
}

export function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    ts: new Date(row.ts).toISOString(),
    path: row.path as Path,
    type: row.type as EventType,
    actor: row.actor as Actor,
    v: row.v,
    payload: parseJson(row.payload),
  } as EventEnvelope;
}

export function listEventRows(
  runtime: Runtime,
  runId: RunId,
  options: ListEventsOptions = {},
): EventRow[] {
  const where = ["run_id = ?"];
  const params: unknown[] = [runId];
  if (options.after !== undefined) {
    where.push("id > ?");
    params.push(options.after);
  }
  if (options.pathPrefix !== undefined) {
    where.push("path LIKE ?");
    params.push(`${options.pathPrefix}%`);
  }
  if (options.types !== undefined && options.types.length > 0) {
    where.push(`type IN (${options.types.map(() => "?").join(", ")})`);
    params.push(...options.types);
  }
  const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 10_000);
  params.push(limit);
  return runtime.db
    .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`)
    .all(...params) as EventRow[];
}

export function listEvents(
  runtime: Runtime,
  runId: RunId,
  options?: ListEventsOptions,
): EventEnvelope[] {
  return listEventRows(runtime, runId, options).map(rowToEnvelope);
}

export function lastEventTs(runtime: Runtime, runId: RunId): number {
  const row = runtime.db
    .prepare("SELECT ts FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { ts: number } | undefined;
  return row?.ts ?? 0;
}

/**
 * Routing fields are mandatory on every execution. Normalize every cached view path so
 * strict API consumers keep parsing old run_views until the next rebuild.
 */
export function normalizeCachedView(view: RunView): RunView {
  for (const execution of Object.values(view.executions)) {
    const legacy = execution as ExecView & {
      gateDecision?: ExecView["gateDecision"];
      joinResolution?: ExecView["joinResolution"];
      approvalRequest?: ExecView["approvalRequest"];
      approvalDecision?: ExecView["approvalDecision"];
      decision?: ExecView["decision"];
      loop?: ExecView["loop"];
    };
    if (legacy.gateDecision === undefined) legacy.gateDecision = null;
    if (legacy.joinResolution === undefined) legacy.joinResolution = null;
    if (legacy.approvalRequest === undefined) legacy.approvalRequest = null;
    if (legacy.approvalDecision === undefined) legacy.approvalDecision = null;
    if (legacy.decision === undefined) legacy.decision = null;
    if (legacy.loop === undefined) legacy.loop = null;
    if ((legacy as { workflow?: unknown }).workflow === undefined)
      (legacy as { workflow: null }).workflow = null;
    if ((legacy as { foreach?: unknown }).foreach === undefined)
      (legacy as { foreach: null }).foreach = null;
    if (legacy.loop !== null && legacy.loop !== undefined) {
      const loop = legacy.loop as unknown as Record<string, unknown>;
      if (loop.parentRef === undefined) loop.parentRef = null;
      if (Array.isArray(loop.rounds)) {
        for (const round of loop.rounds as Record<string, unknown>[]) {
          if (round.outcome === undefined)
            round.outcome = round.done === true ? "condition_met" : null;
        }
      }
    }
  }
  return view;
}

export function loadView(runtime: Runtime, runId: RunId): RunView {
  const row = runtime.db.prepare("SELECT view_json FROM run_views WHERE run_id = ?").get(runId) as
    | { view_json: string }
    | undefined;
  if (!row) return emptyRunView();
  return normalizeCachedView(parseJson<RunView>(row.view_json));
}

export function saveView(runtime: Runtime, runId: RunId, view: RunView): void {
  runtime.db
    .prepare(
      `INSERT INTO run_views (run_id, view_json, last_event_id)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         view_json = excluded.view_json,
         last_event_id = excluded.last_event_id`,
    )
    .run(runId, JSON.stringify(view), view.lastEventId);
}

export function reconcile(runtime: Runtime, runId: RunId, view: RunView): void {
  const upsert = runtime.db.prepare(
    `INSERT INTO executions
       (run_id, path, node_id, status, attempt, generation, kind, cli, session_id,
        session_cwd, model, started_at, ended_at, cost_usd, tokens_in, tokens_out,
        output_id, error_code, error_message, workspace_dir, branch, validation_attempts,
        validation_limit, crash_attempts, last_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)
     ON CONFLICT(run_id, path) DO UPDATE SET
       node_id = excluded.node_id,
       status = excluded.status,
       attempt = excluded.attempt,
       generation = excluded.generation,
       kind = excluded.kind,
       cli = excluded.cli,
       session_id = excluded.session_id,
       session_cwd = excluded.session_cwd,
       model = excluded.model,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       cost_usd = excluded.cost_usd,
       tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       output_id = excluded.output_id,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       workspace_dir = excluded.workspace_dir,
       branch = excluded.branch,
       validation_attempts = excluded.validation_attempts,
       crash_attempts = excluded.crash_attempts,
       last_event_id = excluded.last_event_id`,
  );

  for (const execution of Object.values(view.executions)) {
    const exec = execution as ExecView & {
      workspaceDir?: string | null;
      branch?: string | null;
      lastError?: { code?: string; message?: string } | null;
    };
    const accepted = exec.acceptedResult ?? null;
    const finalized = exec.workspaceFinalized ?? null;
    const error = exec.lastError ?? null;
    upsert.run(
      runId,
      exec.path,
      exec.nodeId ?? nodeIdFromPath(exec.path),
      exec.status,
      exec.attempt,
      exec.generation,
      exec.kind ?? null,
      exec.cli ?? null,
      exec.sessionId ?? null,
      exec.sessionCwd ?? null,
      exec.model ?? null,
      exec.startedAt ?? null,
      exec.endedAt ?? null,
      exec.costUsd ?? 0,
      exec.tokensIn ?? 0,
      exec.tokensOut ?? 0,
      accepted?.outputId ?? null,
      error?.code ?? null,
      error?.message ?? null,
      finalized?.dir ?? exec.workspaceDir ?? null,
      exec.branch ?? null,
      exec.validationAttempts ?? 0,
      exec.crashAttempts ?? 0,
      view.lastEventId,
    );
  }

  updateRun(runtime, runId, view);
}

function updateRun(runtime: Runtime, runId: RunId, view: RunView): void {
  const last = runtime.db
    .prepare("SELECT ts FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { ts: number } | undefined;
  const lastTs = last?.ts ?? null;
  const terminal: readonly RunStatus[] = ["succeeded", "failed", "rejected", "cancelled"];
  const existing = runtime.db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as
    | { ended_at: number | null }
    | undefined;
  const endedAt = terminal.includes(view.status) ? (existing?.ended_at ?? lastTs) : null;

  let pauseReason: string | null = null;
  if (view.status === "paused") {
    const row = runtime.db
      .prepare(
        `SELECT payload FROM events
          WHERE run_id = ? AND type = 'run.paused'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as { payload: string } | undefined;
    if (row) pauseReason = parseJson<{ reason?: string }>(row.payload).reason ?? null;
  }

  let resultJson: string | null = null;
  if (terminal.includes(view.status)) {
    const row = runtime.db
      .prepare(
        `SELECT payload FROM events
          WHERE run_id = ? AND type = 'run.completed'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as { payload: string } | undefined;
    if (row) {
      const payload = parseJson<{ result?: unknown }>(row.payload);
      if (payload.result !== undefined) resultJson = JSON.stringify(payload.result);
    }
  }

  runtime.db
    .prepare(
      `UPDATE runs
          SET status = ?, cost_usd = ?, tokens = ?, active_ms = ?, paused_ms = ?,
              supervisor_usd = ?, started_at = COALESCE(started_at, ?), ended_at = ?,
              pause_reason = ?, result_json = ?
        WHERE id = ?`,
    )
    .run(
      view.status,
      view.budget.usd,
      view.budget.tokens,
      view.budget.activeMs,
      view.pausedMs,
      view.budget.supervisorUsd,
      view.status === "queued" ? null : lastTs,
      endedAt,
      pauseReason,
      resultJson,
      runId,
    );
}

const REBUILD_PAGE_SIZE = 10_000;

/**
 * TD-002: listEventRows caps at 10k for API bounding. Internal replays must
 * page past the cap instead of projecting a truncated prefix.
 */
function loadAllEventRows(runtime: Runtime, runId: RunId): EventRow[] {
  const all: EventRow[] = [];
  let after: number | undefined;
  for (;;) {
    const page =
      after === undefined
        ? listEventRows(runtime, runId, { limit: REBUILD_PAGE_SIZE })
        : listEventRows(runtime, runId, { after, limit: REBUILD_PAGE_SIZE });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < REBUILD_PAGE_SIZE) break;
    after = page[page.length - 1]?.id;
    if (after === undefined) break;
  }
  return all;
}

export function getView(runtime: Runtime, runId: RunId): RunView {
  requireRun(runtime, runId);
  const hasView = runtime.db
    .prepare("SELECT 1 AS present FROM run_views WHERE run_id = ?")
    .get(runId) as { present: number } | undefined;
  if (hasView) return loadView(runtime, runId);
  return project(loadAllEventRows(runtime, runId).map(rowToEnvelope));
}

export function rebuildProjection(runtime: Runtime, runId: RunId): RunView {
  requireRun(runtime, runId);
  const limits = runtime.db
    .prepare("SELECT path, validation_limit FROM executions WHERE run_id = ?")
    .all(runId) as { path: string; validation_limit: number }[];

  runtime.db.prepare("DELETE FROM executions WHERE run_id = ?").run(runId);
  const view = project(loadAllEventRows(runtime, runId).map(rowToEnvelope));
  saveView(runtime, runId, view);
  reconcile(runtime, runId, view);

  const restore = runtime.db.prepare(
    "UPDATE executions SET validation_limit = ? WHERE run_id = ? AND path = ?",
  );
  for (const limit of limits) restore.run(limit.validation_limit, runId, limit.path);
  return view;
}
