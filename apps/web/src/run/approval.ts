import type { ApprovalDecisionRef, ApprovalRequestRef, RunView } from "@devchestra/core";

export type FrozenApproval = ApprovalRequestRef & { path: string };
export type ResolvedApproval = ApprovalDecisionRef & { path: string };

/**
 * Single predicate for "is this approval still awaiting a decision".
 * Unifies the detail view and the inbox, which previously disagreed on
 * legacy null-`requestId` pairs (TD-011): a stored decision whose `requestId`
 * matches the request — including the legacy pair where both sides are null
 * (replay-safe, never resolvable, but answered) — is not pending. A request
 * with no decision yet is pending while both the run and the execution are
 * still `waiting_approval`.
 */
export function isApprovalPending(
  req: ApprovalRequestRef | null,
  dec: ApprovalDecisionRef | null,
  runStatus: string | null | undefined,
  execStatus: string | null | undefined,
): boolean {
  if (req === null) return false;
  if (runStatus !== "waiting_approval" || execStatus !== "waiting_approval") return false;
  if (dec === null) return true;
  if (req.requestId === null || dec.requestId === null) {
    return req.requestId !== dec.requestId;
  }
  return dec.requestId !== req.requestId;
}

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
  const pending = isApprovalPending(req, dec, view.status, exec.status);
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
      // inbox shows pending only when run is waiting_approval (same rule as
      // the detail view via isApprovalPending, including legacy null IDs)
      if (req && isApprovalPending(req, dec, view.status, exec.status)) {
        out.push({ runId, path, frozen: { ...req, path } });
      }
    }
  }
  return out;
}

export function renderMessage(message: string): string {
  return message;
}
