import { RelayError } from "./error.js";
import type { EventEnvelope, KnownEventType } from "./events.js";
import {
  assertIdentity,
  assertRunCompletionLegal,
  eventTime,
  internal,
  positive,
  settleActive,
  updateExec,
  withEventId,
} from "./reducer-support.js";
import type { RunView } from "./reducer-types.js";
import { assertRunTransition, type RunStatus } from "./transitions.js";

function fenceOptionalIdentity(
  exec: { attempt: number; generation: number },
  type: string,
  payload: { attempt?: number; generation?: number },
): void {
  if ((payload.attempt === undefined) !== (payload.generation === undefined)) {
    throw internal(`${type} must provide attempt and generation together`, { type });
  }
  if (payload.attempt !== undefined && payload.generation !== undefined) {
    assertIdentity(exec, type, { attempt: payload.attempt, generation: payload.generation });
  }
}

export function reduceLifecycleEvent(view: RunView, envelope: EventEnvelope): RunView {
  const type = envelope.type as KnownEventType;
  const path = envelope.path;
  const key = path as string;
  const time = eventTime(envelope);

  switch (type) {
    case "run.created": {
      const payload = (envelope as EventEnvelope<"run.created">).payload;
      positive(payload.runNumber, "Run number");
      if (view.runNumber !== 0 && view.runNumber !== payload.runNumber) {
        throw new RelayError("E_CONFLICT", "Run was already created with another run number", {
          details: { existing: view.runNumber, received: payload.runNumber },
        });
      }
      if (view.runNumber !== 0 && view.status !== "queued") {
        throw new RelayError("E_CONFLICT", "run.created arrived after the run left queued");
      }
      return {
        ...view,
        runNumber: payload.runNumber,
        status: "queued",
        lastEventId: envelope.id,
      };
    }

    case "run.started": {
      assertRunTransition(view.status, "running");
      return {
        ...view,
        status: "running",
        activeSince: view.activeSince ?? time,
        pausedAt: null,
        pauseReason: null,
        pauseDetail: null,
        pausePath: null,
        lastEventId: envelope.id,
      };
    }

    case "run.paused": {
      const payload = (envelope as EventEnvelope<"run.paused">).payload;
      assertRunTransition(view.status, "paused");
      const settled = settleActive(view, time);
      return {
        ...settled,
        status: "paused",
        pausedAt: time,
        pauseReason: payload.reason,
        pauseDetail: payload.detail ?? null,
        pausePath: payload.path ?? (path.length === 0 ? null : path),
        lastEventId: envelope.id,
      };
    }

    case "run.resumed": {
      assertRunTransition(view.status, "running");
      const pausedMs =
        view.pausedAt === null ? view.pausedMs : view.pausedMs + Math.max(0, time - view.pausedAt);
      return {
        ...view,
        status: "running",
        pausedMs,
        pausedAt: null,
        pauseReason: null,
        pauseDetail: null,
        pausePath: null,
        activeSince: view.activeSince ?? time,
        lastEventId: envelope.id,
      };
    }

    case "run.cancelled": {
      assertRunTransition(view.status, "cancelled");
      const settled = settleActive(view, time);
      return {
        ...settled,
        status: "cancelled",
        pausedAt: null,
        pauseReason: null,
        pauseDetail: null,
        pausePath: null,
        lastEventId: envelope.id,
      };
    }

    case "run.completed": {
      const payload = (envelope as EventEnvelope<"run.completed">).payload;
      const runStatus: RunStatus = payload.status === "success" ? "succeeded" : payload.status;
      assertRunTransition(view.status, runStatus);
      if (runStatus === "succeeded") assertRunCompletionLegal(view);
      const settled = settleActive(view, time);
      return {
        ...settled,
        status: runStatus,
        pausedAt: null,
        pauseReason: null,
        pauseDetail: null,
        pausePath: null,
        lastEventId: envelope.id,
      };
    }

    case "run.override.added":
      // No RunView effect in the P0 slice; retained for forward-compatible replay.
      return withEventId(view, envelope);

    case "quota.blocked": {
      const payload = (envelope as EventEnvelope<"quota.blocked">).payload;
      return {
        ...view,
        providers: {
          ...view.providers,
          [payload.provider]: {
            blockedUntil: payload.resumeAt ?? null,
            kind: payload.kind,
            source: payload.resumeAtSource,
            reason: null,
          },
        },
        lastEventId: envelope.id,
      };
    }

    case "quota.released": {
      const payload = (envelope as EventEnvelope<"quota.released">).payload;
      return {
        ...view,
        providers: {
          ...view.providers,
          [payload.provider]: {
            blockedUntil: null,
            kind: null,
            source: payload.by,
            reason: null,
          },
        },
        lastEventId: envelope.id,
      };
    }

    case "budget.threshold":
    case "budget.exceeded":
      // Budget figures are projected from usage; threshold events are audit-only in P0.
      return withEventId(view, envelope);

    case "error.logged": {
      const payload = (envelope as EventEnvelope<"error.logged">).payload;
      const errors = [
        ...view.errors,
        {
          eventId: envelope.id,
          ts: envelope.ts,
          path,
          code: payload.code,
          message: payload.message,
          details: payload.details,
        },
      ].slice(-100);
      return updateExec({ ...view, errors }, key, (exec) => ({
        ...exec,
        lastError: { code: payload.code, message: payload.message },
      }));
    }

    case "gate.decided": {
      const payload = (envelope as EventEnvelope<"gate.decided">).payload;
      return updateExec(view, key, (exec) => {
        fenceOptionalIdentity(exec, type, payload);
        if (exec.gateDecision !== null) {
          throw new RelayError("E_CONFLICT", "Gate decision is immutable and already recorded", {
            details: { path, existing: exec.gateDecision, received: payload },
          });
        }
        if (exec.status !== "running" && exec.status !== "validating") {
          throw internal("Gate decision arrived in an unexpected status", {
            path,
            status: exec.status,
          });
        }
        return {
          ...exec,
          gateDecision: {
            branch: payload.branch,
            evaluated: payload.evaluated.map((entry) => ({ ...entry })),
            ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
            ...(payload.generation === undefined ? {} : { generation: payload.generation }),
          },
        };
      });
    }

    case "join.resolved": {
      const payload = (envelope as EventEnvelope<"join.resolved">).payload;
      return updateExec(view, key, (exec) => {
        fenceOptionalIdentity(exec, type, payload);
        if (exec.joinResolution !== null) {
          throw new RelayError("E_CONFLICT", "Join resolution is immutable and already recorded", {
            details: { path, existing: exec.joinResolution, received: payload },
          });
        }
        if (exec.status !== "running" && exec.status !== "validating") {
          throw internal("Join resolution arrived in an unexpected status", {
            path,
            status: exec.status,
          });
        }
        return {
          ...exec,
          joinResolution: {
            mode: payload.mode,
            active: [...payload.active],
            skipped: [...payload.skipped],
            ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
            ...(payload.generation === undefined ? {} : { generation: payload.generation }),
          },
        };
      });
    }

    case "approval.requested": {
      const payload = (envelope as EventEnvelope<"approval.requested">).payload;
      // Legacy events without requestId are replay-safe but never resolvable.
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      if (payload.attempt !== undefined || payload.generation !== undefined) {
        fenceOptionalIdentity(exec, type, payload as { attempt?: number; generation?: number });
      }
      if (payload.requestId !== undefined && typeof payload.requestId !== "string") {
        throw internal("approval.requested requestId must be string", { path });
      }
      // Idempotent replay: same requestId/message/criteria/irreversible already stored.
      if (exec.approvalRequest !== null) {
        const cur = exec.approvalRequest;
        const same =
          cur.requestId === (payload.requestId ?? null) &&
          cur.message === payload.message &&
          cur.irreversible === payload.irreversible &&
          JSON.stringify(cur.criteria) === JSON.stringify(payload.criteria ?? null);
        if (same) return withEventId(view, envelope);
        // Different request for same attempt/generation is a conflict (stale UI or retry misuse).
        throw new RelayError("E_CONFLICT", "Approval request is immutable and already recorded", {
          details: { path, existing: cur, received: payload },
        });
      }
      // Run-level waiting_approval transition (for inbox WHERE run.status=waiting_approval).
      let nextView: RunView;
      if (view.status === "running") {
        const settled = settleActive(view, time);
        assertRunTransition(settled.status, "waiting_approval");
        nextView = {
          ...settled,
          status: "waiting_approval",
          pausedAt: time,
          pauseReason: "approval_cap",
          pauseDetail: payload.message.slice(0, 512) || null,
          pausePath: path.length === 0 ? null : path,
          lastEventId: envelope.id,
        };
      } else if (view.status === "waiting_approval") {
        nextView = withEventId(view, envelope);
      } else {
        // Non-running terminal/paused runs should not accept new approvals; keep idempotent
        return withEventId(view, envelope);
      }
      return updateExec(nextView, key, (current) => ({
        ...current,
        approvalRequest: {
          message: payload.message,
          irreversible: payload.irreversible,
          criteria: payload.criteria ? [...payload.criteria] : null,
          requestId: payload.requestId ?? null,
          attempt: payload.attempt ?? null,
          generation: payload.generation ?? null,
          eventId: envelope.id,
        },
      }));
    }

    case "approval.resolved": {
      const payload = (envelope as EventEnvelope<"approval.resolved">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      if (payload.attempt !== undefined || payload.generation !== undefined) {
        fenceOptionalIdentity(exec, type, payload as { attempt?: number; generation?: number });
      }
      if (exec.approvalRequest === null) {
        // Old historical event without request — treat as audit only, no decision.
        if (payload.requestId === undefined) return withEventId(view, envelope);
        throw internal("approval.resolved without a durable request", { path });
      }
      // Legacy request lacking identity: never become resolvable via fabricated identity.
      // Preserve old event replay as audit/read-only: legacy requested+resolved with omitted requestId rebuilds.
      if (exec.approvalRequest.requestId === null) {
        if (payload.requestId === undefined) return withEventId(view, envelope);
        throw new RelayError("E_CONFLICT", "Legacy approval without requestId is not resolvable", {
          details: { path },
        });
      }
      // Enforce stable request identity: client must echo requestId.
      const expected = exec.approvalRequest.requestId;
      if (payload.requestId !== undefined && payload.requestId !== expected) {
        throw new RelayError("E_CONFLICT", "Stale approval requestId; path was retried", {
          details: { path, expected, received: payload.requestId },
        });
      }
      if (payload.requestId === undefined) {
        throw new RelayError("E_CONFLICT", "approval.resolved must carry requestId", {
          details: { path },
        });
      }
      const requestId = payload.requestId;
      if (exec.approvalDecision !== null) {
        const cur = exec.approvalDecision;
        const same =
          cur.decision === payload.decision &&
          cur.by === payload.by &&
          (cur.note ?? null) === (payload.note ?? null) &&
          cur.requestId === requestId;
        if (same) {
          // Idempotent replay even after run terminal — do not change run status again.
          return withEventId(view, envelope);
        }
        throw new RelayError("E_CONFLICT", "Approval decision is immutable", {
          details: { path, existing: cur, received: payload },
        });
      }
      // First valid decision: store it. Run status return to running is driven
      // by the paired node.state event, but we also handle it here for atomic
      // single-event recovery where node.state may be co-appended.
      const withDecision = updateExec(view, key, (current) => ({
        ...current,
        approvalDecision: {
          decision: payload.decision,
          by: payload.by,
          note: payload.note ?? null,
          requestId,
          attempt: payload.attempt ?? null,
          generation: payload.generation ?? null,
          eventId: envelope.id,
        },
      }));
      // If run is waiting_approval, return to running (approved or rejected-with-edge).
      // For reject-without-edge the run will be terminalized by run.completed,
      // not by this event alone. Fail closed on illegal transition.
      if (withDecision.status === "waiting_approval") {
        const pausedMs =
          withDecision.pausedAt === null
            ? withDecision.pausedMs
            : withDecision.pausedMs + Math.max(0, time - withDecision.pausedAt);
        assertRunTransition(withDecision.status, "running");
        return {
          ...withDecision,
          status: "running",
          pausedMs,
          pausedAt: null,
          pauseReason: null,
          pauseDetail: null,
          pausePath: null,
          activeSince: withDecision.activeSince ?? time,
          lastEventId: envelope.id,
        };
      }
      return withEventId(withDecision, envelope);
    }

    // Reserved catalog events have no RunView effect in the P0 slice. Their
    // payloads are versioned and replayed safely; later slices add reducers.
    case "decision.requested":
    case "decision.answered":
    case "map.started":
    case "map.item.state":
    case "map.completed":
    case "loop.round.started":
    case "loop.round.completed":
    case "loop.exited":
    case "context.read":
    case "context.written":
    case "pin.used":
    case "supervisor.woke":
    case "supervisor.recommended":
    case "supervisor.applied":
    case "supervisor.dismissed":
    case "checkpoint.opened":
    case "checkpoint.closed":
      return withEventId(view, envelope);

    default:
      return withEventId(view, envelope);
  }
}
