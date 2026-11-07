import { now, type Runtime } from "./runtime.js";
import { fail, parseJson } from "./util.js";

/** Provider retries are deduplicated for this long; older claims expire lazily. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Expired claims removed per new claim. Bounded so one delivery never does large work. */
const DELIVERY_PRUNE_BATCH = 50;

export interface TriggerRecord {
  hookId: string;
  projectId: string;
  workflowId: string;
  armed: boolean;
  armedRevision: string | null;
  armedAt: number | null;
  refreshError: string | null;
  lastDeliveryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Trigger state an accepted delivery runs against. Never returned to the browser. */
export interface TriggerRuntime extends TriggerRecord {
  signingSecret: string;
  snapshot: unknown;
  snapshotRaw: string | null;
  bundle: Record<string, unknown>;
}

/** What the public ingress needs to authenticate a delivery. Loads no workflow data. */
export interface TriggerAuth {
  hookId: string;
  armed: boolean;
  armedRevision: string | null;
  signingSecret: string;
}

export interface ArmTriggerInput {
  armedRevision: string;
  snapshot: unknown;
  snapshotRaw: string;
  bundle: Record<string, unknown>;
}

export interface CreateTriggerInput {
  hookId: string;
  projectId: string;
  workflowId: string;
  signingSecret: string;
}

export interface WebhookClaimInput {
  hookId: string;
  /** The provider's delivery ID, when the request carried one. */
  deliveryId?: string | undefined;
  fingerprint: string;
}

/** `key` is the stored claim key, which the run is bound to once it exists. */
export type WebhookDuplicate = { kind: "duplicate"; runId: string };
export type WebhookClaim = { kind: "claimed"; key: string } | WebhookDuplicate;

/**
 * Stored key for a delivery that carried no provider ID. The space makes it fail the
 * provider ID pattern, so it can never equal a real delivery ID.
 */
function noIdKey(fingerprint: string): string {
  return `no-id ${fingerprint}`;
}

interface TriggerRow {
  id: string;
  project_id: string;
  workflow_id: string;
  armed: number;
  signing_secret: string;
  armed_revision: string | null;
  armed_snapshot_json: string | null;
  armed_snapshot_raw: string | null;
  armed_bundle_json: string | null;
  armed_at: number | null;
  refresh_error: string | null;
  last_delivery_at: number | null;
  created_at: number;
  updated_at: number;
}

const TRIGGER_COLUMNS = `id, project_id, workflow_id, armed, signing_secret,
  armed_revision, armed_snapshot_json, armed_snapshot_raw, armed_bundle_json, armed_at,
  refresh_error, last_delivery_at, created_at, updated_at`;

function mapTrigger(row: TriggerRow): TriggerRecord {
  return {
    hookId: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    armed: row.armed !== 0,
    armedRevision: row.armed_revision,
    armedAt: row.armed_at,
    refreshError: row.refresh_error,
    lastDeliveryAt: row.last_delivery_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntime(row: TriggerRow): TriggerRuntime {
  return {
    ...mapTrigger(row),
    signingSecret: row.signing_secret,
    snapshot: row.armed_snapshot_json === null ? null : parseJson(row.armed_snapshot_json),
    snapshotRaw: row.armed_snapshot_raw,
    bundle:
      row.armed_bundle_json === null
        ? {}
        : (parseJson(row.armed_bundle_json) as Record<string, unknown>),
  };
}

function rowById(runtime: Runtime, hookId: string): TriggerRow | null {
  return (
    (runtime.db
      .prepare(`SELECT ${TRIGGER_COLUMNS} FROM workflow_triggers WHERE id = ?`)
      .get(hookId) as TriggerRow | undefined) ?? null
  );
}

export function getTrigger(
  runtime: Runtime,
  projectId: string,
  workflowId: string,
): TriggerRecord | null {
  const row = runtime.db
    .prepare(
      `SELECT ${TRIGGER_COLUMNS} FROM workflow_triggers WHERE project_id = ? AND workflow_id = ?`,
    )
    .get(projectId, workflowId) as TriggerRow | undefined;
  return row === undefined ? null : mapTrigger(row);
}

export function getTriggerRuntime(runtime: Runtime, hookId: string): TriggerRuntime | null {
  const row = rowById(runtime, hookId);
  return row === null ? null : mapRuntime(row);
}

/** Auth-only read: the armed flag, the armed revision and the secret, without the snapshot. */
export function getTriggerAuth(runtime: Runtime, hookId: string): TriggerAuth | null {
  const row = runtime.db
    .prepare("SELECT id, armed, armed_revision, signing_secret FROM workflow_triggers WHERE id = ?")
    .get(hookId) as
    | { id: string; armed: number; armed_revision: string | null; signing_secret: string }
    | undefined;
  if (row === undefined) return null;
  return {
    hookId: row.id,
    armed: row.armed !== 0,
    armedRevision: row.armed_revision,
    signingSecret: row.signing_secret,
  };
}

export function createTrigger(runtime: Runtime, input: CreateTriggerInput): void {
  const at = now(runtime);
  runtime.db
    .prepare(
      `INSERT INTO workflow_triggers
         (id, project_id, workflow_id, armed, signing_secret, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(input.hookId, input.projectId, input.workflowId, input.signingSecret, at, at);
}

export function armTrigger(runtime: Runtime, hookId: string, input: ArmTriggerInput): void {
  const at = now(runtime);
  runtime.db
    .prepare(
      `UPDATE workflow_triggers
         SET armed = 1, armed_revision = ?, armed_snapshot_json = ?, armed_snapshot_raw = ?,
             armed_bundle_json = ?, armed_at = ?, refresh_error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.armedRevision,
      JSON.stringify(input.snapshot),
      input.snapshotRaw,
      JSON.stringify(input.bundle),
      at,
      at,
      hookId,
    );
}

/**
 * Compare-and-swap for an armed trigger: the revision moves only if it still
 * equals `expectedRevision`, so concurrent refreshes cannot mix two bundles.
 */
export function replaceArmedRevision(
  runtime: Runtime,
  hookId: string,
  expectedRevision: string,
  input: ArmTriggerInput,
): boolean {
  const at = now(runtime);
  const result = runtime.db
    .prepare(
      `UPDATE workflow_triggers
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
      hookId,
      expectedRevision,
    ) as { changes: number };
  return result.changes === 1;
}

export function disarmTrigger(runtime: Runtime, hookId: string): void {
  runtime.db
    .prepare("UPDATE workflow_triggers SET armed = 0, updated_at = ? WHERE id = ?")
    .run(now(runtime), hookId);
}

/**
 * Removes the trigger row, its hook ID and its secret. Delivery claims go with it
 * (ON DELETE CASCADE), so a workflow recreated later gets a fresh hook and secret.
 */
export function deleteTrigger(runtime: Runtime, hookId: string): void {
  runtime.db.prepare("DELETE FROM workflow_triggers WHERE id = ?").run(hookId);
}

/** Relink and removal both disarm: a trigger never runs against a different directory. */
export function disarmProjectTriggers(runtime: Runtime, projectId: string): void {
  runtime.db
    .prepare("UPDATE workflow_triggers SET armed = 0, updated_at = ? WHERE project_id = ?")
    .run(now(runtime), projectId);
}

/** Replaces the one credential. The old secret stops verifying at once. */
export function rotateTriggerCredentials(
  runtime: Runtime,
  hookId: string,
  signingSecret: string,
): void {
  runtime.db
    .prepare("UPDATE workflow_triggers SET signing_secret = ?, updated_at = ? WHERE id = ?")
    .run(signingSecret, now(runtime), hookId);
}

export function setTriggerRefreshError(
  runtime: Runtime,
  hookId: string,
  message: string | null,
): void {
  runtime.db
    .prepare("UPDATE workflow_triggers SET refresh_error = ?, updated_at = ? WHERE id = ?")
    .run(message, now(runtime), hookId);
}

/**
 * Checks that the trigger is still armed on exactly the revision the caller
 * froze, inside the caller's transaction. A disarm that commits first wins.
 */
export function assertArmedRevision(runtime: Runtime, hookId: string, revision: string): void {
  const row = rowById(runtime, hookId);
  if (row === null) fail("E_NOT_FOUND", "Webhook trigger does not exist");
  if (row.armed === 0) {
    fail("E_CONFLICT", "The webhook trigger is disarmed", { reason: "disarmed" });
  }
  if (row.armed_revision !== revision) {
    fail("E_CONFLICT", "The webhook trigger was refreshed; retry the delivery", {
      reason: "revision_changed",
    });
  }
}

type ClaimRow = { fingerprint: string; run_id: string | null; created_at: number };

function duplicateOf(row: ClaimRow): WebhookDuplicate {
  if (row.run_id === null) fail("E_INTERNAL", "Stored webhook delivery has no run");
  return { kind: "duplicate", runId: row.run_id };
}

/**
 * Finds the run an earlier delivery already created for this one, or null when it is new.
 * Writes nothing. Two matches count:
 *
 * - The provider ID was seen within the window: the same payload returns the run it
 *   created, and a different payload is a conflict.
 * - The body was seen within the window under any ID, or with none: the replay returns
 *   the run it created. A provider retry with a new ID, or a captured request resent
 *   without one, therefore cannot start a second run.
 */
function findDuplicate(
  runtime: Runtime,
  input: WebhookClaimInput,
  key: string,
  cutoff: number,
): WebhookDuplicate | null {
  const sameKey = runtime.db
    .prepare(
      "SELECT fingerprint, run_id, created_at FROM webhook_deliveries WHERE hook_id = ? AND delivery_id = ?",
    )
    .get(input.hookId, key) as ClaimRow | undefined;
  if (sameKey !== undefined && sameKey.created_at >= cutoff) {
    if (input.deliveryId !== undefined && sameKey.fingerprint !== input.fingerprint) {
      fail("E_CONFLICT", "This delivery ID was already used for a different payload", {
        reason: "delivery_conflict",
      });
    }
    return duplicateOf(sameKey);
  }
  const replay = runtime.db
    .prepare(
      `SELECT fingerprint, run_id, created_at FROM webhook_deliveries
       WHERE hook_id = ? AND fingerprint = ? AND created_at >= ? LIMIT 1`,
    )
    .get(input.hookId, input.fingerprint, cutoff) as ClaimRow | undefined;
  return replay === undefined ? null : duplicateOf(replay);
}

/**
 * Read-only check for a retry of an accepted delivery: the same duplicate outcomes as
 * `claimDelivery` (including the reused-ID conflict), but a delivery that is new is reported
 * as `unseen` and nothing is claimed or written.
 */
export function peekDelivery(
  runtime: Runtime,
  input: WebhookClaimInput,
): WebhookDuplicate | { kind: "unseen" } {
  const cutoff = now(runtime) - WEBHOOK_DELIVERY_RETENTION_MS;
  const key = input.deliveryId ?? noIdKey(input.fingerprint);
  return findDuplicate(runtime, input, key, cutoff) ?? { kind: "unseen" };
}

/**
 * Claims one delivery for this hook, inside the caller's transaction: a duplicate (see
 * `findDuplicate`) returns the run it created; otherwise the delivery is claimed and the
 * caller binds its run to the returned key. Expired claims are reclaimed.
 */
export function claimDelivery(runtime: Runtime, input: WebhookClaimInput): WebhookClaim {
  const at = now(runtime);
  const cutoff = at - WEBHOOK_DELIVERY_RETENTION_MS;
  const key = input.deliveryId ?? noIdKey(input.fingerprint);
  const duplicate = findDuplicate(runtime, input, key, cutoff);
  if (duplicate !== null) return duplicate;
  // Anything still stored under this key is expired, since a fresh one would be a duplicate.
  runtime.db
    .prepare("DELETE FROM webhook_deliveries WHERE hook_id = ? AND delivery_id = ?")
    .run(input.hookId, key);
  runtime.db
    .prepare(
      `INSERT INTO webhook_deliveries (hook_id, delivery_id, fingerprint, run_id, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(input.hookId, key, input.fingerprint, at);
  // Each new claim sweeps a small batch of expired rows, so the table stays bounded
  // without a timer. The sweep runs in the caller's transaction.
  pruneExpiredDeliveries(runtime, DELIVERY_PRUNE_BATCH);
  return { kind: "claimed", key };
}

export function bindDeliveryRun(
  runtime: Runtime,
  hookId: string,
  key: string,
  runId: string,
): void {
  runtime.db
    .prepare("UPDATE webhook_deliveries SET run_id = ? WHERE hook_id = ? AND delivery_id = ?")
    .run(runId, hookId, key);
  runtime.db
    .prepare("UPDATE workflow_triggers SET last_delivery_at = ? WHERE id = ?")
    .run(now(runtime), hookId);
}

/** Bounded sweep of expired claims; returns how many rows were removed. */
export function pruneExpiredDeliveries(runtime: Runtime, limit: number): number {
  const cutoff = now(runtime) - WEBHOOK_DELIVERY_RETENTION_MS;
  const result = runtime.db
    .prepare(
      `DELETE FROM webhook_deliveries WHERE rowid IN (
         SELECT rowid FROM webhook_deliveries WHERE created_at < ? LIMIT ?)`,
    )
    .run(cutoff, limit) as { changes: number };
  return result.changes;
}

/** Signing secrets are registered for log and event redaction at startup. */
export function listTriggerSecrets(runtime: Runtime): string[] {
  const rows = runtime.db.prepare("SELECT signing_secret FROM workflow_triggers").all() as {
    signing_secret: string;
  }[];
  return rows.map((row) => row.signing_secret);
}
