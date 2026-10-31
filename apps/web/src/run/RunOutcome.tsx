import type { ExecView, RunView } from "@devchestra/core";
import { StatusPill } from "../ui/StatusPill.js";

/**
 * The run's one status: a status pill, plus the reason it stands there when
 * there is one. A failure names the step and links to its error. A wait names
 * the step it is waiting on and links to it. A success needs no reason.
 */
export function RunOutcome({
  view,
  nodeName,
  onSelectPath,
}: {
  view: RunView;
  nodeName: (nodeId: string) => string;
  onSelectPath: (path: string) => void;
}) {
  const executions = Object.values(view.executions);
  const lastError = view.errors.at(-1) ?? null;
  const failed = pickFailed(executions, lastError?.path ?? null);
  const inFlight = pickInFlight(executions);
  const approval = executions.find((exec) => exec.status === "waiting_approval");

  let reason: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  switch (view.status) {
    case "failed":
    case "rejected": {
      const message = lastError?.message ?? "No error details were recorded.";
      reason = failed === null ? message : `at ${nodeName(failed.nodeId)}: ${message}`;
      if (failed !== null)
        action = { label: "View error", onClick: () => onSelectPath(failed.path) };
      break;
    }
    case "paused":
      reason = view.pauseDetail;
      break;
    case "waiting_approval":
      if (approval !== undefined) {
        reason = `at ${nodeName(approval.nodeId)}`;
        action = { label: "Review", onClick: () => onSelectPath(approval.path) };
      }
      break;
    case "running":
    case "queued":
      if (inFlight !== null) {
        reason =
          inFlight.status === "waiting_quota"
            ? `waiting for provider quota at ${nodeName(inFlight.nodeId)}`
            : nodeName(inFlight.nodeId);
      }
      break;
    default:
      break;
  }

  return (
    <div className="run-outcome" role="status" data-testid="run-outcome">
      <StatusPill status={view.status} testId="run-status" />
      {reason === null ? null : <span className="msg">{reason}</span>}
      {action === null ? null : (
        <button type="button" className="btn sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** The failed step the run's last error belongs to, matched by path only. */
function pickFailed(executions: ExecView[], errorPath: string | null): ExecView | null {
  if (errorPath === null || errorPath === "") return null;
  return (
    executions.find(
      (exec) => exec.path === errorPath && (exec.status === "failed" || exec.status === "rejected"),
    ) ?? null
  );
}

/**
 * The step a live run is on. Parallel branches can all be active, so the
 * choice is deterministic: a running step beats a quota wait, and within each
 * group the most recently started step wins, ties broken by path. Queued steps
 * that have not started give no reason.
 */
function pickInFlight(executions: ExecView[]): ExecView | null {
  const byRecency = (a: ExecView, b: ExecView) =>
    (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || a.path.localeCompare(b.path);
  const active = executions
    .filter((exec) => exec.status === "running" || exec.status === "validating")
    .sort(byRecency);
  if (active[0] !== undefined) return active[0];
  const waiting = executions.filter((exec) => exec.status === "waiting_quota").sort(byRecency);
  return waiting[0] ?? null;
}
