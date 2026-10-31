import type { ExecView, RunView } from "@devchestra/core";
import { Ban, CheckCircle2, Clock3, PauseCircle, TriangleAlert } from "lucide-react";

/**
 * One line under the run header that says how the run stands and, when it
 * failed, where. Non-success outcomes link to the step so the reason is one
 * click away instead of at the bottom of the Details panel.
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

  switch (view.status) {
    case "succeeded":
      return <Line tone="ok" Icon={CheckCircle2} text="Run completed." />;
    case "failed":
    case "rejected": {
      const where = failed === null ? "the run" : nodeName(failed.nodeId);
      const message = lastError?.message ?? "No error details were recorded.";
      return (
        <Line
          tone="bad"
          Icon={TriangleAlert}
          text={`Failed at ${where}: ${message}`}
          {...(failed === null
            ? {}
            : { action: { label: "View error", onClick: () => onSelectPath(failed.path) } })}
        />
      );
    }
    case "cancelled":
      return <Line tone="bad" Icon={Ban} text="Run was cancelled." />;
    case "paused":
      return <Line tone="warn" Icon={PauseCircle} text={view.pauseDetail ?? "Run is paused."} />;
    case "waiting_approval":
      return (
        <Line
          tone="warn"
          Icon={Clock3}
          text={`Waiting for approval at ${approval === undefined ? "a step" : nodeName(approval.nodeId)}.`}
          {...(approval === undefined
            ? {}
            : { action: { label: "Review", onClick: () => onSelectPath(approval.path) } })}
        />
      );
    default:
      return (
        <Line
          tone="info"
          Icon={Clock3}
          text={
            inFlight === undefined ? "Waiting to start." : `Running ${nodeName(inFlight.nodeId)}.`
          }
        />
      );
  }
}

function pickFailed(executions: ExecView[], errorPath: string | null): ExecView | null {
  const failing = executions.filter(
    (exec) => exec.status === "failed" || exec.status === "rejected",
  );
  return failing.find((exec) => exec.path === errorPath) ?? failing[0] ?? null;
}

function Line({
  tone,
  Icon,
  text,
  action,
}: {
  tone: "ok" | "bad" | "warn" | "info";
  Icon: typeof CheckCircle2;
  text: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={`run-outcome ${tone}`} role="status" data-testid="run-outcome">
      <Icon size={14} aria-hidden="true" />
      <span className="msg">{text}</span>
      {action ? (
        <button type="button" className="btn sm" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
