import type { ExecutionIdentity } from "@devchestra/core";
import { appendEvents } from "./events.js";
import { requireCurrent } from "./executions.js";
import { countForeachItems, getForeachSource, recordForeachItem } from "./foreach.js";
import { assertRunActive, loadView } from "./projection.js";
import { getChildLink, linkChild, setChildStatus } from "./run-children.js";
import type { Runtime } from "./runtime.js";
import { fail } from "./util.js";

export interface RecordWorkflowLinkedInput {
  identity: ExecutionIdentity;
  childRunId: string;
  workflowId: string;
  workflowHash: string;
}

export function recordWorkflowLinked(
  runtime: Runtime,
  input: RecordWorkflowLinkedInput,
): { eventId: number | null; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const view = loadView(runtime, input.identity.runId);
  const exec = view.executions[input.identity.path];
  if (!exec) fail("E_NOT_FOUND", `Execution ${input.identity.path} is not projected`);
  if (exec.kind !== null && exec.kind !== "workflow") {
    fail("E_CONFLICT", `Execution ${input.identity.path} is not a workflow node`, {
      kind: exec.kind,
    });
  }
  if (exec.workflow !== null && exec.workflow !== undefined) {
    const existing = getChildLink(
      runtime,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
    );
    if (existing && existing.childRunId === input.childRunId) {
      return { eventId: null, duplicate: true };
    }
    fail("E_CONFLICT", "Workflow node already linked to a different child run");
  }
  const { duplicate } = linkChild(runtime, {
    identity: input.identity,
    childRunId: input.childRunId,
    workflowId: input.workflowId,
    workflowHash: input.workflowHash,
  });
  if (duplicate) return { eventId: null, duplicate: true };
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "workflow.linked",
      actor: "engine",
      payload: {
        childRunId: input.childRunId,
        workflowId: input.workflowId,
        workflowHash: input.workflowHash,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Workflow link event was not appended");
  return { eventId: event.id, duplicate: false };
}

export interface RecordWorkflowCompletedInput {
  identity: ExecutionIdentity;
  childRunId: string;
  status: "succeeded" | "failed" | "rejected" | "cancelled";
  resultRef: string | null;
}

export function recordWorkflowCompleted(
  runtime: Runtime,
  input: RecordWorkflowCompletedInput,
): { eventId: number | null; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const view = loadView(runtime, input.identity.runId);
  const exec = view.executions[input.identity.path];
  if (!exec?.workflow) fail("E_CONFLICT", "Workflow completion requires a prior link");
  if (exec.workflow.childRunId !== input.childRunId) {
    fail("E_CONFLICT", "Stale workflow completion for another child");
  }
  if (exec.workflow.status !== "running") return { eventId: null, duplicate: true };
  setChildStatus(
    runtime,
    input.identity.runId,
    input.identity.path,
    input.identity.attempt,
    input.status,
  );
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "workflow.completed",
      actor: "engine",
      payload: {
        childRunId: input.childRunId,
        status: input.status,
        resultRef: input.resultRef,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Workflow completed event was not appended");
  return { eventId: event.id, duplicate: false };
}

export interface RecordForeachStartedInput {
  identity: ExecutionIdentity;
  total: number;
  maxItems: number;
  sourceId: string;
  sourceHash: string;
}

export function recordForeachStarted(
  runtime: Runtime,
  input: RecordForeachStartedInput,
): { eventId: number | null; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const view = loadView(runtime, input.identity.runId);
  const exec = view.executions[input.identity.path];
  if (!exec) fail("E_NOT_FOUND", `Execution ${input.identity.path} is not projected`);
  if (exec.foreach !== null && exec.foreach !== undefined)
    return { eventId: null, duplicate: true };
  const source = getForeachSource(runtime, input.sourceId);
  if (!source) fail("E_NOT_FOUND", `Foreach source ${input.sourceId} is missing`);
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "foreach.started",
      actor: "engine",
      payload: {
        total: input.total,
        maxItems: input.maxItems,
        sourceId: input.sourceId,
        sourceHash: input.sourceHash,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Foreach start event was not appended");
  return { eventId: event.id, duplicate: false };
}

export interface RecordForeachItemInput {
  identity: ExecutionIdentity;
  sourceId: string;
  index: number;
  status: "succeeded" | "failed" | "rejected" | "skipped";
  result?: unknown;
}

export function recordForeachItemDecided(
  runtime: Runtime,
  input: RecordForeachItemInput,
): { eventId: number | null; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const decided = countForeachItems(runtime, input.sourceId);
  if (decided > input.index) return { eventId: null, duplicate: true };
  if (decided !== input.index) {
    fail("E_CONFLICT", "Stale or future foreach index", {
      expected: decided,
      received: input.index,
    });
  }
  recordForeachItem(runtime, input.sourceId, input.index, input.status, input.result ?? null);
  const ref = `${input.sourceId}:${input.index}`;
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "foreach.item.decided",
      actor: "engine",
      payload: {
        index: input.index,
        status: input.status,
        resultRef: ref,
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Foreach item event was not appended");
  return { eventId: event.id, duplicate: false };
}
