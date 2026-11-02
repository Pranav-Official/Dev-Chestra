import { DevChestraError } from "./error.js";
import type { EventEnvelope, KnownEventType } from "./events.js";
import { canonicalJson } from "./hash.js";
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
import {
  type LoopView,
  loopDecisionProblem,
  loopRoundOutcome,
  MAX_LOOP_HISTORY,
} from "./reducer-types.js";
import { assertRunTransition, type RunStatus } from "./transitions.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkLoopIteration(iteration: unknown): number {
  if (!Number.isSafeInteger(iteration) || (iteration as number) < 1) {
    throw internal("Loop iteration must be a positive integer", { iteration });
  }
  const n = iteration as number;
  if (n > MAX_LOOP_HISTORY) {
    throw internal(`Loop iteration exceeds the ${MAX_LOOP_HISTORY} history bound`, {
      iteration: n,
    });
  }
  return n;
}

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
        throw new DevChestraError("E_CONFLICT", "Run was already created with another run number", {
          details: { existing: view.runNumber, received: payload.runNumber },
        });
      }
      if (view.runNumber !== 0 && view.status !== "queued") {
        throw new DevChestraError("E_CONFLICT", "run.created arrived after the run left queued");
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
      // No RunView effect; retained for forward-compatible replay.
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
      // Budget figures are projected from usage; threshold events are audit-only.
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
          throw new DevChestraError(
            "E_CONFLICT",
            "Gate decision is immutable and already recorded",
            {
              details: { path, existing: exec.gateDecision, received: payload },
            },
          );
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
          throw new DevChestraError(
            "E_CONFLICT",
            "Join resolution is immutable and already recorded",
            {
              details: { path, existing: exec.joinResolution, received: payload },
            },
          );
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
        throw new DevChestraError(
          "E_CONFLICT",
          "Approval request is immutable and already recorded",
          {
            details: { path, existing: cur, received: payload },
          },
        );
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
        throw new DevChestraError(
          "E_CONFLICT",
          "Legacy approval without requestId is not resolvable",
          {
            details: { path },
          },
        );
      }
      // Enforce stable request identity: client must echo requestId.
      const expected = exec.approvalRequest.requestId;
      if (payload.requestId !== undefined && payload.requestId !== expected) {
        throw new DevChestraError("E_CONFLICT", "Stale approval requestId; path was retried", {
          details: { path, expected, received: payload.requestId },
        });
      }
      if (payload.requestId === undefined) {
        throw new DevChestraError("E_CONFLICT", "approval.resolved must carry requestId", {
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
        throw new DevChestraError("E_CONFLICT", "Approval decision is immutable", {
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

    case "decision.requested": {
      const payload = (envelope as EventEnvelope<"decision.requested">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      if (payload.attempt !== undefined || payload.generation !== undefined) {
        fenceOptionalIdentity(exec, type, payload as { attempt?: number; generation?: number });
      }
      // Request is audit-only; the answer carries the durable projection.
      return withEventId(view, envelope);
    }

    case "decision.answered": {
      const payload = (envelope as EventEnvelope<"decision.answered">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      const { output, routing } = payload;
      if (output === undefined || routing === undefined) {
        // Legacy answer without a normalized output: audit-only, no projection.
        return withEventId(view, envelope);
      }
      if (exec.decision !== null) {
        const cur = exec.decision;
        const same =
          JSON.stringify(cur.output) === JSON.stringify(output) &&
          cur.routing.branch === routing.branch &&
          cur.routing.reason === routing.reason;
        // Idempotent replay even after run terminal — do not change status again.
        if (same) return withEventId(view, envelope);
        throw new DevChestraError(
          "E_CONFLICT",
          "Decision answer is immutable and already recorded",
          {
            details: { path, existing: cur, received: payload },
          },
        );
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Decision answer arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return updateExec(view, key, (current) => ({
        ...current,
        decision: {
          output,
          routing: { branch: routing.branch, reason: routing.reason },
          eventId: envelope.id,
        },
      }));
    }

    case "loop.started": {
      const payload = (envelope as EventEnvelope<"loop.started">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      const iteration = checkLoopIteration(payload.iteration);
      if (iteration !== 1) {
        throw internal("Loop start iteration must be 1", { path, iteration });
      }
      const hasParent = payload.parent !== undefined;
      const hasParentRef = payload.parentRef !== undefined;
      if ((hasParent ? 1 : 0) + (hasParentRef ? 1 : 0) !== 1) {
        throw internal("Loop start must carry exactly one of parent or parentRef", { path });
      }
      if (hasParentRef) {
        const ref = payload.parentRef as { kind?: unknown; captureId?: unknown };
        if (
          ref.kind !== "devchestra.execution-context/v1" ||
          typeof ref.captureId !== "string" ||
          ref.captureId.length === 0
        ) {
          throw internal("Loop parentRef must be a tagged execution-context reference", { path });
        }
      }
      if (hasParent && !isPlainObject(payload.parent)) {
        throw internal("Loop parent must be a JSON object", { path });
      }
      if (!isPlainObject(payload.state)) {
        throw internal("Loop state must be a JSON object", { path });
      }
      if (exec.loop !== null) {
        const cur = exec.loop;
        const sameRef =
          (cur.parentRef?.captureId ?? null) ===
          (hasParentRef ? (payload.parentRef as { captureId: string }).captureId : null);
        const sameParent =
          hasParentRef || cur.parentRef !== null
            ? sameRef
            : canonicalJson(cur.parent) === canonicalJson(payload.parent);
        const same =
          cur.iteration === 1 &&
          sameParent &&
          canonicalJson(cur.state) === canonicalJson(payload.state) &&
          cur.rounds.length === 0;
        // Idempotent replay: identical start after run terminal must not change status.
        if (same) return withEventId(view, envelope);
        throw new DevChestraError("E_CONFLICT", "Loop controller is immutable once started", {
          details: { path, existing: cur, received: payload },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Loop start arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      const loop: LoopView = {
        iteration: 1,
        parent: hasParentRef
          ? {}
          : ({ ...(payload.parent as Record<string, unknown>) } as LoopView["parent"]),
        parentRef: hasParentRef
          ? {
              kind: "devchestra.execution-context/v1",
              captureId: (payload.parentRef as { captureId: string }).captureId,
            }
          : null,
        state: { ...(payload.state as Record<string, unknown>) } as LoopView["state"],
        rounds: [],
      };
      return withEventId(
        updateExec(view, key, (current) => ({ ...current, loop })),
        envelope,
      );
    }

    case "loop.iteration.decided": {
      const payload = (envelope as EventEnvelope<"loop.iteration.decided">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      const iteration = checkLoopIteration(payload.iteration);
      if (typeof payload.done !== "boolean") {
        throw internal("Loop decision done must be boolean", { path });
      }
      if (payload.nextState !== undefined && !isPlainObject(payload.nextState)) {
        throw internal("Loop nextState must be a JSON object when present", { path });
      }
      const problem = loopDecisionProblem(payload);
      if (problem !== null) throw internal(problem, { path });
      if (exec.loop === null) {
        throw internal("Loop decision arrived before loop.started", { path });
      }
      const outcome = loopRoundOutcome(payload);
      const existing = exec.loop.rounds.find((round) => round.iteration === iteration);
      if (existing !== undefined) {
        const same =
          canonicalJson(existing.result) === canonicalJson(payload.result) &&
          existing.done === payload.done &&
          loopRoundOutcome(existing) === outcome &&
          canonicalJson(existing.nextState ?? null) === canonicalJson(payload.nextState ?? null);
        // Idempotent replay even after run terminal — do not change status again.
        if (same) return withEventId(view, envelope);
        throw new DevChestraError("E_CONFLICT", "Loop round decision is immutable", {
          details: { path, existing, received: payload },
        });
      }
      if (exec.loop.rounds.some((round) => loopRoundOutcome(round) !== null)) {
        throw new DevChestraError("E_CONFLICT", "Loop is already finished; no further decisions", {
          details: { path, iteration },
        });
      }
      if (iteration !== exec.loop.iteration) {
        throw new DevChestraError("E_CONFLICT", "Stale or future loop iteration", {
          details: { path, expected: exec.loop.iteration, received: iteration },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Loop decision arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      const round = {
        iteration,
        result: payload.result,
        done: payload.done,
        nextState:
          payload.nextState === undefined
            ? null
            : ({ ...(payload.nextState as Record<string, unknown>) } as LoopView["state"]),
        outcome,
        eventId: envelope.id,
      };
      const rounds = [...exec.loop.rounds, round].slice(-MAX_LOOP_HISTORY);
      // Terminal rounds (condition met or iteration budget exhausted) leave the
      // controller's iteration in place for idempotent publication.
      const loop: LoopView =
        outcome !== null
          ? { ...exec.loop, rounds }
          : {
              iteration: iteration + 1,
              parent: exec.loop.parent,
              parentRef: exec.loop.parentRef,
              state:
                payload.nextState === undefined
                  ? exec.loop.state
                  : ({ ...(payload.nextState as Record<string, unknown>) } as LoopView["state"]),
              rounds,
            };
      return withEventId(
        updateExec(view, key, (current) => ({ ...current, loop })),
        envelope,
      );
    }

    case "workflow.linked": {
      const payload = (envelope as EventEnvelope<"workflow.linked">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      if (typeof payload.childRunId !== "string" || payload.childRunId.length === 0) {
        throw internal("workflow.linked childRunId must be a non-empty string", { path });
      }
      if (typeof payload.workflowId !== "string" || payload.workflowId.length === 0) {
        throw internal("workflow.linked workflowId must be a non-empty string", { path });
      }
      if (exec.workflow !== null) {
        const cur = exec.workflow;
        const same = cur.childRunId === payload.childRunId && cur.workflowId === payload.workflowId;
        if (same) return withEventId(view, envelope);
        throw new DevChestraError("E_CONFLICT", "Workflow child link is immutable", {
          details: { path, existing: cur, received: payload },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Workflow link arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return updateExec(view, key, (current) => ({
        ...current,
        workflow: {
          childRunId: payload.childRunId,
          workflowId: payload.workflowId,
          status: "running",
          resultRef: null,
          eventId: envelope.id,
        },
      }));
    }

    case "workflow.completed": {
      const payload = (envelope as EventEnvelope<"workflow.completed">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      const valid = ["succeeded", "failed", "rejected", "cancelled"];
      if (!valid.includes(payload.status)) {
        throw internal("workflow.completed status must be a terminal child status", { path });
      }
      if (exec.workflow === null) {
        throw internal("workflow.completed arrived before workflow.linked", { path });
      }
      if (exec.workflow.childRunId !== payload.childRunId) {
        throw new DevChestraError("E_CONFLICT", "Stale workflow completion for another child", {
          details: { path, expected: exec.workflow.childRunId, received: payload.childRunId },
        });
      }
      if (exec.workflow.status !== "running") {
        const same =
          exec.workflow.status === payload.status &&
          (exec.workflow.resultRef ?? null) === (payload.resultRef ?? null);
        if (same) return withEventId(view, envelope);
        throw new DevChestraError("E_CONFLICT", "Workflow completion is immutable", {
          details: { path },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Workflow completion arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return updateExec(view, key, (current) => ({
        ...current,
        workflow: {
          childRunId: payload.childRunId,
          workflowId: current.workflow?.workflowId ?? null,
          status: payload.status,
          resultRef: payload.resultRef ?? null,
          eventId: envelope.id,
        },
      }));
    }

    case "foreach.started": {
      const payload = (envelope as EventEnvelope<"foreach.started">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      if (!Number.isSafeInteger(payload.total) || payload.total < 0) {
        throw internal("foreach.started total must be a non-negative integer", { path });
      }
      if (payload.parentRef !== undefined) {
        const ref = payload.parentRef as { kind?: unknown; captureId?: unknown };
        if (
          ref.kind !== "devchestra.execution-context/v1" ||
          typeof ref.captureId !== "string" ||
          ref.captureId.length === 0
        ) {
          throw internal("Foreach parentRef must be a tagged execution-context reference", {
            path,
          });
        }
      }
      if (exec.foreach !== null) {
        const cur = exec.foreach;
        const same = cur.total === payload.total && cur.sourceId === payload.sourceId;
        if (same) return withEventId(view, envelope);
        throw new DevChestraError("E_CONFLICT", "Foreach controller is immutable once started", {
          details: { path },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Foreach start arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return updateExec(view, key, (current) => ({
        ...current,
        foreach: {
          total: payload.total,
          processed: 0,
          succeeded: 0,
          failed: 0,
          rejected: 0,
          resultsRef: payload.sourceId,
          sourceId: payload.sourceId,
          eventId: envelope.id,
        },
      }));
    }

    case "foreach.item.decided": {
      const payload = (envelope as EventEnvelope<"foreach.item.decided">).payload;
      const exec = view.executions[key];
      if (exec === undefined) return withEventId(view, envelope);
      fenceOptionalIdentity(exec, type, payload);
      if (!Number.isSafeInteger(payload.index) || payload.index < 0) {
        throw internal("foreach.item.decided index must be a non-negative integer", { path });
      }
      if (exec.foreach === null) {
        throw internal("foreach.item.decided arrived before foreach.started", { path });
      }
      if (payload.index !== exec.foreach.processed) {
        // Idempotent replay: same index already counted is checked by store;
        // projection enforces strict ordering.
        throw new DevChestraError("E_CONFLICT", "Stale or future foreach index", {
          details: { path, expected: exec.foreach.processed, received: payload.index },
        });
      }
      if (exec.status !== "running" && exec.status !== "validating") {
        throw internal("Foreach item decision arrived in an unexpected status", {
          path,
          status: exec.status,
        });
      }
      return updateExec(view, key, (current) => {
        const cur = current.foreach;
        if (cur === null) return current;
        return {
          ...current,
          foreach: {
            ...cur,
            processed: cur.processed + 1,
            succeeded: cur.succeeded + (payload.status === "succeeded" ? 1 : 0),
            failed: cur.failed + (payload.status === "failed" ? 1 : 0),
            rejected: cur.rejected + (payload.status === "rejected" ? 1 : 0),
          },
        };
      });
    }

    // Reserved catalog events have no RunView effect. Their payloads are
    // versioned and replayed safely until a reducer handles them.
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
