import type {
  DecisionAnsweredPayload,
  DecisionOutput,
  DecisionRequestedPayload,
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
  RecordDecisionInput,
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

const DECISION_KINDS = new Set(["boolean", "choice", "score"]);
const DECISION_REASONS = new Set(["matched", "low_confidence", "refused", "error"]);

function checkedDecisionOutput(value: unknown): DecisionOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("E_VALIDATION", "Decision output must be an object");
  }
  const out = value as Record<string, unknown>;
  if (!DECISION_KINDS.has(out.kind as string)) {
    fail("E_VALIDATION", "Decision output kind must be boolean, choice or score");
  }
  if (typeof out.value !== "boolean" && typeof out.value !== "string" && out.value !== null) {
    fail("E_VALIDATION", "Decision output value must be boolean, string or null");
  }
  if (typeof out.confidence !== "number" && out.confidence !== null) {
    fail("E_VALIDATION", "Decision output confidence must be a number or null");
  }
  if (typeof out.model !== "string" || out.model === "") {
    fail("E_VALIDATION", "Decision output model must be a non-empty string");
  }
  return value as DecisionOutput;
}

function checkedDecisionRouting(value: { branch: string | null; reason: string }): {
  branch: string | null;
  reason: "matched" | "low_confidence" | "refused" | "error";
} {
  if (value.branch !== null && (typeof value.branch !== "string" || value.branch === "")) {
    fail("E_VALIDATION", "Decision branch must be a non-empty string or null");
  }
  if (!DECISION_REASONS.has(value.reason)) {
    fail("E_VALIDATION", "Decision reason must be matched, low_confidence, refused or error");
  }
  return value as {
    branch: string | null;
    reason: "matched" | "low_confidence" | "refused" | "error";
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const n = finiteNumber(entry);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  return out;
}

/**
 * The deterministic node output downstream expressions and templates read.
 * It carries the routed branch plus the full normalized answer, so scope
 * entries like `<nodeId>.value` and `<nodeId>.confidence` resolve. A null
 * confidence is stored as null (JSONata comparisons against null are false).
 */
function decisionPersistedOutput(output: DecisionOutput, branch: string): Record<string, unknown> {
  const record = output as unknown as Record<string, unknown>;
  const persisted: Record<string, unknown> = {
    branch,
    value: output.value,
    confidence: output.confidence,
    confidenceSource: output.confidenceSource,
    model: output.model,
  };
  const probability = finiteNumber(record.probability);
  if (probability !== undefined) persisted.probability = probability;
  const score = finiteNumber(record.score);
  if (score !== undefined) persisted.score = score;
  const probabilities = numberMap(record.probabilities);
  if (probabilities !== undefined) persisted.probabilities = probabilities;
  return persisted;
}

/**
 * Durable decision commit: appends decision.requested + decision.answered with
 * the attempt/generation fence, records the routed branch as the deterministic
 * output, and completes the execution. A null branch (error/unrouted) appends
 * the events without a success output or completion, mirroring gate failure.
 */
export function recordDecision(runtime: Runtime, input: RecordDecisionInput): RoutingCommitResult {
  const output = checkedDecisionOutput(input.output);
  const routing = checkedDecisionRouting(input.routing);
  if (typeof input.provider !== "string" || input.provider === "") {
    fail("E_VALIDATION", "Decision provider must be a non-empty string");
  }
  if (typeof input.model !== "string" || input.model === "") {
    fail("E_VALIDATION", "Decision model must be a non-empty string");
  }
  const questionIds = input.questionIds ?? ["q0"];
  if (
    !Array.isArray(questionIds) ||
    questionIds.length === 0 ||
    questionIds.some((id) => typeof id !== "string" || id === "")
  ) {
    fail("E_VALIDATION", "Decision questionIds must be a non-empty string array");
  }
  if (input.usage !== undefined) {
    const { inputTokens, outputTokens } = input.usage;
    for (const tokens of [inputTokens, outputTokens]) {
      if (!Number.isInteger(tokens) || tokens < 0) {
        fail("E_VALIDATION", "Decision usage tokens must be non-negative integers");
      }
    }
  }
  const execution = requireKind(runtime, input.identity, "decision");
  const existing = execution.decision;
  if (existing !== null) {
    if (
      JSON.stringify(existing.output) !== JSON.stringify(output) ||
      existing.routing.branch !== routing.branch ||
      existing.routing.reason !== routing.reason
    ) {
      fail("E_CONFLICT", "Decision answer is immutable and already recorded", { existing });
    }
    const recorded =
      routing.branch === null
        ? null
        : getOutput(runtime, input.identity.runId, input.identity.path, input.identity.attempt);
    if (routing.branch !== null && recorded === null) {
      fail("E_INTERNAL", "Recorded decision has no durable output");
    }
    return {
      output: recorded,
      decisionEventId: null,
      completionEventId: null,
      duplicate: true,
    };
  }

  appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "decision.requested",
      actor: "engine",
      payload: {
        provider: input.provider,
        model: input.model,
        questionIds: [...questionIds],
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      } satisfies DecisionRequestedPayload,
    },
  ]);
  const [answered] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "decision.answered",
      actor: "engine",
      payload: {
        output,
        routing,
        ...(input.usage === undefined ? {} : { usage: { ...input.usage } }),
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      } satisfies DecisionAnsweredPayload,
    },
  ]);
  if (answered === undefined) fail("E_INTERNAL", "Decision answer event was not appended");

  if (routing.branch === null) {
    return {
      output: null,
      decisionEventId: answered.id,
      completionEventId: null,
      duplicate: false,
    };
  }
  const recorded = recordDeterministic(runtime, {
    identity: input.identity,
    output: decisionPersistedOutput(output, routing.branch),
  });
  const completed = completeExecution(runtime, { identity: input.identity });
  return {
    output: recorded.output,
    decisionEventId: answered.id,
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
