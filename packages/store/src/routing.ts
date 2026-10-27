import type {
  ExecutionIdentity,
  ExecView,
  GateDecidedPayload,
  JoinResolvedPayload,
} from "@relay/core";
import { appendEvents } from "./events.js";
import { completeExecution, requireCurrent } from "./executions.js";
import { hashJsonSync } from "./hash.js";
import { getOutput, recordDeterministic } from "./outputs.js";
import { assertRunActive, loadView } from "./projection.js";
import type { Runtime } from "./runtime.js";
import type {
  GateEvaluationInput,
  RecordGateDecisionInput,
  RecordJoinResolutionInput,
  RoutingCommitResult,
} from "./types.js";
import { fail } from "./util.js";

function requireKind(runtime: Runtime, identity: ExecutionIdentity, kind: string): ExecView {
  assertRunActive(runtime, identity.runId);
  const row = requireCurrent(runtime, identity);
  if (row.kind !== kind) {
    fail("E_CONFLICT", `Execution ${identity.path} is not a ${kind} node`, {
      kind: row.kind,
    });
  }
  const execution = loadView(runtime, identity.runId).executions[identity.path];
  if (execution === undefined) fail("E_INTERNAL", `Execution ${identity.path} is not projected`);
  return execution;
}

function copyEvaluated(evaluated: readonly GateEvaluationInput[]): GateDecidedPayload["evaluated"] {
  if (!Array.isArray(evaluated) || evaluated.length === 0) {
    fail("E_VALIDATION", "Gate decision requires at least one evaluated branch");
  }
  return evaluated.map((entry) => {
    if (typeof entry.branch !== "string" || entry.branch === "") {
      fail("E_VALIDATION", "Gate evaluation branch must be a non-empty string");
    }
    if (typeof entry.matched !== "boolean") {
      fail("E_VALIDATION", `Gate evaluation for '${entry.branch}' must be boolean`);
    }
    if (entry.error !== undefined && typeof entry.error !== "string") {
      fail("E_VALIDATION", `Gate evaluation error for '${entry.branch}' must be a string`);
    }
    return {
      branch: entry.branch,
      matched: entry.matched,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    };
  });
}

function sameEvaluated(
  left: readonly GateEvaluationInput[],
  right: readonly GateEvaluationInput[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inputNames(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value)) fail("E_VALIDATION", `Join ${label} names must be an array`);
  const out = value.map((name) => {
    if (typeof name !== "string" || name === "") {
      fail("E_VALIDATION", `Join ${label} names must be non-empty strings`);
    }
    return name;
  });
  if (new Set(out).size !== out.length) {
    fail("E_VALIDATION", `Join ${label} names must be unique`);
  }
  return out;
}

export function recordGateDecision(
  runtime: Runtime,
  input: RecordGateDecisionInput,
): RoutingCommitResult {
  const evaluated = copyEvaluated(input.evaluated);
  const matched = evaluated.filter((entry) => entry.matched);
  if (input.branch === null) {
    if (matched.length > 0) {
      fail("E_VALIDATION", "A failed gate decision cannot include a matched branch");
    }
  } else {
    if (typeof input.branch !== "string" || input.branch === "") {
      fail("E_VALIDATION", "Gate branch must be a non-empty string or null");
    }
    const last = evaluated[evaluated.length - 1];
    if (
      matched.length !== 1 ||
      matched[0]?.branch !== input.branch ||
      last?.branch !== input.branch ||
      last.error !== undefined ||
      evaluated.some((entry) => entry.error !== undefined)
    ) {
      fail("E_VALIDATION", "Gate trace must stop at exactly one matched chosen branch", {
        branch: input.branch,
      });
    }
  }
  const execution = requireKind(runtime, input.identity, "gate");
  const existing = execution.gateDecision;
  if (existing !== null) {
    if (existing.branch !== input.branch || !sameEvaluated(existing.evaluated, evaluated)) {
      fail("E_CONFLICT", "Gate decision is immutable and already recorded", {
        existing,
      });
    }
    const output =
      input.branch === null
        ? null
        : getOutput(runtime, input.identity.runId, input.identity.path, input.identity.attempt);
    if (input.branch !== null && output === null) {
      fail("E_INTERNAL", "Recorded gate decision has no durable output");
    }
    return {
      output,
      decisionEventId: null,
      completionEventId: null,
      duplicate: true,
    };
  }

  if (input.branch === null) {
    const [event] = appendEvents(runtime, input.identity.runId, [
      {
        runId: input.identity.runId,
        path: input.identity.path,
        type: "gate.decided",
        actor: "engine",
        payload: {
          branch: null,
          evaluated,
          attempt: input.identity.attempt,
          generation: input.identity.generation,
        },
      },
    ]);
    if (event === undefined) fail("E_INTERNAL", "Gate decision event was not appended");
    return { output: null, decisionEventId: event.id, completionEventId: null, duplicate: false };
  }

  const recorded = recordDeterministic(runtime, {
    identity: input.identity,
    output: { branch: input.branch },
  });
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "gate.decided",
      actor: "engine",
      payload: {
        branch: input.branch,
        evaluated,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    },
  ]);
  if (event === undefined) fail("E_INTERNAL", "Gate decision event was not appended");
  const completed = completeExecution(runtime, { identity: input.identity });
  return {
    output: recorded.output,
    decisionEventId: event.id,
    completionEventId: completed.eventId,
    duplicate: recorded.duplicate,
  };
}

export function recordJoinResolution(
  runtime: Runtime,
  input: RecordJoinResolutionInput,
): RoutingCommitResult {
  if (input.mode !== "first" && input.mode !== "all") {
    fail("E_VALIDATION", "Join mode must be 'first' or 'all'");
  }
  const active = inputNames(input.active, "active");
  const skipped = inputNames(input.skipped, "skipped");
  const overlap = active.find((name) => skipped.includes(name));
  if (overlap !== undefined) {
    fail("E_VALIDATION", `Join input '${overlap}' cannot be both active and skipped`);
  }
  if (input.mode === "first" && active.length > 1) {
    fail("E_JOIN_CONFLICT", "Join mode 'first' has more than one active input", { active });
  }
  if (input.mode === "first" && active.length !== 1) {
    fail("E_CONFLICT", "Join with no active input must be skipped, not resolved", { active });
  }
  if (input.mode === "all" && active.length === 0) {
    fail("E_CONFLICT", "Join with no active input must be skipped, not resolved", { skipped });
  }

  const image = hashJsonSync(input.output);
  const execution = requireKind(runtime, input.identity, "join");
  const existing = execution.joinResolution;
  if (existing !== null) {
    if (
      existing.mode !== input.mode ||
      JSON.stringify(existing.active) !== JSON.stringify(active) ||
      JSON.stringify(existing.skipped) !== JSON.stringify(skipped)
    ) {
      fail("E_CONFLICT", "Join resolution is immutable and already recorded", {
        existing,
      });
    }
    const output = getOutput(
      runtime,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
    );
    if (output === null || output.hash !== image) {
      fail("E_CONFLICT", "Join resolution already recorded a different output");
    }
    return { output, decisionEventId: null, completionEventId: null, duplicate: true };
  }

  const recorded = recordDeterministic(runtime, { identity: input.identity, output: input.output });
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "join.resolved",
      actor: "engine",
      payload: {
        mode: input.mode,
        active,
        skipped,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      } satisfies JoinResolvedPayload,
    },
  ]);
  if (event === undefined) fail("E_INTERNAL", "Join resolution event was not appended");
  const completed = completeExecution(runtime, { identity: input.identity });
  return {
    output: recorded.output,
    decisionEventId: event.id,
    completionEventId: completed.eventId,
    duplicate: recorded.duplicate,
  };
}
