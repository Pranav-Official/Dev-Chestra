import {
  type EventEnvelope,
  type ExecStatus,
  type ExecView,
  type JsonObject,
  type JsonValue,
  loopTerminalOutcome,
  type RunPauseReason,
  type RunStatus,
} from "@devchestra/core";
import type { NormalizedWorkflow } from "@devchestra/schema";
import type { RunDetailResponse } from "./dto.js";

/** Most `active` entries a compact status carries; the rest are counted in `activeTruncated`. */
export const COMPACT_MAX_ACTIVE = 10;
/** Most finished loop/foreach controllers a compact status carries. */
export const COMPACT_MAX_COMPLETED = 5;
const MAX_TEXT = 200;
const MAX_STATE_JSON = 240;
const MAX_STATE_KEYS = 8;
const MAX_STATE_STRING = 40;

export interface CompactActivity {
  /** ISO time of the last transcript write, null when no transcript exists yet. */
  updatedAt: string | null;
  /** Seconds since `updatedAt` (or since the node started when there is no transcript). */
  idleSec: number | null;
  /** First line of the most recent tool call, null when there has been none. */
  lastTool: string | null;
}

export interface CompactLoop {
  iteration: number;
  maxIterations: number | null;
  state: JsonObject;
  /** Terminal outcome once the loop has finished, null while it is still running. */
  outcome: "condition_met" | "iteration_limit" | null;
}

export interface CompactForeach {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  rejected: number;
}

export interface CompactChild {
  runId: string | null;
  workflowId: string | null;
  status: string | null;
}

export interface CompactExecution {
  path: string;
  kind: string | null;
  status: ExecStatus;
  attempt: number;
  validationAttempts: number;
  crashAttempts: number;
  startedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  lastError?: { code: string; message: string };
  loop?: CompactLoop;
  foreach?: CompactForeach;
  child?: CompactChild;
  activity?: CompactActivity;
}

export interface CompactCompleted {
  path: string;
  kind: "loop" | "foreach";
  status: ExecStatus;
  loop?: CompactLoop;
  foreach?: CompactForeach;
}

export type CompactAttention =
  | {
      type: "approval";
      path: string;
      requestId: string | null;
      message: string;
      irreversible: boolean;
      attempt: number | null;
      generation: number | null;
    }
  | { type: "paused"; reason: RunPauseReason | null; detail: string | null; path: string | null };

export interface CompactRunStatus {
  runId: string;
  workflow: string;
  status: RunStatus;
  pauseReason: RunPauseReason | null;
  elapsedMs: number | null;
  costUsd: number;
  tokens: number;
  /** Event id this status reflects; pass it to `run wait --after` to not miss changes. */
  cursor: number;
  /** Execution counts by status; zero counts are omitted. */
  nodes: Record<string, number>;
  active: CompactExecution[];
  activeTruncated?: number;
  completed: CompactCompleted[];
  needsAttention: CompactAttention[];
  lastError: { path: string; code: string; message: string } | null;
}

export interface CompactOptions {
  /** Epoch ms used for elapsed and idle figures; defaults to the current time. */
  now?: number;
  /** Transcript activity keyed by execution path, supplied by the caller. */
  activity?: Readonly<Record<string, CompactActivity>>;
  maxActive?: number;
}

type Detail = Pick<RunDetailResponse, "run" | "view" | "snapshot" | "watermark">;

const ACTIVE: ReadonlySet<ExecStatus> = new Set([
  "running",
  "validating",
  "waiting_approval",
  "waiting_quota",
  "failed",
  "interrupted",
  "rejected",
]);
const ACTIVE_ORDER: Record<string, number> = {
  failed: 0,
  interrupted: 0,
  rejected: 0,
  waiting_approval: 1,
  waiting_quota: 1,
  running: 2,
  validating: 2,
};

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Bounded view of a loop's carried state: small states verbatim, large ones as short scalars. */
function boundedState(state: JsonObject): JsonObject {
  if (JSON.stringify(state).length <= MAX_STATE_JSON) return state;
  const out: JsonObject = {};
  const entries = Object.entries(state);
  let kept = 0;
  for (const [key, value] of entries) {
    if (kept >= MAX_STATE_KEYS) break;
    const scalar =
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= MAX_STATE_STRING);
    if (!scalar) continue;
    out[key] = value as JsonValue;
    kept += 1;
  }
  const omitted = entries.length - kept;
  if (omitted > 0) out["…"] = omitted;
  return out;
}

function loopOf(exec: ExecView, maxIterations: number | undefined): CompactLoop | undefined {
  if (exec.loop === null) return undefined;
  return {
    iteration: exec.loop.iteration,
    maxIterations: maxIterations ?? null,
    state: boundedState(exec.loop.state),
    outcome: loopTerminalOutcome(exec.loop),
  };
}

function foreachOf(exec: ExecView): CompactForeach | undefined {
  const f = exec.foreach;
  if (f === null) return undefined;
  return {
    total: f.total,
    processed: f.processed,
    succeeded: f.succeeded,
    failed: f.failed,
    rejected: f.rejected,
  };
}

function bucket(status: ExecStatus): string {
  if (status === "ready") return "pending";
  if (status === "validating") return "running";
  if (status === "waiting_approval" || status === "waiting_quota") return "waiting";
  return status;
}

/**
 * Projects a run detail onto a small, bounded status for monitoring: run
 * state, counts, the executions that need a look, and loop/foreach progress.
 * Pure: it reads only the detail and the optional caller-supplied activity.
 */
export function compactRunStatus(detail: Detail, options: CompactOptions = {}): CompactRunStatus {
  const { run, view, snapshot } = detail;
  const now = options.now ?? Date.now();
  const maxActive = options.maxActive ?? COMPACT_MAX_ACTIVE;
  const loopMax = new Map<string, number>();
  for (const node of snapshot.graph.nodes) {
    if (node.type === "loop") loopMax.set(node.id, node.maxIterations);
  }

  const counts: Record<string, number> = {};
  const active: CompactExecution[] = [];
  const completed: CompactCompleted[] = [];
  const attention: CompactAttention[] = [];

  for (const exec of Object.values(view.executions)) {
    const key = bucket(exec.status);
    counts[key] = (counts[key] ?? 0) + 1;

    if (
      exec.status === "waiting_approval" &&
      exec.approvalRequest !== null &&
      exec.approvalDecision === null
    ) {
      const request = exec.approvalRequest;
      attention.push({
        type: "approval",
        path: exec.path,
        requestId: request.requestId,
        message: clip(request.message),
        irreversible: request.irreversible,
        attempt: request.attempt,
        generation: request.generation,
      });
    }

    if (ACTIVE.has(exec.status)) {
      const entry: CompactExecution = {
        path: exec.path,
        kind: exec.kind,
        status: exec.status,
        attempt: exec.attempt,
        validationAttempts: exec.validationAttempts,
        crashAttempts: exec.crashAttempts,
        startedAt: exec.startedAt,
        tokensIn: exec.tokensIn,
        tokensOut: exec.tokensOut,
        costUsd: exec.costUsd,
      };
      if (exec.lastError !== null) {
        entry.lastError = { code: exec.lastError.code, message: clip(exec.lastError.message) };
      }
      const loop = loopOf(exec, loopMax.get(exec.path));
      if (loop !== undefined) entry.loop = loop;
      const foreach = foreachOf(exec);
      if (foreach !== undefined) entry.foreach = foreach;
      if (exec.workflow !== null) {
        entry.child = {
          runId: exec.workflow.childRunId,
          workflowId: exec.workflow.workflowId,
          status: exec.workflow.status,
        };
      }
      const activity = options.activity?.[exec.path];
      if (activity !== undefined) entry.activity = activity;
      active.push(entry);
    } else if (
      (exec.kind === "loop" || exec.kind === "foreach") &&
      (exec.status === "succeeded" || exec.status === "cancelled")
    ) {
      const done: CompactCompleted = { path: exec.path, kind: exec.kind, status: exec.status };
      const loop = loopOf(exec, loopMax.get(exec.path));
      if (loop !== undefined) done.loop = loop;
      const foreach = foreachOf(exec);
      if (foreach !== undefined) done.foreach = foreach;
      completed.push(done);
    }
  }

  active.sort(
    (a, b) =>
      (ACTIVE_ORDER[a.status] ?? 3) - (ACTIVE_ORDER[b.status] ?? 3) ||
      (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  const result: CompactRunStatus = {
    runId: run.id,
    workflow: run.workflowId,
    status: view.status,
    pauseReason: view.pauseReason,
    elapsedMs: run.startedAt === null ? null : Math.max(0, (run.endedAt ?? now) - run.startedAt),
    costUsd: view.budget.usd,
    tokens: view.budget.tokens,
    cursor: detail.watermark,
    nodes: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    active: active.slice(0, maxActive),
    completed: completed.slice(-COMPACT_MAX_COMPLETED),
    needsAttention: attention,
    lastError: null,
  };
  if (active.length > maxActive) result.activeTruncated = active.length - maxActive;
  if (view.status === "paused") {
    result.needsAttention.push({
      type: "paused",
      reason: view.pauseReason,
      detail: view.pauseDetail === null ? null : clip(view.pauseDetail),
      path: view.pausePath,
    });
  }
  const lastError = view.errors.at(-1);
  if (lastError !== undefined) {
    result.lastError = {
      path: lastError.path,
      code: lastError.code,
      message: clip(lastError.message),
    };
  }
  return result;
}

/** What `run wait` is allowed to wake for. A finished run always ends the wait. */
export const WAIT_UNTIL = ["any", "node-done", "status", "approval"] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

export type WakeCategory = "node-done" | "status" | "approval" | "terminal";

export interface WakeReason {
  category: WakeCategory;
  /** Short human-readable cause, such as `node find#2/discover succeeded`. */
  reason: string;
}

/** Nodes that finish instantly on every run; their completion is never worth waking for. */
const TRIVIAL_KINDS: ReadonlySet<string> = new Set(["start", "gate", "join", "end"]);
const WAKING_NODE_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "rejected",
  "interrupted",
  "cancelled",
  "waiting_quota",
]);

/** The node kind a path refers to, resolved from the frozen workflow snapshot; null if unknown. */
export function kindOfPath(snapshot: NormalizedWorkflow, path: string): string | null {
  const last = path.split("/").at(-1) ?? path;
  const id = /^[a-z][a-z0-9_-]*/u.exec(last)?.[0];
  if (id === undefined) return null;
  const nested = path.includes("/");
  const bodies = snapshot.graph.nodes.flatMap((node) =>
    node.type === "loop" || node.type === "foreach" ? node.body.nodes : [],
  );
  const pool = nested ? [...bodies, ...snapshot.graph.nodes] : [...snapshot.graph.nodes, ...bodies];
  return pool.find((node) => node.id === id)?.type ?? null;
}

/**
 * Whether an event is worth waking a monitoring agent for, and why. Instant
 * start/gate/join/end nodes and token-usage chatter are ignored. `until`
 * narrows which categories wake the wait; a finished run always does.
 */
export function wakeReason(
  event: Pick<EventEnvelope, "type" | "path" | "payload">,
  kindOf: (path: string) => string | null,
  until: WaitUntil = "any",
): WakeReason | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const path = event.path as string;
  let found: WakeReason | null = null;
  switch (event.type) {
    case "run.completed":
    case "run.cancelled":
      return { category: "terminal", reason: `run ${event.type.slice(4)}` };
    case "run.paused":
      found = { category: "status", reason: "run paused" };
      break;
    case "run.resumed":
      found = { category: "status", reason: "run resumed" };
      break;
    case "approval.requested":
      found = { category: "approval", reason: `approval requested at ${path}` };
      break;
    case "approval.resolved":
      found = { category: "status", reason: `approval resolved at ${path}` };
      break;
    case "loop.iteration.decided":
      found = {
        category: "node-done",
        reason: `loop ${path} round ${String(payload.iteration)} decided`,
      };
      break;
    case "foreach.item.decided":
      found = {
        category: "node-done",
        reason: `foreach ${path} item ${String(payload.index)} ${String(payload.status)}`,
      };
      break;
    case "workflow.completed":
      found = {
        category: "node-done",
        reason: `child workflow at ${path} ${String(payload.status)}`,
      };
      break;
    case "node.state": {
      const to = String(payload.to);
      const kind = kindOf(path);
      if (WAKING_NODE_STATUSES.has(to) && !(kind !== null && TRIVIAL_KINDS.has(kind))) {
        found = { category: "node-done", reason: `node ${path} ${to}` };
      }
      break;
    }
    default:
      return null;
  }
  if (found === null) return null;
  return until === "any" ||
    until === found.category ||
    (until === "status" && event.type === "approval.requested")
    ? found
    : null;
}
