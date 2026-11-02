import { now, type Runtime } from "./runtime.js";
import { parseJson } from "./util.js";

/**
 * Poll dedupe claims are kept for this long; older claims expire lazily.
 * Mirrors the webhook delivery window: a key already triggered inside it is
 * skipped as a duplicate.
 */
export const POLL_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Expired claims removed per new claim. Bounded so one tick never does large work. */
const DEDUPE_PRUNE_BATCH = 50;

/** What the last probe tick did. `skipped` means a previous probe was still running. */
export type PollTickOutcome = "nothing" | "triggered" | "duplicate" | "failed" | "skipped";

export interface PollTriggerRecord {
  pollerId: string;
  projectId: string;
  workflowId: string;
  armed: boolean;
  /** Null until the first arm. Kept across disarm and re-arm. */
  intervalSeconds: number | null;
  armedRevision: string | null;
  armedAt: number | null;
  /** When the next probe is due, or null when not armed. */
  nextDueAt: number | null;
  lastTickAt: number | null;
  lastOutcome: PollTickOutcome | null;
  /** Run started by the last `triggered` tick. */
  lastRunId: string | null;
  consecutiveFailures: number;
  /** Last probe failure, or the reason the poller disarmed itself. */
  lastError: string | null;
  refreshError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Trigger state a probe tick runs against. Never returned to the browser. */
export interface PollTriggerRuntime extends PollTriggerRecord {
  snapshot: unknown;
  snapshotRaw: string | null;
  bundle: Record<string, unknown>;
}

export interface ArmPollerInput {
  armedRevision: string;
  snapshot: unknown;
  snapshotRaw: string;
  bundle: Record<string, unknown>;
  intervalSeconds: number;
}

export interface CreatePollerInput {
  pollerId: string;
  projectId: string;
  workflowId: string;
}

export interface PollTickInput {
  outcome: PollTickOutcome;
  /** Set on `triggered` ticks; kept otherwise. */
  runId?: string | undefined;
  /** Set on `failed` ticks; cleared on success. */
  error?: string | undefined;
}

/** `runId` is set once the claimed result has a run bound to it. */
export type PollDedupeClaim = { kind: "claimed" } | { kind: "duplicate"; runId: string };

interface PollerRow {
  id: string;
  project_id: string;
  workflow_id: string;
  armed: number;
  interval_seconds: number | null;
  armed_revision: string | null;
  armed_snapshot_json: string | null;
  armed_snapshot_raw: string | null;
  armed_bundle_json: string | null;
  armed_at: number | null;
  next_due_at: number | null;
  last_tick_at: number | null;
  last_outcome: string | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  refresh_error: string | null;
  created_at: number;
  updated_at: number;
}

const POLLER_COLUMNS = `id, project_id, workflow_id, armed, interval_seconds,
  armed_revision, armed_snapshot_json, armed_snapshot_raw, armed_bundle_json, armed_at,
  next_due_at, last_tick_at, last_outcome, last_run_id, consecutive_failures,
  last_error, refresh_error, created_at, updated_at`;

function asOutcome(value: string | null): PollTickOutcome | null {
  return value === "nothing" ||
    value === "triggered" ||
    value === "duplicate" ||
    value === "failed" ||
    value === "skipped"
    ? value
    : null;
}

function mapPoller(row: PollerRow): PollTriggerRecord {
  return {
    pollerId: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    armed: row.armed !== 0,
    intervalSeconds: row.interval_seconds,
    armedRevision: row.armed_revision,
    armedAt: row.armed_at,
    nextDueAt: row.next_due_at,
    lastTickAt: row.last_tick_at,
    lastOutcome: asOutcome(row.last_outcome),
    lastRunId: row.last_run_id,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    refreshError: row.refresh_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntime(row: PollerRow): PollTriggerRuntime {
  return {
    ...mapPoller(row),
    snapshot: row.armed_snapshot_json === null ? null : parseJson(row.armed_snapshot_json),
    snapshotRaw: row.armed_snapshot_raw,
    bundle:
      row.armed_bundle_json === null
        ? {}
        : (parseJson(row.armed_bundle_json) as Record<string, unknown>),
  };
}

function rowById(runtime: Runtime, pollerId: string): PollerRow | null {
  return (
    (runtime.db
      .prepare(`SELECT ${POLLER_COLUMNS} FROM workflow_pollers WHERE id = ?`)
      .get(pollerId) as PollerRow | undefined) ?? null
  );
}

export function getPoller(
  runtime: Runtime,
  projectId: string,
  workflowId: string,
): PollTriggerRecord | null {
  const row = runtime.db
    .prepare(
      `SELECT ${POLLER_COLUMNS} FROM workflow_pollers WHERE project_id = ? AND workflow_id = ?`,
    )
    .get(projectId, workflowId) as PollerRow | undefined;
  return row === undefined ? null : mapPoller(row);
}

export function getPollerRuntime(runtime: Runtime, pollerId: string): PollTriggerRuntime | null {
  const row = rowById(runtime, pollerId);
  return row === null ? null : mapRuntime(row);
}

export function createPoller(runtime: Runtime, input: CreatePollerInput): void {
  const at = now(runtime);
  runtime.db
    .prepare(
      `INSERT INTO workflow_pollers
         (id, project_id, workflow_id, armed, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .run(input.pollerId, input.projectId, input.workflowId, at, at);
}

export function armPoller(runtime: Runtime, pollerId: string, input: ArmPollerInput): void {
  const at = now(runtime);
  runtime.db
    .prepare(
      `UPDATE workflow_pollers
         SET armed = 1, interval_seconds = ?, armed_revision = ?,
             armed_snapshot_json = ?, armed_snapshot_raw = ?, armed_bundle_json = ?,
             armed_at = ?, next_due_at = ?, last_tick_at = NULL, last_outcome = NULL,
             last_run_id = NULL, consecutive_failures = 0, last_error = NULL,
             refresh_error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.intervalSeconds,
      input.armedRevision,
      JSON.stringify(input.snapshot),
      input.snapshotRaw,
      JSON.stringify(input.bundle),
      at,
      at + input.intervalSeconds * 1000,
      at,
      pollerId,
    );
}

/**
 * Compare-and-swap for an armed poller: the revision moves only if it still
 * equals `expectedRevision`, so concurrent refreshes cannot mix two bundles.
 * The interval and schedule are untouched.
 */
export function replacePollerRevision(
  runtime: Runtime,
  pollerId: string,
  expectedRevision: string,
  input: ArmPollerInput,
): boolean {
  const at = now(runtime);
  const result = runtime.db
    .prepare(
      `UPDATE workflow_pollers
         SET armed_revision = ?, armed_snapshot_json = ?, armed_snapshot_raw = ?,
             armed_bundle_json = ?, armed_at = ?, refresh_error = NULL, updated_at = ?
       WHERE id = ? AND armed = 1 AND armed_revision = ?`,
    )
    .run(
      input.armedRevision,
      JSON.stringify(input.snapshot),
      input.snapshotRaw,
      JSON.stringify(input.bundle),
      at,
      at,
      pollerId,
      expectedRevision,
    ) as { changes: number };
  return result.changes === 1;
}

/** Idempotent: disarming twice keeps the interval for the next arm. */
export function disarmPoller(runtime: Runtime, pollerId: string): void {
  runtime.db
    .prepare(
      "UPDATE workflow_pollers SET armed = 0, next_due_at = NULL, updated_at = ? WHERE id = ?",
    )
    .run(now(runtime), pollerId);
}

/**
 * Removes the poller row. Dedupe claims go with it (ON DELETE CASCADE), so a
 * workflow recreated later gets a fresh poller and no stale duplicates.
 */
export function deletePoller(runtime: Runtime, pollerId: string): void {
  runtime.db.prepare("DELETE FROM workflow_pollers WHERE id = ?").run(pollerId);
}

/** Relink and removal both disarm: a poller never probes a different directory. */
export function disarmProjectPollers(runtime: Runtime, projectId: string): void {
  runtime.db
    .prepare(
      "UPDATE workflow_pollers SET armed = 0, next_due_at = NULL, updated_at = ? WHERE project_id = ?",
    )
    .run(now(runtime), projectId);
}

export function setPollerRefreshError(
  runtime: Runtime,
  pollerId: string,
  message: string | null,
): void {
  runtime.db
    .prepare("UPDATE workflow_pollers SET refresh_error = ?, updated_at = ? WHERE id = ?")
    .run(message, now(runtime), pollerId);
}

/** Armed pollers whose next probe is due, earliest first. Powers the scheduler loop. */
export function listDuePollers(runtime: Runtime, at: number): PollTriggerRuntime[] {
  const rows = runtime.db
    .prepare(
      `SELECT ${POLLER_COLUMNS} FROM workflow_pollers
       WHERE armed = 1 AND next_due_at IS NOT NULL AND next_due_at <= ?
       ORDER BY next_due_at ASC`,
    )
    .all(at) as PollerRow[];
  return rows.map(mapRuntime);
}

/**
 * Records one scheduler tick, inside the caller's transaction. Every tick moves
 * the next due date by the armed interval. Success (`nothing`, `triggered`,
 * `duplicate`) resets the failure streak; `skipped` leaves it alone; `failed`
 * grows it and disarms the poller once it reaches `maxFailures`, keeping the
 * reason in `last_error`. Returns the updated record.
 */
export function recordPollTick(
  runtime: Runtime,
  pollerId: string,
  tick: PollTickInput,
  maxFailures: number,
): PollTriggerRecord {
  const at = now(runtime);
  const row = rowById(runtime, pollerId);
  if (row === null) {
    throw new Error(`Poller ${pollerId} does not exist`);
  }
  const nextDue = row.interval_seconds === null ? null : at + row.interval_seconds * 1000;
  if (tick.outcome === "failed") {
    const failures = row.consecutive_failures + 1;
    const autoDisarm = failures >= maxFailures;
    if (autoDisarm) {
      runtime.db
        .prepare(
          `UPDATE workflow_pollers
             SET last_tick_at = ?, last_outcome = 'failed', next_due_at = NULL,
                 consecutive_failures = ?, last_error = ?, armed = 0, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, failures, tick.error ?? "Probe failed.", at, pollerId);
    } else {
      runtime.db
        .prepare(
          `UPDATE workflow_pollers
             SET last_tick_at = ?, last_outcome = 'failed', next_due_at = ?,
                 consecutive_failures = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, nextDue, failures, tick.error ?? "Probe failed.", at, pollerId);
    }
  } else if (tick.outcome === "skipped") {
    runtime.db
      .prepare(
        `UPDATE workflow_pollers
           SET last_tick_at = ?, last_outcome = 'skipped', next_due_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, nextDue, at, pollerId);
  } else if (tick.runId === undefined) {
    runtime.db
      .prepare(
        `UPDATE workflow_pollers
           SET last_tick_at = ?, last_outcome = ?, next_due_at = ?,
               consecutive_failures = 0, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, tick.outcome, nextDue, at, pollerId);
  } else {
    runtime.db
      .prepare(
        `UPDATE workflow_pollers
           SET last_tick_at = ?, last_outcome = ?, next_due_at = ?, last_run_id = ?,
               consecutive_failures = 0, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, tick.outcome, nextDue, tick.runId, at, pollerId);
  }
  const updated = rowById(runtime, pollerId);
  if (updated === null) throw new Error(`Poller ${pollerId} does not exist`);
  return mapPoller(updated);
}

type DedupeRow = { run_id: string | null; created_at: number };

/**
 * Claims one probe result for this poller, inside the caller's transaction.
 * A key bound to a run within the window is a duplicate; an unbound claim
 * (its tick crashed between claim and bind) may be claimed again. Expired
 * claims are reclaimed.
 */
export function claimPollDedupe(runtime: Runtime, pollerId: string, key: string): PollDedupeClaim {
  const at = now(runtime);
  const cutoff = at - POLL_DEDUPE_RETENTION_MS;
  const existing = runtime.db
    .prepare(
      "SELECT run_id, created_at FROM poll_dedupe_claims WHERE poller_id = ? AND dedupe_key = ?",
    )
    .get(pollerId, key) as DedupeRow | undefined;
  if (existing !== undefined && existing.created_at >= cutoff) {
    if (existing.run_id !== null) return { kind: "duplicate", runId: existing.run_id };
    runtime.db
      .prepare("DELETE FROM poll_dedupe_claims WHERE poller_id = ? AND dedupe_key = ?")
      .run(pollerId, key);
  } else if (existing !== undefined) {
    runtime.db
      .prepare("DELETE FROM poll_dedupe_claims WHERE poller_id = ? AND dedupe_key = ?")
      .run(pollerId, key);
  }
  runtime.db
    .prepare(
      "INSERT INTO poll_dedupe_claims (poller_id, dedupe_key, run_id, created_at) VALUES (?, ?, NULL, ?)",
    )
    .run(pollerId, key, at);
  // Each new claim sweeps a small batch of expired rows, so the table stays bounded
  // without a timer. The sweep runs in the caller's transaction.
  pruneExpiredDedupe(runtime, DEDUPE_PRUNE_BATCH);
  return { kind: "claimed" };
}

export function bindPollDedupe(
  runtime: Runtime,
  pollerId: string,
  key: string,
  runId: string,
): void {
  runtime.db
    .prepare("UPDATE poll_dedupe_claims SET run_id = ? WHERE poller_id = ? AND dedupe_key = ?")
    .run(runId, pollerId, key);
}

/** Read-only duplicate check for probe-now: never writes a claim. */
export function dedupeRunFor(runtime: Runtime, pollerId: string, key: string): string | null {
  const cutoff = now(runtime) - POLL_DEDUPE_RETENTION_MS;
  const row = runtime.db
    .prepare(
      `SELECT run_id FROM poll_dedupe_claims
       WHERE poller_id = ? AND dedupe_key = ? AND run_id IS NOT NULL AND created_at >= ?`,
    )
    .get(pollerId, key, cutoff) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

/** Bounded sweep of expired claims; returns how many rows were removed. */
export function pruneExpiredDedupe(runtime: Runtime, limit: number): number {
  const cutoff = now(runtime) - POLL_DEDUPE_RETENTION_MS;
  const result = runtime.db
    .prepare(
      `DELETE FROM poll_dedupe_claims WHERE rowid IN (
         SELECT rowid FROM poll_dedupe_claims WHERE created_at < ? LIMIT ?)`,
    )
    .run(cutoff, limit) as { changes: number };
  return result.changes;
}
