import { DevChestraError } from "./error.js";
import type { EventEnvelope, KnownEventType } from "./events.js";
import {
  assertIdentity,
  newNodeExec as createNodeExec,
  eventTime,
  internal,
  nodeIdForPath,
  positive,
  updateExec,
  withEventId,
} from "./reducer-support.js";
import { type ExecView, isDurablyComplete, type RunView } from "./reducer-types.js";
import { assertTransition, isTerminalExecStatus } from "./transitions.js";

function nonEmptyText(value: string, field: string, max: number): void {
  if (
    value.length === 0 ||
    value.length > max ||
    value.includes("\u0000") ||
    value.includes("\n")
  ) {
    throw internal(`Invalid process ${field}`, { field });
  }
}

function validateSpawned(payload: {
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
}): void {
  if (!Number.isSafeInteger(payload.pid) || payload.pid < 1) {
    throw internal("Invalid process pid", { pid: payload.pid });
  }
  nonEmptyText(payload.pidStart, "pidStart", 256);
  nonEmptyText(payload.binary, "binary", 4096);
  nonEmptyText(payload.cwd, "cwd", 4096);
}

export function reduceExecutionEvent(view: RunView, envelope: EventEnvelope): RunView {
  const type = envelope.type as KnownEventType;
  const path = envelope.path;
  const key = path as string;
  const time = eventTime(envelope);

  switch (type) {
    case "node.state": {
      const payload = (envelope as EventEnvelope<"node.state">).payload;
      positive(payload.attempt, "Attempt");
      positive(payload.generation, "Generation");
      const nodeId = nodeIdForPath(path);
      let exec = view.executions[key];

      if (exec === undefined) {
        if (payload.from !== "pending") {
          throw internal("First node.state must start from pending", {
            path,
            from: payload.from,
          });
        }
        exec = createNodeExec(path, nodeId, payload.attempt, payload.generation, payload.init);
      }

      if (payload.attempt > exec.attempt) {
        if (!isTerminalExecStatus(exec.status)) {
          throw internal("A new logical attempt requires a terminal previous attempt", {
            path,
            status: exec.status,
            expected: exec.attempt,
            received: payload.attempt,
          });
        }
        if (payload.from !== exec.status || payload.to !== "pending") {
          throw internal("Retry-from-node must transition the terminal attempt back to pending", {
            path,
            status: exec.status,
            from: payload.from,
            to: payload.to,
          });
        }
        const reset: ExecView = {
          ...exec,
          status: "pending",
          attempt: payload.attempt,
          generation: payload.generation,
          kind: payload.init?.kind ?? exec.kind,
          gateDecision: null,
          joinResolution: null,
          approvalRequest: null,
          approvalDecision: null,
          decision: null,
          loop: null,
          requiresAcceptedResult:
            exec.requiresAcceptedResult || (payload.init?.requireSubmission ?? false),
          acceptedResult: null,
          recordedOutput: null,
          processSpawned: null,
          processStopped: null,
          workspaceFinalized: null,
          validationAttempts: 0,
          mode: null,
          cli: null,
          sessionId: null,
          sessionCwd: null,
          model: null,
          resolvedConfigHash: null,
          inputsHash: null,
          startedAt: null,
          endedAt: null,
          attemptTokensIn: 0,
          attemptTokensOut: 0,
          attemptCostUsd: 0,
          workspaceDir: null,
          branch: null,
          workspaceCommitted: null,
          lastValidationErrors: [],
          lastTranscript: null,
          lastError: null,
        };
        return {
          ...view,
          executions: { ...view.executions, [key]: reset },
          lastEventId: envelope.id,
        };
      }

      if (payload.attempt < exec.attempt) {
        throw internal("node.state is fenced by a newer logical attempt", {
          path,
          expected: exec.attempt,
          received: payload.attempt,
        });
      }
      if (payload.generation !== exec.generation) {
        throw internal("node.state generation must match; use node.attempt.started to advance", {
          path,
          expected: exec.generation,
          received: payload.generation,
        });
      }
      if (payload.from !== exec.status) {
        throw internal("node.state 'from' does not match the projected status", {
          path,
          expected: exec.status,
          received: payload.from,
        });
      }
      assertTransition(exec.status, payload.to);

      if (payload.to === "succeeded") {
        if (exec.requiresAcceptedResult && exec.acceptedResult === null) {
          throw internal("Agent execution cannot succeed without an accepted result", { path });
        }
        if (exec.acceptedResult !== null && !isDurablyComplete(exec)) {
          throw internal(
            "Execution succeeded before process stop and workspace finalization for the accepted result",
            { path, accepted: exec.acceptedResult },
          );
        }
        if (exec.kind === "loop" && !isDurablyComplete(exec)) {
          throw internal(
            "Loop controller cannot succeed without a finished done decision and recorded output for the current generation",
            { path, kind: exec.kind },
          );
        }
        if (
          exec.acceptedResult === null &&
          (exec.kind === "shell" || exec.kind === "start" || exec.kind === "end") &&
          !isDurablyComplete(exec)
        ) {
          throw internal(
            "Non-agent execution cannot succeed without its required deterministic output and markers for the current generation",
            { path, kind: exec.kind },
          );
        }
      }

      const requiresAcceptedResult =
        exec.requiresAcceptedResult ||
        payload.init?.requireSubmission === true ||
        payload.init?.kind === "agent";
      const kind = payload.init?.kind ?? exec.kind;
      const startedAt =
        exec.startedAt === null && (payload.to === "running" || payload.to === "validating")
          ? time
          : exec.startedAt;
      const endedAt = isTerminalExecStatus(payload.to) ? time : exec.endedAt;

      return {
        ...view,
        executions: {
          ...view.executions,
          [key]: {
            ...exec,
            status: payload.to,
            attempt: payload.attempt,
            generation: payload.generation,
            kind,
            requiresAcceptedResult,
            startedAt,
            endedAt,
          },
        },
        lastEventId: envelope.id,
      };
    }

    case "node.attempt.started": {
      const payload = (envelope as EventEnvelope<"node.attempt.started">).payload;
      const exec = view.executions[key];
      if (exec === undefined) throw internal("node.attempt.started without node.state", { path });
      positive(payload.attempt, "Attempt");
      positive(payload.generation, "Generation");
      if (payload.attempt < exec.attempt) {
        throw internal("node.attempt.started is fenced by a newer logical attempt", {
          path,
          expected: exec.attempt,
          received: payload.attempt,
        });
      }
      if (payload.attempt > exec.attempt) {
        throw internal("Logical attempt must advance through node.state -> pending", {
          path,
          expected: exec.attempt,
          received: payload.attempt,
        });
      }
      if (payload.generation < exec.generation) {
        throw internal("node.attempt.started is fenced by a newer process generation", {
          path,
          expected: exec.generation,
          received: payload.generation,
        });
      }
      if (exec.acceptedResult !== null) {
        throw new DevChestraError(
          "E_CONFLICT",
          "Accepted result must be finalized without starting a new process generation",
          { details: { path, generation: exec.generation } },
        );
      }
      return updateExec(view, key, (current) => ({
        ...current,
        generation: payload.generation,
        mode: payload.mode,
        resolvedConfigHash: payload.resolvedConfigHash,
        kind: payload.nodeKind ?? current.kind,
        requiresAcceptedResult:
          current.requiresAcceptedResult ||
          payload.requireSubmission === true ||
          payload.nodeKind === "agent",
        ...(payload.cli === undefined ? {} : { cli: payload.cli }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.generation > current.generation
          ? {
              recordedOutput: null,
              gateDecision: null,
              joinResolution: null,
              approvalRequest: null,
              approvalDecision: null,
              decision: null,
              processSpawned: null,
              processStopped: null,
              workspaceFinalized: null,
            }
          : {}),
      }));
    }

    case "node.session.captured": {
      const payload = (envelope as EventEnvelope<"node.session.captured">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return {
          ...exec,
          cli: payload.cli,
          sessionId: payload.sessionId,
          sessionCwd: payload.cwd,
          ...(payload.model === undefined ? {} : { model: payload.model }),
        };
      });
    }

    case "node.input.resolved": {
      const payload = (envelope as EventEnvelope<"node.input.resolved">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return { ...exec, inputsHash: payload.inputsHash };
      });
    }

    case "node.output.rejected": {
      const payload = (envelope as EventEnvelope<"node.output.rejected">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        if (isTerminalExecStatus(exec.status)) {
          throw internal("Rejected output arrived after the execution became terminal", {
            path,
            status: exec.status,
          });
        }
        return {
          ...exec,
          validationAttempts: Math.max(exec.validationAttempts, payload.validationAttempt),
          lastValidationErrors: payload.errors,
          status: exec.status === "validating" ? "running" : exec.status,
        };
      });
    }

    case "node.output.validated": {
      const payload = (envelope as EventEnvelope<"node.output.validated">).payload;
      const exec = view.executions[key];
      if (exec === undefined) throw internal("node.output.validated without node.state", { path });
      assertIdentity(exec, type, payload);
      if (exec.acceptedResult !== null) {
        const accepted = exec.acceptedResult;
        if (
          accepted.attempt === payload.attempt &&
          accepted.generation === payload.generation &&
          accepted.outputId === payload.outputId
        ) {
          return withEventId(view, envelope);
        }
        throw internal("Accepted result is immutable and already set", {
          path,
          existing: accepted.outputId,
          received: payload.outputId,
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Validated output arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return {
        ...view,
        executions: {
          ...view.executions,
          [key]: {
            ...exec,
            status: "validating",
            requiresAcceptedResult: true,
            acceptedResult: {
              runId: envelope.runId,
              path,
              outputId: payload.outputId,
              outputHash: payload.outputHash,
              schemaHash: payload.schemaHash ?? null,
              attempt: payload.attempt,
              generation: payload.generation,
              acceptedEventId: envelope.id,
            },
          },
        },
        lastEventId: envelope.id,
      };
    }

    case "node.output.recorded": {
      const payload = (envelope as EventEnvelope<"node.output.recorded">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        if (exec.recordedOutput !== null) {
          const current = exec.recordedOutput;
          if (
            current.attempt === payload.attempt &&
            current.generation === payload.generation &&
            current.outputId === payload.outputId &&
            current.outputHash === payload.outputHash
          ) {
            return exec;
          }
          throw internal("Recorded output is immutable and already set", {
            path,
            existing: current.outputId,
            received: payload.outputId,
          });
        }
        if (isTerminalExecStatus(exec.status)) {
          throw internal("Recorded output arrived after the execution became terminal", {
            path,
            status: exec.status,
          });
        }
        return {
          ...exec,
          recordedOutput: {
            attempt: payload.attempt,
            generation: payload.generation,
            outputId: payload.outputId,
            outputHash: payload.outputHash,
            eventId: envelope.id,
          },
        };
      });
    }

    case "node.process.spawned": {
      const payload = (envelope as EventEnvelope<"node.process.spawned">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        validateSpawned(payload);
        if (exec.processSpawned !== null) {
          const current = exec.processSpawned;
          if (
            current.attempt === payload.attempt &&
            current.generation === payload.generation &&
            current.pid === payload.pid &&
            current.pidStart === payload.pidStart &&
            current.binary === payload.binary &&
            current.cwd === payload.cwd
          ) {
            return exec;
          }
          throw new DevChestraError(
            "E_CONFLICT",
            "Process spawn evidence is already recorded differently",
            { details: { path, existing: current, received: payload } },
          );
        }
        return {
          ...exec,
          processSpawned: {
            attempt: payload.attempt,
            generation: payload.generation,
            pid: payload.pid,
            pidStart: payload.pidStart,
            binary: payload.binary,
            cwd: payload.cwd,
          },
        };
      });
    }

    case "node.process.stopped": {
      const payload = (envelope as EventEnvelope<"node.process.stopped">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        if (exec.processStopped !== null) {
          const current = exec.processStopped;
          if (
            current.attempt === payload.attempt &&
            current.generation === payload.generation &&
            current.reason === payload.reason &&
            current.exitCode === (payload.exitCode ?? null)
          ) {
            return exec;
          }
          throw new DevChestraError(
            "E_CONFLICT",
            "Process stop marker is already recorded differently",
            {
              details: { path, existing: current, received: payload },
            },
          );
        }
        return {
          ...exec,
          processStopped: {
            attempt: payload.attempt,
            generation: payload.generation,
            reason: payload.reason,
            exitCode: payload.exitCode ?? null,
          },
          crashAttempts: payload.reason === "crash" ? exec.crashAttempts + 1 : exec.crashAttempts,
        };
      });
    }

    case "node.workspace.finalized": {
      const payload = (envelope as EventEnvelope<"node.workspace.finalized">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        if (exec.workspaceFinalized !== null) {
          const current = exec.workspaceFinalized;
          if (
            current.attempt === payload.attempt &&
            current.generation === payload.generation &&
            current.dir === payload.dir &&
            current.commitSha === (payload.commitSha ?? null)
          ) {
            return exec;
          }
          throw new DevChestraError(
            "E_CONFLICT",
            "Workspace finalization marker is already recorded differently",
            { details: { path, existing: current, received: payload } },
          );
        }
        return {
          ...exec,
          workspaceFinalized: {
            attempt: payload.attempt,
            generation: payload.generation,
            dir: payload.dir,
            commitSha: payload.commitSha ?? null,
          },
        };
      });
    }

    case "node.usage": {
      const payload = (envelope as EventEnvelope<"node.usage">).payload;
      if (view.executions[key] === undefined) return withEventId(view, envelope);
      const tokensIn = payload.tokensIn ?? 0;
      const tokensOut = payload.tokensOut ?? 0;
      const costUsd = payload.costUsd ?? 0;
      for (const value of [tokensIn, tokensOut, costUsd]) {
        if (!Number.isFinite(value) || value < 0) {
          throw internal("Usage values must be finite and non-negative", { path, value });
        }
      }
      const next = updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return {
          ...exec,
          tokensIn: exec.tokensIn + tokensIn,
          tokensOut: exec.tokensOut + tokensOut,
          costUsd: exec.costUsd + costUsd,
          attemptTokensIn: exec.attemptTokensIn + tokensIn,
          attemptTokensOut: exec.attemptTokensOut + tokensOut,
          attemptCostUsd: exec.attemptCostUsd + costUsd,
        };
      });
      return {
        ...next,
        budget: {
          ...next.budget,
          tokens: next.budget.tokens + tokensIn + tokensOut,
          usd: next.budget.usd + costUsd,
        },
        lastEventId: envelope.id,
      };
    }

    case "node.transcript.ref": {
      const payload = (envelope as EventEnvelope<"node.transcript.ref">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return { ...exec, lastTranscript: { file: payload.file, bytes: payload.bytes } };
      });
    }

    case "node.watchdog":
      // Watchdog details are surfaced by the engine; no RunView mutation in P0.
      return withEventId(view, envelope);

    case "workspace.created": {
      const payload = (envelope as EventEnvelope<"workspace.created">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return {
          ...exec,
          workspaceDir: payload.dir,
          branch: payload.branch ?? null,
        };
      });
    }

    case "workspace.committed": {
      const payload = (envelope as EventEnvelope<"workspace.committed">).payload;
      return updateExec(view, key, (exec) => {
        assertIdentity(exec, type, payload);
        return {
          ...exec,
          workspaceCommitted: {
            sha: payload.sha,
            filesChanged: payload.filesChanged,
            insertions: payload.insertions,
            deletions: payload.deletions,
          },
        };
      });
    }

    case "workspace.removed":
      // Workspace directory retention is a store/cleanup concern, not view state.
      return withEventId(view, envelope);
    default:
      return withEventId(view, envelope);
  }
}
