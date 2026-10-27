import type { ApprovalDecisionRef, ApprovalRequestRef, RunView } from "@relay/core";

export type FrozenApproval = ApprovalRequestRef & { path: string };
export type ResolvedApproval = ApprovalDecisionRef & { path: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Authority is the event-reduced RunView at the displayed view / replay cursor.
 * Do not rescan paginated event history to derive identity; the view's
 * approvalRequest/approvalDecision fields carry the exact persisted
 * requestId (opaque string) and attempt/generation. Missing/legacy identity
 * is read-only and cannot resolve.
 */
export function approvalForPath(
  view: RunView | null,
  path: string,
): { frozen: FrozenApproval | null; resolved: ResolvedApproval | null; pending: boolean } | null {
  if (view === null) return null;
  const exec = view.executions[path];
  if (!exec) return null;
  const req: ApprovalRequestRef | null = exec.approvalRequest;
  const dec: ApprovalDecisionRef | null = exec.approvalDecision;
  if (req === null && dec === null) return null;
  const frozen: FrozenApproval | null = req ? { ...req, path } : null;
  const resolved: ResolvedApproval | null = dec ? { ...dec, path } : null;
  // pending only when exec and run are still waiting_approval and no matching decision
  const runWaiting = view.status === "waiting_approval";
  const execWaiting = exec.status === "waiting_approval";
  const hasMatchingDecision =
    frozen !== null &&
    resolved !== null &&
    frozen.requestId !== null &&
    resolved.requestId === frozen.requestId;
  const pending = frozen !== null && !hasMatchingDecision && execWaiting && runWaiting;
  return { frozen, resolved, pending };
}

export function isActionable(
  frozen: FrozenApproval | null,
  execStatus: string | null,
  runStatus: string | null,
  isReplay: boolean,
  busy: string | null,
  done: string | null,
): boolean {
  if (frozen === null) return false;
  if (isReplay) return false;
  if (busy !== null) return false;
  if (done !== null) return false;
  if (execStatus !== "waiting_approval") return false;
  if (runStatus !== "waiting_approval") return false;
  if (!isNonEmptyString(frozen.requestId)) return false;
  if (!isPositiveInt(frozen.attempt)) return false;
  if (!isPositiveInt(frozen.generation)) return false;
  return true;
}

// Backwards compat helper for inbox deriving across many runs (uses view only, no event rescan)
export function deriveApprovalsFromViews(
  views: Record<string, RunView>,
): { runId: string; path: string; frozen: FrozenApproval }[] {
  const out: { runId: string; path: string; frozen: FrozenApproval }[] = [];
  for (const [runId, view] of Object.entries(views)) {
    for (const [path, exec] of Object.entries(view.executions)) {
      const req = exec.approvalRequest;
      const dec = exec.approvalDecision;
      if (req && (!dec || dec.requestId !== req.requestId)) {
        // inbox shows pending only when run is waiting_approval
        if (view.status === "waiting_approval" && exec.status === "waiting_approval") {
          out.push({ runId, path, frozen: { ...req, path } });
        }
      }
    }
  }
  return out;
}

export function renderMessage(message: string): string {
  return message;
}
