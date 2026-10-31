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
  const inFlight = executions.find(
    (exec) => exec.status === "running" || exec.status === "validating",
  );
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
      reason = inFlight === undefined ? null : nodeName(inFlight.nodeId);
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

function pickFailed(executions: ExecView[], errorPath: string | null): ExecView | null {
  const failing = executions.filter(
    (exec) => exec.status === "failed" || exec.status === "rejected",
  );
  return failing.find((exec) => exec.path === errorPath) ?? failing[0] ?? null;
}
