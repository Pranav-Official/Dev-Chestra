import { isDurablyComplete, type RunId, recoveryDecision } from "@devchestra/core";
import { appendEvents } from "./events.js";
import { isTerminalRunStatus, rebuildProjection, requireRun } from "./projection.js";
import type { Runtime } from "./runtime.js";
import type { RecoveredExecution, RecoveryReport } from "./types.js";

function appendState(
  runtime: Runtime,
  runId: RunId,
  execution: { path: RecoveredExecution["path"]; attempt: number; generation: number },
  from: string,
  to: string,
  reason?: string,
): void {
  appendEvents(runtime, runId, [
    {
      runId,
      path: execution.path,
      type: "node.state",
      actor: "engine",
      payload: {
        from,
        to,
        ...(reason === undefined ? {} : { reason }),
        attempt: execution.attempt,
        generation: execution.generation,
      },
    } as never,
  ]);
}

export function recover(runtime: Runtime, runId: RunId): RecoveryReport {
  const run = requireRun(runtime, runId);
  if (isTerminalRunStatus(run.status as Parameters<typeof isTerminalRunStatus>[0])) {
    return { runId, rebuilt: false, executions: [] };
  }
  const view = rebuildProjection(runtime, runId);
  const executions: RecoveryReport["executions"] = [];
  let pausedForUncertain = view.status === "paused" && view.pauseReason === "uncertain_side_effect";

  for (const execution of Object.values(view.executions)) {
    const base = {
      runId,
      path: execution.path,
      from: execution.status,
      to: execution.status,
    };
    if (execution.acceptedResult !== null) {
      if (!isDurablyComplete(execution)) {
        // Keep the original accepted identity. The engine records the real
        // crash stop + workspace finalization and calls completeAcceptedAfterRecovery.
        if (execution.status === "running" || execution.status === "validating") {
          appendState(runtime, runId, execution, execution.status, "interrupted", "crash");
        }
        executions.push({
          ...base,
          to:
            execution.status === "running" || execution.status === "validating"
              ? "interrupted"
              : execution.status,
          decision: "await_accepted_finalization",
          applied: true,
        });
        continue;
      }
      // Durably complete markers survived; core recovery marks success.
      const decision = recoveryDecision(execution);
      if (decision.action !== "leave") {
        appendState(runtime, runId, execution, decision.from, decision.to, decision.reason);
      }
      executions.push({
        ...base,
        to: decision.to,
        decision: decision.action,
        applied: decision.action !== "leave",
      });
      continue;
    }

    const ambiguousShell =
      execution.kind === "shell" &&
      (execution.status === "interrupted" ||
        execution.status === "running" ||
        execution.status === "validating");
    if (ambiguousShell) {
      let to = execution.status;
      if (execution.status === "running" || execution.status === "validating") {
        appendState(runtime, runId, execution, execution.status, "interrupted", "crash");
        to = "interrupted";
      }
      if (!pausedForUncertain && view.status !== "paused") {
        appendEvents(runtime, runId, [
          {
            runId,
            path: "" as RecoveredExecution["path"],
            type: "run.paused",
            actor: "system",
            payload: {
              reason: "uncertain_side_effect",
              path: execution.path,
              detail:
                "Interrupted shell may have produced external effects; user approval required to retry",
            },
          } as never,
        ]);
        pausedForUncertain = true;
      }
      executions.push({
        ...base,
        to,
        decision: "pause_uncertain_side_effect",
        applied: true,
        pauseReason: "uncertain_side_effect",
      });
      continue;
    }

    const decision = recoveryDecision(execution);
    if (decision.action !== "leave") {
      appendState(runtime, runId, execution, decision.from, decision.to, decision.reason);
    }
    executions.push({
      ...base,
      to: decision.to,
      decision: decision.action,
      applied: decision.action !== "leave",
    });
  }
  return { runId, rebuilt: true, executions };
}
