import { type EventEnvelope, isDevChestraError } from "@devchestra/core";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface RunOutcomeLike {
  runId: string;
  status: string;
  result?: unknown;
  pausedReason?: string;
  error?: { code: string; message: string };
}

const SALIENT = new Set([
  "run.created",
  "run.started",
  "run.workspace_waiting",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "node.state",
  "node.attempt.started",
  "node.session.captured",
  "node.input.resolved",
  "node.output.rejected",
  "node.output.validated",
  "node.output.recorded",
  "node.process.spawned",
  "node.process.stopped",
  "node.workspace.finalized",
  "node.watchdog",
  "node.usage",
  "gate.decided",
  "join.resolved",
  "quota.blocked",
  "quota.released",
  "budget.threshold",
  "budget.exceeded",
  "error.logged",
]);

export function isSalient(type: string): boolean {
  return SALIENT.has(type);
}

export function exitCodeForOutcome(outcome: RunOutcomeLike): ExitCode {
  if (
    outcome.status === "failed" &&
    (outcome.error?.code === "E_JOIN_CONFLICT" || outcome.error?.code === "E_WORKFLOW_INVALID")
  ) {
    return 4;
  }
  switch (outcome.status) {
    case "succeeded":
      return 0;
    case "rejected":
      return 2;
    case "cancelled":
      return 3;
    case "failed":
      return 1;
    case "paused":
      switch (outcome.pausedReason) {
        case "budget":
        case "quota":
          return 6;
        case "uncertain_side_effect":
        case "approval_cap":
        case "user":
          return 5;
        default:
          return 1;
      }
    default:
      return 1;
  }
}

export function exitCodeForError(error: unknown): ExitCode {
  if (!isDevChestraError(error)) {
    return 1;
  }
  const code = error.code;
  if (code === "E_CANCELLED") return 3;
  if (code === "E_BUDGET" || code === "E_QUOTA_WINDOW" || code === "E_QUOTA_CREDITS") return 6;
  if (code === "E_AUTH" || code === "E_CLI_AUTH") return 5;
  if (
    code === "E_VALIDATION" ||
    code === "E_WORKFLOW_INVALID" ||
    code === "E_NOT_FOUND" ||
    code === "E_CONFLICT" ||
    code === "E_FORBIDDEN_PATH" ||
    code === "E_CLI_MISSING" ||
    code === "E_CLI_DISABLED" ||
    code === "E_WORKSPACE" ||
    code === "E_EXPR" ||
    code === "E_LOCKED" ||
    code === "E_JOIN_CONFLICT" ||
    code === "E_LOOP_LIMIT"
  ) {
    return 4;
  }
  return 1;
}

export function safeError(error: unknown): { code: string; message: string } {
  if (isDevChestraError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: "E_INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

export function writeEvent(event: EventEnvelope, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (!isSalient(event.type)) {
    return;
  }
  const payload = event.payload as Record<string, unknown>;
  const detail =
    typeof payload.to === "string"
      ? ` -> ${payload.to}`
      : typeof payload.status === "string"
        ? ` ${payload.status}`
        : typeof payload.branch === "string"
          ? ` ${payload.branch}`
          : "";
  const path = event.path === "" ? "" : ` ${event.path}`;
  process.stdout.write(`${event.type}${path}${detail}\n`);
}

export function writeSummary(summary: Record<string, unknown>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "summary", ...summary })}\n`);
    return;
  }
  const status = String(summary.status ?? "unknown");
  const runId = String(summary.runId ?? "");
  const paused = summary.pausedReason === undefined ? "" : ` (${String(summary.pausedReason)})`;
  process.stdout.write(`run ${runId}: ${status}${paused}\n`);
  if (summary.error !== undefined) {
    const error = summary.error as { code?: unknown; message?: unknown };
    process.stdout.write(
      `error ${String(error.code ?? "E_INTERNAL")}: ${String(error.message ?? "")}\n`,
    );
  }
  if (summary.hint !== undefined) {
    process.stdout.write(`${String(summary.hint)}\n`);
  }
}

export function notice(message: string): void {
  process.stderr.write(`devchestra: ${message}\n`);
}
