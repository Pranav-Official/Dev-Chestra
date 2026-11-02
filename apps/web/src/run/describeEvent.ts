import type { EventEnvelope } from "@devchestra/core";

export type EventFilter = "all" | "errors" | "supervisor" | "quota";

const EVENT_LABELS: Record<string, string> = {
  "run.created": "Run created",
  "run.started": "Run started",
  "run.workspace_waiting": "Waiting for workspace",
  "run.paused": "Run paused",
  "run.resumed": "Run resumed",
  "run.cancelled": "Run cancelled",
  "run.completed": "Run completed",
  "run.override.added": "Guidance added",
  "node.state": "Node state",
  "node.attempt.started": "Attempt started",
  "node.session.captured": "Session saved",
  "node.input.resolved": "Input resolved",
  "node.output.rejected": "Output rejected",
  "node.output.validated": "Output validated",
  "node.output.recorded": "Output recorded",
  "node.usage": "Usage",
  "node.transcript.ref": "Transcript updated",
  "node.watchdog": "Watchdog",
  "node.process.spawned": "Process started",
  "node.process.stopped": "Process stopped",
  "node.workspace.finalized": "Workspace finalized",
  "gate.decided": "Gate decided",
  "decision.requested": "Decision requested",
  "decision.answered": "Decision answered",
  "approval.requested": "Approval requested",
  "approval.resolved": "Approval resolved",
  "map.started": "Map started",
  "map.item.state": "Map item",
  "map.completed": "Map completed",
  "loop.round.started": "Loop round started",
  "loop.round.completed": "Loop round completed",
  "loop.exited": "Loop exited",
  "join.resolved": "Join resolved",
  "quota.blocked": "Quota blocked",
  "quota.released": "Quota released",
  "budget.threshold": "Budget threshold",
  "budget.exceeded": "Budget exceeded",
  "workspace.created": "Workspace created",
  "workspace.committed": "Workspace committed",
  "workspace.removed": "Workspace removed",
  "context.read": "Context read",
  "context.written": "Context written",
  "pin.used": "Pin used",
  "supervisor.woke": "Supervisor woke",
  "supervisor.recommended": "Supervisor recommendation",
  "supervisor.applied": "Supervisor applied",
  "supervisor.dismissed": "Supervisor dismissed",
  "checkpoint.opened": "Checkpoint opened",
  "checkpoint.closed": "Checkpoint closed",
  "error.logged": "Error",
};

export function eventTypeLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replaceAll(".", " ");
}

export function eventFilterMatch(event: EventEnvelope, filter: EventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "supervisor") {
    return event.type.startsWith("supervisor.") || event.type.startsWith("checkpoint.");
  }
  if (filter === "quota") {
    return event.type === "quota.blocked" || event.type === "quota.released";
  }
  const errorTypes = ["error.logged", "node.output.rejected", "node.watchdog", "budget.exceeded"];
  if (errorTypes.includes(event.type)) return true;
  return event.type === "run.completed" && runFailed(event);
}

function runFailed(event: EventEnvelope): boolean {
  if (event.type !== "run.completed") return false;
  const payload = event.payload as { status?: string };
  return payload.status === "failed" || payload.status === "rejected";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function short(value: string, max = 220): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function describeEvent(event: EventEnvelope): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const path = event.path === "" ? "run" : event.path;
  switch (event.type) {
    case "run.created":
      return `Run #${num(payload.runNumber) ?? "?"} created for ${text(payload.workflowId, "workflow")}.`;
    case "run.started":
      return "Run started.";
    case "run.workspace_waiting":
      return "Waiting for another run to release the workspace.";
    case "run.paused":
      return `Run paused${payload.reason ? `: ${text(payload.reason)}` : ""}.`;
    case "run.resumed":
      return "Run resumed.";
    case "run.cancelled":
      return `Run cancelled by ${text(payload.by, "a person")}.`;
    case "run.completed": {
      const status = text(payload.status, "finished");
      return `Run ${status}${payload.endPath ? ` at ${text(payload.endPath)}` : ""}.`;
    }
    case "run.override.added":
      return `Guidance added for ${text(payload.nodeId, "a node")}.`;
    case "node.state":
      return `${path}: ${text(payload.from, "?")} → ${text(payload.to, "?")}${
        payload.reason ? ` (${text(payload.reason)})` : ""
      }.`;
    case "node.attempt.started":
      return `${path}: attempt ${num(payload.attempt) ?? "?"} started ${
        payload.mode === "resume" ? "from a saved session" : "fresh"
      }.`;
    case "node.session.captured":
      return `${path}: session ${text(payload.sessionId, "captured")} saved.`;
    case "node.input.resolved":
      return `${path}: input resolved and hashed.`;
    case "node.output.rejected": {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const first = errors[0] as { path?: string; message?: string } | undefined;
      return `${path}: output failed validation${first ? `: ${text(first.path)} ${text(first.message)}` : ""}.`;
    }
    case "node.output.validated":
      return `${path}: output validated.`;
    case "node.output.recorded":
      return `${path}: output recorded (${text(payload.outputId, "output")}).`;
    case "node.usage": {
      const tokens = (num(payload.tokensIn) ?? 0) + (num(payload.tokensOut) ?? 0);
      return `${path}: usage ${tokens.toLocaleString()} tokens${
        num(payload.costUsd) === null ? "" : `, $${(num(payload.costUsd) ?? 0).toFixed(2)}`
      }.`;
    }
    case "node.transcript.ref":
      return `${path}: transcript updated (${num(payload.bytes) ?? 0} bytes).`;
    case "node.watchdog":
      return `${path}: watchdog ${text(payload.kind, "alert")} — ${text(payload.detail, "no detail")}.`;
    case "node.process.spawned":
      return `${path}: process ${num(payload.pid) ?? "?"} started (${text(payload.binary, "agent")}).`;
    case "node.process.stopped":
      return `${path}: process ${text(payload.reason, "stopped")}${
        payload.exitCode === null || payload.exitCode === undefined
          ? ""
          : `, exit ${String(payload.exitCode)}`
      }.`;
    case "node.workspace.finalized":
      return `${path}: workspace finalized.`;
    case "gate.decided":
      return payload.branch === null
        ? `${path}: gate evaluation failed; the run fails without taking a branch.`
        : `${path}: took branch ${text(payload.branch, "otherwise")}.`;
    case "decision.requested":
      return `${path}: asked ${text(payload.provider, "a decision provider")} to choose.`;
    case "decision.answered": {
      const answers = Array.isArray(payload.answers) ? payload.answers.length : 0;
      return `${path}: decision answered (${answers} answer${answers === 1 ? "" : "s"}).`;
    }
    case "approval.requested":
      return `${path}: waiting for approval${payload.irreversible ? " (irreversible)" : ""}.`;
    case "approval.resolved":
      return `${path}: ${text(payload.decision, "resolved")} by ${text(payload.by, "a person")}.`;
    case "map.started":
      return `${path}: map started with ${num(payload.itemCount) ?? 0} items.`;
    case "map.item.state":
      return `${path}: item ${num(payload.index) ?? "?"} is ${text(payload.status, "updated")}.`;
    case "map.completed":
      return `${path}: map completed, ${num(payload.done) ?? 0} done and ${num(payload.failed) ?? 0} failed.`;
    case "loop.round.started":
      return `${path}: round ${num(payload.round) ?? "?"} started.`;
    case "loop.round.completed":
      return `${path}: round ${num(payload.round) ?? "?"} ${payload.exitMatched ? "met the exit condition" : "completed"}.`;
    case "loop.exited":
      return `${path}: loop exited after ${num(payload.rounds) ?? "?"} rounds (${text(payload.reason, "done")}).`;
    case "join.resolved": {
      const active = Array.isArray(payload.active) ? payload.active : [];
      const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
      return `${path}: join resolved ${text(payload.mode, "all")}; active ${
        active.length === 0 ? "none" : active.join(", ")
      }; skipped ${skipped.length === 0 ? "none" : skipped.join(", ")}.`;
    }
    case "quota.blocked":
      return `Provider ${text(payload.provider, "?")} blocked: ${text(payload.kind, "quota")}.`;
    case "quota.released":
      return `Provider ${text(payload.provider, "?")} released by ${text(payload.by, "timer")}.`;
    case "budget.threshold":
      return `Budget ${text(payload.budget, "?")} reached ${Math.round((num(payload.ratio) ?? 0) * 100)}%.`;
    case "budget.exceeded":
      return `Budget ${text(payload.budget, "?")} exceeded.`;
    case "workspace.created":
      return `${path}: ${text(payload.mode, "workspace")} workspace created.`;
    case "workspace.committed":
      return `${path}: workspace committed ${text(payload.sha, "").slice(0, 12)}.`;
    case "workspace.removed":
      return `${path}: workspace removed.`;
    case "context.read":
      return `Context ${text(payload.scope, "?")} read up to entry ${num(payload.watermark) ?? "?"}.`;
    case "context.written":
      return `Context ${text(payload.scope, "?")} ${text(payload.kind, "written")} topic ${text(payload.topic, "?")}.`;
    case "pin.used":
      return `${path}: reused a pinned output.`;
    case "supervisor.woke":
      return `Supervisor woke: ${Array.isArray(payload.reasons) ? payload.reasons.join(", ") : "event"}.`;
    case "supervisor.recommended":
      return `Supervisor recommends ${text(payload.action, "an action")}: ${short(text(payload.reasoning))}`;
    case "supervisor.applied":
      return `Supervisor applied ${text(payload.action, "an action")} (${text(payload.outcome, "done")}).`;
    case "supervisor.dismissed":
      return "Supervisor recommendation dismissed.";
    case "checkpoint.opened":
      return "Supervision checkpoint opened.";
    case "checkpoint.closed":
      return `Supervision checkpoint closed: ${text(payload.outcome, "done")}.`;
    case "error.logged":
      return `${path}: ${text(payload.code, "E_INTERNAL")} — ${text(payload.message, "error")}`;
    default:
      return `${path}: ${event.type.replaceAll(".", " ")}.`;
  }
}
