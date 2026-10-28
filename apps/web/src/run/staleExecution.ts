import { isTerminalRunStatus, type RunStatus } from "@relay/core";
import { statusLabel } from "../ui/StatusPill.js";

/**
 * Execution states that imply the engine is still working on the node. When
 * the run itself is already terminal, one of these is stale historical data
 * (older engines persisted the run outcome without writing a terminal event
 * for every in-flight execution). The reducer and raw evidence are left
 * untouched; callers use this only to present the gap honestly.
 */
const LIVE_EXECUTION: ReadonlySet<string> = new Set([
  "running",
  "validating",
  "waiting_quota",
  "waiting_approval",
]);

export function isUnresolvedExecution(runStatus: RunStatus | string, execStatus: string): boolean {
  if (!LIVE_EXECUTION.has(execStatus)) return false;
  return isTerminalRunStatus(runStatus as RunStatus);
}

/** Human sentence for the unresolved warning, e.g. "Run failed · reported Running". */
export function unresolvedSummary(runStatus: RunStatus | string, execStatus: string): string {
  return `Run ${statusLabel(runStatus)} · reported ${statusLabel(execStatus)}`;
}
