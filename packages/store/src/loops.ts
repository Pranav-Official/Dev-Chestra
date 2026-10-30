import {
  canonicalJson,
  type ExecutionContextRef,
  type ExecutionIdentity,
  type ExecView,
  isExecutionContextRef,
  isRecord,
  type LoopView,
  loopDecisionProblem,
  loopRoundOutcome,
  loopTerminalOutcome,
  MAX_LOOP_HISTORY,
} from "@devchestra/core";
import { requireContextCapture } from "./context-captures.js";
import { appendEvents } from "./events.js";
import { requireCurrent } from "./executions.js";
import { assertRunActive, loadView } from "./projection.js";
import type { Runtime } from "./runtime.js";
import type {
  DecideLoopInput,
  DecideLoopResult,
  StartLoopInput,
  StartLoopResult,
} from "./types.js";
import { fail } from "./util.js";

const MAX_LOOP_VALUE_BYTES = 16 * 1024;

function requireLoopController(runtime: Runtime, identity: ExecutionIdentity): ExecView {
  assertRunActive(runtime, identity.runId);
  const row = requireCurrent(runtime, identity);
  if (row.kind !== "loop") {
    fail("E_CONFLICT", `Execution ${identity.path} is not a loop controller`, {
      kind: row.kind,
    });
  }
  const execution = loadView(runtime, identity.runId).executions[identity.path];
  if (execution === undefined) fail("E_INTERNAL", `Execution ${identity.path} is not projected`);
  return execution;
}

function checkedObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("E_VALIDATION", `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function checkedSize(value: unknown, label: string): string {
  let text: string;
  try {
    text = canonicalJson(value);
  } catch (error) {
    fail("E_VALIDATION", `${label} is not canonical JSON-serializable`, { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_LOOP_VALUE_BYTES) {
    fail("E_VALIDATION", `${label} exceeds the 16 KiB JSON limit`, {
      bytes: Buffer.byteLength(text, "utf8"),
      limit: MAX_LOOP_VALUE_BYTES,
    });
  }
  return text;
}

function rejectSecrets(runtime: Runtime, value: unknown, label: string): void {
  const finding = runtime.secrets.scanValue(value);
  if (finding) {
    fail("E_VALIDATION", `${label} contains a secret; remove it before starting or deciding`, {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function startLoop(runtime: Runtime, input: StartLoopInput): StartLoopResult {
  const hasParent = input.parent !== undefined;
  const hasParentRef = input.parentRef !== undefined;
  if ((hasParent ? 1 : 0) + (hasParentRef ? 1 : 0) !== 1) {
    fail("E_VALIDATION", "Loop start must carry exactly one of parent or parentRef");
  }
  let parent: Record<string, unknown> | null = null;
  let parentRef: ExecutionContextRef | null = null;
  if (hasParentRef) {
    if (!isExecutionContextRef(input.parentRef)) {
      fail("E_VALIDATION", "Loop parentRef must be a tagged execution-context reference");
    }
    parentRef = input.parentRef as ExecutionContextRef;
    // Ownership + existence checked here so corrupt/cross-run refs fail fast.
    // The manifest itself carries the values; the event stays small.
    requireContextCapture(
      runtime,
      parentRef,
      input.identity.runId as string,
      input.identity.path as string,
    );
  } else {
    parent = checkedObject(input.parent, "Loop parent");
    checkedSize(parent, "Loop parent");
    rejectSecrets(runtime, parent, "Loop parent");
  }
  const state = checkedObject(input.state, "Loop state");
  checkedSize(state, "Loop state");
  rejectSecrets(runtime, state, "Loop state");

  const execution = requireLoopController(runtime, input.identity);
  const existing = execution.loop;
  if (existing !== null) {
    const sameRef = (existing.parentRef?.captureId ?? null) === (parentRef?.captureId ?? null);
    const sameParent =
      parentRef !== null || existing.parentRef !== null
        ? sameRef
        : sameJson(existing.parent, parent);
    if (
      existing.iteration === 1 &&
      existing.rounds.length === 0 &&
      sameParent &&
      sameJson(existing.state, state)
    ) {
      return { loop: existing, eventId: null, duplicate: true };
    }
    fail("E_CONFLICT", "Loop controller is immutable once started", {
      existing: { iteration: existing.iteration, rounds: existing.rounds.length },
    });
  }

  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "loop.started",
      actor: "engine",
      payload:
        parentRef !== null
          ? {
              iteration: 1,
              parentRef: { kind: parentRef.kind, captureId: parentRef.captureId },
              state: { ...state },
              attempt: input.identity.attempt,
              generation: input.identity.generation,
            }
          : {
              iteration: 1,
              parent: { ...(parent as Record<string, unknown>) },
              state: { ...state },
              attempt: input.identity.attempt,
              generation: input.identity.generation,
            },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Loop start event was not appended");
  const loop = loadView(runtime, input.identity.runId).executions[input.identity.path]
    ?.loop as LoopView | null;
  if (!loop) fail("E_INTERNAL", "Loop controller disappeared inside its transaction");
  return { loop, eventId: event.id, duplicate: false };
}

export function decideLoop(runtime: Runtime, input: DecideLoopInput): DecideLoopResult {
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) {
    fail("E_VALIDATION", "Loop iteration must be a positive integer");
  }
  if (input.iteration > MAX_LOOP_HISTORY) {
    fail("E_VALIDATION", `Loop iteration exceeds the ${MAX_LOOP_HISTORY} history bound`);
  }
  if (typeof input.done !== "boolean") {
    fail("E_VALIDATION", "Loop done must be a boolean");
  }
  const resultText = checkedSize(input.result, "Loop result");
  let nextState: Record<string, unknown> | undefined;
  if (input.nextState !== undefined) {
    nextState = checkedObject(input.nextState, "Loop nextState");
    checkedSize(nextState, "Loop nextState");
  }
  const problem = loopDecisionProblem({
    done: input.done,
    outcome: input.outcome,
    nextState,
  });
  if (problem !== null) fail("E_VALIDATION", problem);
  const outcome = loopRoundOutcome({ done: input.done, outcome: input.outcome ?? null });
  rejectSecrets(runtime, input.result, "Loop result");
  if (nextState !== undefined) rejectSecrets(runtime, nextState, "Loop nextState");

  const execution = requireLoopController(runtime, input.identity);
  const loop = execution.loop;
  if (loop === null) {
    fail("E_CONFLICT", "Loop controller has not started; call loops.start first", {
      path: input.identity.path,
    });
  }
  const current = loop as LoopView;
  const existing = current.rounds.find((round) => round.iteration === input.iteration);
  if (existing !== undefined) {
    const same =
      sameJson(existing.result, input.result) &&
      existing.done === input.done &&
      loopRoundOutcome(existing) === outcome &&
      sameJson(existing.nextState ?? null, nextState ?? null);
    if (same) {
      return { loop: current, eventId: null, duplicate: true };
    }
    fail("E_CONFLICT", "Loop round decision is immutable and already recorded", {
      existing,
    });
  }
  if (loopTerminalOutcome(current) !== null) {
    fail("E_CONFLICT", "Loop is already finished; no further decisions", {
      path: input.identity.path,
      iteration: input.iteration,
    });
  }
  if (input.iteration !== current.iteration) {
    fail("E_CONFLICT", "Stale or future loop iteration", {
      expected: current.iteration,
      received: input.iteration,
    });
  }

  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "loop.iteration.decided",
      actor: "engine",
      payload: {
        iteration: input.iteration,
        result: JSON.parse(resultText as string),
        done: input.done,
        ...(nextState === undefined ? {} : { nextState: { ...nextState } }),
        ...(outcome === null ? {} : { outcome }),
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Loop decision event was not appended");
  const next = loadView(runtime, input.identity.runId).executions[input.identity.path]
    ?.loop as LoopView | null;
  if (!next) fail("E_INTERNAL", "Loop controller disappeared inside its transaction");
  return { loop: next, eventId: event.id, duplicate: false };
}
