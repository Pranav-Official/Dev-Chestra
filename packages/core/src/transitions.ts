import { DevChestraError } from "./error.js";

export type ExecStatus =
  | "pending"
  | "ready"
  | "running"
  | "validating"
  | "waiting_approval"
  | "waiting_quota"
  | "succeeded"
  | "failed"
  | "skipped"
  | "rejected"
  | "cancelled"
  | "interrupted";

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export const EXEC_STATUSES = [
  "pending",
  "ready",
  "running",
  "validating",
  "waiting_approval",
  "waiting_quota",
  "succeeded",
  "failed",
  "skipped",
  "rejected",
  "cancelled",
  "interrupted",
] as const satisfies readonly ExecStatus[];

export const RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "waiting_approval",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const satisfies readonly RunStatus[];

export const ALLOWED_TRANSITIONS: Readonly<Record<ExecStatus, readonly ExecStatus[]>> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "waiting_quota", "skipped", "cancelled"],
  running: [
    "validating",
    "succeeded",
    "failed",
    "waiting_quota",
    "waiting_approval",
    "interrupted",
    "cancelled",
  ],
  // validating -> interrupted is required by boot recovery (spec 12.9) and was
  // missing from the transition table in spec 3.6.
  validating: ["succeeded", "running", "failed", "interrupted", "cancelled"],
  waiting_quota: ["ready", "running", "failed", "cancelled"],
  waiting_approval: ["succeeded", "rejected", "cancelled"],
  interrupted: ["ready", "cancelled"],
  succeeded: ["pending"],
  failed: ["pending"],
  skipped: ["pending"],
  rejected: ["pending"],
  cancelled: ["pending"],
};

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "paused", "cancelled", "failed"],
  running: ["paused", "waiting_approval", "succeeded", "failed", "rejected", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  waiting_approval: ["running", "paused", "succeeded", "failed", "rejected", "cancelled"],
  succeeded: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

const TERMINAL_EXEC = new Set<ExecStatus>([
  "succeeded",
  "failed",
  "skipped",
  "rejected",
  "cancelled",
]);
const TERMINAL_RUN = new Set<RunStatus>(["succeeded", "failed", "rejected", "cancelled"]);

export function canTransition(from: ExecStatus, to: ExecStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecStatus, to: ExecStatus): void {
  if (!canTransition(from, to)) {
    throw new DevChestraError("E_INTERNAL", `Illegal execution transition: ${from} -> ${to}`, {
      details: { from, to },
    });
  }
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) {
    throw new DevChestraError("E_INTERNAL", `Illegal run transition: ${from} -> ${to}`, {
      details: { from, to },
    });
  }
}

export function isTerminalExecStatus(status: ExecStatus): boolean {
  return TERMINAL_EXEC.has(status);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN.has(status);
}
