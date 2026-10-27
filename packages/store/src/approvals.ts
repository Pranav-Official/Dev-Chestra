import type { ExecutionIdentity, Path, RunId } from "@relay/core";
import {
  hasRejectedEdge,
  stableRequestId,
  validateBy,
  validateCriteria,
  validateMessage,
  validateNote,
} from "./approval-helpers.js";
import { appendEvents } from "./events.js";
import { requireCurrent } from "./executions.js";
import { hashJsonSync } from "./hash.js";
import { getOutput } from "./outputs.js";
import { assertRunActive, loadView } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import { fail, parseJson } from "./util.js";
export interface RequestApprovalInput {
  identity: ExecutionIdentity;
  message: string;
  irreversible?: boolean;
  criteria?: string[];
}
export interface RequestApprovalResult {
  duplicate: boolean;
  requestId: string;
  requestEventId: number | null;
  waitingEventId: number | null;
}
export interface ResolveApprovalInput {
  identity: ExecutionIdentity;
  requestId: string;
  decision: "approve" | "reject";
  by: string;
  note?: string;
}
export interface ResolveApprovalResult {
  duplicate: boolean;
  resolvedEventId: number | null;
  completionEventId: number | null;
  runCompletedEventId: number | null;
  output: { id: string; hash: string } | null;
}
export interface ApprovalRecord {
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  requestId: string;
  message: string;
  irreversible: boolean;
  criteria: string[] | null;
  requestedEventId: number;
  decision: "approve" | "reject" | null;
  by: string | null;
  note: string | null;
  resolvedEventId: number | null;
  status: string;
}
export function requestApproval(
  runtime: Runtime,
  input: RequestApprovalInput,
): RequestApprovalResult {
  const message = validateMessage(input.message);
  const irreversible = input.irreversible ?? false;
  const criteria = validateCriteria(input.criteria);
  const secretFinding = runtime.secrets.scanValue(message) ?? runtime.secrets.scanValue(criteria);
  if (secretFinding)
    fail("E_VALIDATION", "Approval request contains a secret", {
      path: secretFinding.path,
      source: secretFinding.source,
      label: secretFinding.label,
    });
  const byIdentity = input.identity;
  assertRunActive(runtime, byIdentity.runId);
  const row = requireCurrent(runtime, byIdentity);
  if (row.kind !== "approval")
    fail("E_CONFLICT", `Execution ${byIdentity.path} is not approval`, { kind: row.kind });
  const view = loadView(runtime, byIdentity.runId);
  const exec = view.executions[byIdentity.path];
  if (!exec) fail("E_NOT_FOUND", `Execution ${byIdentity.path} not projected`);
  if (exec.status !== "running" && exec.status !== "validating") {
    if (exec.status !== "waiting_approval")
      fail("E_CONFLICT", `Cannot request approval from status ${exec.status}`);
  }
  const requestId = stableRequestId(byIdentity);
  const existing = runtime.db
    .prepare(
      "SELECT request_id, message, irreversible, criteria_json FROM approvals WHERE run_id=? AND path=? AND attempt=? AND generation=?",
    )
    .get(byIdentity.runId, byIdentity.path, byIdentity.attempt, byIdentity.generation) as
    | { request_id: string; message: string; irreversible: number; criteria_json: string | null }
    | undefined;
  if (existing) {
    const same =
      existing.request_id === requestId &&
      existing.message === message &&
      !!existing.irreversible === irreversible &&
      (existing.criteria_json ?? null) === (criteria ? JSON.stringify(criteria) : null);
    if (same) return { duplicate: true, requestId, requestEventId: null, waitingEventId: null };
    fail("E_CONFLICT", "Approval request is immutable", { existing });
  }
  if (exec.approvalRequest !== null) {
    const cur = exec.approvalRequest;
    const same =
      cur.requestId === requestId &&
      cur.message === message &&
      cur.irreversible === irreversible &&
      JSON.stringify(cur.criteria) === JSON.stringify(criteria);
    if (same) return { duplicate: true, requestId, requestEventId: null, waitingEventId: null };
    fail("E_CONFLICT", "Approval request already recorded differently", { existing: cur });
  }
  const from = exec.status as string;
  if (from !== "running" && from !== "validating")
    fail("E_CONFLICT", `Cannot request approval from status ${from}`);
  const events = appendEvents(runtime, byIdentity.runId, [
    {
      runId: byIdentity.runId,
      path: byIdentity.path,
      type: "approval.requested",
      actor: "engine",
      payload: {
        message,
        irreversible,
        ...(criteria ? { criteria } : {}),
        requestId,
        attempt: byIdentity.attempt,
        generation: byIdentity.generation,
        autoApprove: false,
      },
    } as never,
    {
      runId: byIdentity.runId,
      path: byIdentity.path,
      type: "node.state",
      actor: "engine",
      payload: {
        from,
        to: "waiting_approval",
        attempt: byIdentity.attempt,
        generation: byIdentity.generation,
      },
    } as never,
  ]);
  const reqEvent = events[0];
  if (!reqEvent) fail("E_INTERNAL", "Approval request event not appended");
  runtime.db
    .prepare(
      `INSERT INTO approvals (run_id, path, attempt, generation, request_id, message, irreversible, criteria_json, requested_event_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      byIdentity.runId,
      byIdentity.path,
      byIdentity.attempt,
      byIdentity.generation,
      requestId,
      message,
      irreversible ? 1 : 0,
      criteria ? JSON.stringify(criteria) : null,
      reqEvent.id,
      now(runtime),
    );
  return {
    duplicate: false,
    requestId,
    requestEventId: reqEvent.id,
    waitingEventId: events[1]?.id ?? null,
  };
}
export function resolveApproval(
  runtime: Runtime,
  input: ResolveApprovalInput,
): ResolveApprovalResult {
  const by = validateBy(input.by);
  const note = validateNote(input.note);
  if (input.decision !== "approve" && input.decision !== "reject")
    fail("E_VALIDATION", "decision must be approve or reject");
  if (typeof input.requestId !== "string" || input.requestId.trim() === "")
    fail("E_VALIDATION", "requestId required");
  const secretNote = runtime.secrets.scanValue(note);
  const secretBy = runtime.secrets.scanValue(by);
  const finding = secretNote ?? secretBy;
  if (finding)
    fail("E_VALIDATION", "Approval resolution contains a secret", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  const requestId = input.requestId.trim();
  const id = input.identity;
  const viewBefore = loadView(runtime, id.runId);
  const execBefore = viewBefore.executions[id.path];
  // Fence stale retry: current execution identity must match submitted identity BEFORE duplicate check.
  // Same resolved old request ID after NEW attempt begins must be E_CONFLICT, not duplicate.
  if (
    execBefore &&
    (execBefore.attempt !== id.attempt || execBefore.generation !== id.generation)
  ) {
    fail("E_CONFLICT", "Stale execution identity; a newer attempt/generation is active", {
      expected: { attempt: execBefore.attempt, generation: execBefore.generation },
      received: { attempt: id.attempt, generation: id.generation },
    });
  }
  const stored = runtime.db
    .prepare(
      "SELECT request_id, decision, decided_by, note, resolved_event_id FROM approvals WHERE run_id=? AND path=? AND attempt=? AND generation=?",
    )
    .get(id.runId, id.path, id.attempt, id.generation) as
    | {
        request_id: string;
        decision: string | null;
        decided_by: string | null;
        note: string | null;
        resolved_event_id: number | null;
      }
    | undefined;
  if (stored && stored.decision !== null) {
    const same =
      stored.request_id === requestId &&
      stored.decision === input.decision &&
      (stored.decided_by ?? "") === by &&
      (stored.note ?? null) === note;
    if (same) {
      const out = getOutput(runtime, id.runId, id.path, id.attempt);
      return {
        duplicate: true,
        resolvedEventId: stored.resolved_event_id,
        completionEventId: stored.resolved_event_id,
        runCompletedEventId: null,
        output: out ? { id: out.id, hash: out.hash } : null,
      };
    }
    fail("E_CONFLICT", "Approval decision is immutable", { existing: stored });
  }
  if (execBefore?.approvalDecision) {
    const cur = execBefore.approvalDecision;
    const same =
      cur.requestId === requestId &&
      cur.decision === input.decision &&
      cur.by === by &&
      (cur.note ?? null) === note;
    if (same) {
      const out = getOutput(runtime, id.runId, id.path, id.attempt);
      return {
        duplicate: true,
        resolvedEventId: cur.eventId,
        completionEventId: cur.eventId,
        runCompletedEventId: null,
        output: out ? { id: out.id, hash: out.hash } : null,
      };
    }
    fail("E_CONFLICT", "Approval already decided", { existing: cur });
  }
  if (stored && stored.request_id !== requestId)
    fail("E_CONFLICT", "Stale requestId", { expected: stored.request_id, received: requestId });
  if (execBefore?.approvalRequest && execBefore.approvalRequest.requestId !== requestId)
    fail("E_CONFLICT", "Stale requestId; path was retried", {
      expected: execBefore.approvalRequest.requestId,
      received: requestId,
    });
  assertRunActive(runtime, id.runId);
  const row = requireCurrent(runtime, id);
  if (row.kind !== "approval") fail("E_CONFLICT", `Execution ${id.path} is not approval`);
  const view = loadView(runtime, id.runId);
  const exec = view.executions[id.path];
  if (!exec) fail("E_NOT_FOUND", "Execution not projected");
  if (exec.status !== "waiting_approval")
    fail("E_CONFLICT", `Cannot resolve approval from status ${exec.status}`);
  if (!exec.approvalRequest) fail("E_CONFLICT", "No durable approval request for this generation");
  if (exec.approvalRequest.requestId !== requestId)
    fail("E_CONFLICT", "Stale requestId", {
      expected: exec.approvalRequest.requestId,
      received: requestId,
    });
  if (exec.approvalDecision) fail("E_CONFLICT", "Already decided");
  const runRec = runtime.db.prepare("SELECT snapshot_json FROM runs WHERE id=?").get(id.runId) as
    | { snapshot_json: string }
    | undefined;
  const snapshot = runRec ? parseJson(runRec.snapshot_json) : null;
  const hasRejected = hasRejectedEdge(snapshot, exec.nodeId);
  const targetStatus = input.decision === "approve" || hasRejected ? "succeeded" : "rejected";
  const outputJson = { decision: input.decision, by, ...(note ? { note } : {}), requestId };
  const outSecret = runtime.secrets.scanValue(outputJson);
  if (outSecret)
    fail("E_VALIDATION", "Approval output contains a secret", {
      path: outSecret.path,
      source: outSecret.source,
      label: outSecret.label,
    });
  const hash = hashJsonSync(outputJson);
  const outputText = JSON.stringify(outputJson);
  const existingOut = getOutput(runtime, id.runId, id.path, id.attempt);
  let outputId: string | null = existingOut?.id ?? null;
  if (!existingOut) {
    outputId = runtime.idGen.entryId();
    runtime.db
      .prepare(
        `INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at) VALUES (?,?,?,?,?,'output',?,?,?,?)`,
      )
      .run(
        outputId,
        id.runId,
        id.path,
        id.attempt,
        id.generation,
        hash,
        Buffer.byteLength(outputText, "utf8"),
        outputText,
        now(runtime),
      );
    const [ev] = appendEvents(runtime, id.runId, [
      {
        runId: id.runId,
        path: id.path,
        type: "node.output.recorded",
        actor: "engine",
        payload: { attempt: id.attempt, generation: id.generation, outputId, outputHash: hash },
      } as never,
    ]);
    void ev;
  } else if (existingOut.hash !== hash)
    fail("E_CONFLICT", "Approval already recorded different output");
  const eventsToAppend: never[] = [];
  eventsToAppend.push({
    runId: id.runId,
    path: id.path,
    type: "approval.resolved",
    actor: "user",
    payload: {
      decision: input.decision,
      by,
      ...(note ? { note } : {}),
      requestId,
      attempt: id.attempt,
      generation: id.generation,
    },
  } as never);
  eventsToAppend.push({
    runId: id.runId,
    path: id.path,
    type: "node.state",
    actor: "engine",
    payload: {
      from: "waiting_approval",
      to: targetStatus,
      attempt: id.attempt,
      generation: id.generation,
    },
  } as never);
  if (targetStatus === "rejected")
    eventsToAppend.push({
      runId: id.runId,
      path: "" as Path,
      type: "run.completed",
      actor: "engine",
      payload: { status: "rejected" },
    } as never);
  const appended = appendEvents(runtime, id.runId, eventsToAppend);
  const resolvedEvent = appended[0];
  const completionEvent = appended[1];
  const runCompleted = appended[2];
  if (!resolvedEvent || !completionEvent)
    fail("E_INTERNAL", "Approval resolve events not appended");
  if (stored) {
    runtime.db
      .prepare(
        `UPDATE approvals SET decision=?, decided_by=?, note=?, resolved_event_id=?, resolved_at=? WHERE run_id=? AND path=? AND attempt=? AND generation=?`,
      )
      .run(
        input.decision,
        by,
        note,
        resolvedEvent.id,
        now(runtime),
        id.runId,
        id.path,
        id.attempt,
        id.generation,
      );
  } else {
    const req = exec.approvalRequest;
    if (!req) fail("E_INTERNAL", "Missing approval request for legacy insert");
    runtime.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (run_id, path, attempt, generation, request_id, message, irreversible, criteria_json, requested_event_id, decision, decided_by, note, resolved_event_id, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id.runId,
        id.path,
        id.attempt,
        id.generation,
        req.requestId,
        req.message,
        req.irreversible ? 1 : 0,
        req.criteria ? JSON.stringify(req.criteria) : null,
        req.eventId,
        input.decision,
        by,
        note,
        resolvedEvent.id,
        now(runtime) - 1,
        now(runtime),
      );
  }
  if (targetStatus === "succeeded")
    runtime.db
      .prepare(
        `INSERT OR IGNORE INTO approval_wakes (run_id, path, attempt, generation, request_id, decision, created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id.runId, id.path, id.attempt, id.generation, requestId, input.decision, now(runtime));
  return {
    duplicate: false,
    resolvedEventId: resolvedEvent.id,
    completionEventId: completionEvent.id,
    runCompletedEventId: runCompleted?.id ?? null,
    output: outputId ? { id: outputId, hash } : null,
  };
}
export function getApproval(runtime: Runtime, identity: ExecutionIdentity): ApprovalRecord | null {
  const row = runtime.db
    .prepare(
      `SELECT run_id, path, attempt, generation, request_id, message, irreversible, criteria_json, requested_event_id, decision, decided_by, note, resolved_event_id FROM approvals WHERE run_id=? AND path=? AND attempt=? AND generation=?`,
    )
    .get(identity.runId, identity.path, identity.attempt, identity.generation) as
    | {
        run_id: string;
        path: string;
        attempt: number;
        generation: number;
        request_id: string;
        message: string;
        irreversible: number;
        criteria_json: string | null;
        requested_event_id: number;
        decision: string | null;
        decided_by: string | null;
        note: string | null;
        resolved_event_id: number | null;
      }
    | undefined;
  if (!row) return null;
  const view = loadView(runtime, identity.runId as RunId);
  const status = view.executions[identity.path]?.status ?? "unknown";
  return {
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    requestId: row.request_id,
    message: row.message,
    irreversible: !!row.irreversible,
    criteria: row.criteria_json ? (parseJson(row.criteria_json) as string[]) : null,
    requestedEventId: row.requested_event_id,
    decision: row.decision as never,
    by: row.decided_by,
    note: row.note,
    resolvedEventId: row.resolved_event_id,
    status,
  };
}
export function listPendingApprovals(
  runtime: Runtime,
  filter?: { projectId?: string; runId?: RunId },
): ApprovalRecord[] {
  const where: string[] = ["a.decision IS NULL"];
  const params: unknown[] = [];
  if (filter?.runId) {
    where.push("a.run_id = ?");
    params.push(filter.runId);
  }
  if (filter?.projectId) {
    where.push("r.project_id = ?");
    params.push(filter.projectId);
  }
  where.push("r.status = 'waiting_approval'");
  const sql = `SELECT a.run_id, a.path, a.attempt, a.generation, a.request_id, a.message, a.irreversible, a.criteria_json, a.requested_event_id, a.decision, a.decided_by, a.note, a.resolved_event_id, r.status as run_status FROM approvals a JOIN runs r ON r.id=a.run_id WHERE ${where.join(" AND ")} ORDER BY a.created_at ASC`;
  const rows = runtime.db.prepare(sql).all(...params) as {
    run_id: string;
    path: string;
    attempt: number;
    generation: number;
    request_id: string;
    message: string;
    irreversible: number;
    criteria_json: string | null;
    requested_event_id: number;
    decision: string | null;
    decided_by: string | null;
    note: string | null;
    resolved_event_id: number | null;
    run_status: string;
  }[];
  return rows.map((row) => ({
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    requestId: row.request_id,
    message: row.message,
    irreversible: !!row.irreversible,
    criteria: row.criteria_json ? (parseJson(row.criteria_json) as string[]) : null,
    requestedEventId: row.requested_event_id,
    decision: row.decision as never,
    by: row.decided_by,
    note: row.note,
    resolvedEventId: row.resolved_event_id,
    status: row.run_status,
  }));
}
export interface ApprovalWake {
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  requestId: string;
  decision: "approve" | "reject";
}
export function listOutstandingApprovalWakes(runtime: Runtime, runId?: RunId): ApprovalWake[] {
  const sql =
    runId === undefined
      ? `SELECT run_id, path, attempt, generation, request_id, decision FROM approval_wakes WHERE consumed_at IS NULL`
      : `SELECT run_id, path, attempt, generation, request_id, decision FROM approval_wakes WHERE consumed_at IS NULL AND run_id = ?`;
  const rows = (
    runId === undefined ? runtime.db.prepare(sql).all() : runtime.db.prepare(sql).all(runId)
  ) as {
    run_id: string;
    path: string;
    attempt: number;
    generation: number;
    request_id: string;
    decision: string;
  }[];
  return rows.map((r) => ({
    runId: r.run_id as RunId,
    path: r.path as Path,
    attempt: r.attempt,
    generation: r.generation,
    requestId: r.request_id,
    decision: r.decision as "approve" | "reject",
  }));
}
export function consumeApprovalWake(
  runtime: Runtime,
  identity: ExecutionIdentity,
  requestId: string,
): boolean {
  const res = runtime.db
    .prepare(
      `UPDATE approval_wakes SET consumed_at=? WHERE run_id=? AND path=? AND attempt=? AND generation=? AND request_id=? AND consumed_at IS NULL`,
    )
    .run(
      now(runtime),
      identity.runId,
      identity.path,
      identity.attempt,
      identity.generation,
      requestId,
    );
  return res.changes > 0;
}
