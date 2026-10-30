import { describe, expect, it } from "vitest";
import {
  deriveRouting,
  type EventEnvelope,
  type ExecView,
  isDurablyComplete,
  type Path,
  project,
  type RoutingExecutionState,
  type RoutingGraph,
  type ValidationIssue,
} from "../src/index.js";

let nextId = 1;
function envelope(type: string, path: string, payload: unknown): EventEnvelope {
  return {
    id: nextId++,
    runId: "run-1" as never,
    ts: new Date(1_000 + nextId).toISOString(),
    path: path as never,
    actor: "engine",
    v: 1,
    type: type as never,
    payload,
  } as EventEnvelope;
}

function state(path: string, to: string, extra: Record<string, unknown> = {}) {
  return envelope("node.state", path, {
    from: "pending",
    to,
    attempt: 1,
    generation: 1,
    ...extra,
  });
}

function running(path: string) {
  return envelope("node.state", path, { from: "ready", to: "running", attempt: 1, generation: 2 });
}

function attemptStarted(path: string) {
  return envelope("node.attempt.started", path, {
    attempt: 1,
    generation: 2,
    mode: "fresh",
    resolvedConfigHash: "h",
  });
}

function workflowLink(): EventEnvelope[] {
  return [
    state("call", "ready", { init: { kind: "workflow", requireSubmission: false } }),
    attemptStarted("call"),
    running("call"),
    envelope("workflow.linked", "call", {
      childRunId: "child-1",
      workflowId: "resume",
      workflowHash: "abc",
      attempt: 1,
      generation: 2,
    }),
  ];
}

function foreachStart(): EventEnvelope[] {
  return [
    state("each", "ready", { init: { kind: "foreach", requireSubmission: false } }),
    attemptStarted("each"),
    running("each"),
    envelope("foreach.started", "each", {
      total: 2,
      maxItems: 1000,
      sourceId: "fs_1",
      sourceHash: "s",
      attempt: 1,
      generation: 2,
    }),
  ];
}

describe("workflow/foreach node kinds", () => {
  it("reduces workflow.linked then workflow.completed into the controller", () => {
    const linked = project(workflowLink());
    expect(linked.executions.call?.workflow?.status).toBe("running");
    expect(linked.executions.call?.workflow?.childRunId).toBe("child-1");
    const full = project([
      ...workflowLink(),
      envelope("workflow.completed", "call", {
        childRunId: "child-1",
        status: "failed",
        resultRef: "out-1",
        attempt: 1,
        generation: 2,
      }),
    ]);
    expect(full.executions.call?.workflow?.status).toBe("failed");
    expect(full.executions.call?.workflow?.resultRef).toBe("out-1");
  });

  it("rejects completion for a different child (stale link)", () => {
    expect(() =>
      project([
        ...workflowLink(),
        envelope("workflow.completed", "call", {
          childRunId: "child-2",
          status: "succeeded",
          resultRef: null,
          attempt: 1,
          generation: 2,
        }),
      ]),
    ).toThrow();
  });

  it("reduces foreach.started and ordered item decisions", () => {
    const view = project([
      ...foreachStart(),
      envelope("foreach.item.decided", "each", {
        index: 0,
        status: "succeeded",
        resultRef: "fs_1:0",
        attempt: 1,
        generation: 2,
      }),
    ]);
    expect(view.executions.each?.foreach).toMatchObject({ total: 2, processed: 1, succeeded: 1 });
    // Out-of-order index is a conflict, not a silent skip.
    expect(() =>
      project([
        ...foreachStart(),
        envelope("foreach.item.decided", "each", {
          index: 2,
          status: "succeeded",
          attempt: 1,
          generation: 2,
        }),
      ]),
    ).toThrow();
  });

  it("accepts an optional parentRef on foreach.started without projecting it", () => {
    const view = project([
      ...foreachStart().slice(0, 2),
      attemptStarted("each"),
      running("each"),
      envelope("foreach.started", "each", {
        total: 1,
        maxItems: 10,
        sourceId: "fs_2",
        sourceHash: "s",
        parentRef: { kind: "devchestra.execution-context/v1", captureId: "ctx_1" },
        attempt: 1,
        generation: 2,
      }),
    ]);
    expect(view.executions.each?.foreach?.sourceId).toBe("fs_2");
  });

  it("routes workflow .failed only for failed/rejected children", () => {
    const graph: RoutingGraph = {
      nodes: [
        { id: "start", type: "start" },
        { id: "call", type: "workflow" },
        { id: "end", type: "end" },
      ],
      edges: [
        { id: "s-c", from: "start", to: "call" },
        { id: "c-e", from: "call", to: "end" },
        { id: "c-f", from: "call.failed", to: "end" },
      ],
    };
    const exec = (
      status: RoutingExecutionState["status"],
      workflow?: { status?: string | null },
    ): RoutingExecutionState => ({
      status,
      ...(workflow === undefined ? {} : { workflow }),
    });
    const ok = deriveRouting(graph, {
      start: exec("succeeded"),
      call: exec("succeeded", { status: "succeeded" }),
    });
    expect(ok.edges["c-e"]).toBe("active");
    expect(ok.edges["c-f"]).toBe("dead");
    const failed = deriveRouting(graph, {
      start: exec("succeeded"),
      call: exec("succeeded", { status: "failed" }),
    });
    expect(failed.edges["c-e"]).toBe("dead");
    expect(failed.edges["c-f"]).toBe("active");
    const rejected = deriveRouting(graph, {
      start: exec("succeeded"),
      call: exec("succeeded", { status: "rejected" }),
    });
    expect(rejected.edges["c-f"]).toBe("active");
    // Cancelled children never route: both endpoints stay dead.
    const cancelled = deriveRouting(graph, {
      start: exec("succeeded"),
      call: exec("succeeded", { status: "cancelled" }),
    });
    expect(cancelled.edges["c-e"]).toBe("dead");
    expect(cancelled.edges["c-f"]).toBe("dead");
  });

  it("treats workflow/foreach durability via controller + recorded output", () => {
    const base: Omit<ExecView, "status" | "kind" | "workflow" | "foreach"> = {
      path: "call" as Path,
      nodeId: "call",
      attempt: 1,
      generation: 1,
      gateDecision: null,
      joinResolution: null,
      approvalRequest: null,
      approvalDecision: null,
      decision: null,
      loop: null,
      requiresAcceptedResult: false,
      acceptedResult: null,
      recordedOutput: null,
      processSpawned: null,
      processStopped: null,
      workspaceFinalized: null,
      validationAttempts: 0,
      crashAttempts: 0,
      mode: null,
      cli: null,
      sessionId: null,
      sessionCwd: null,
      model: null,
      resolvedConfigHash: null,
      inputsHash: null,
      startedAt: null,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      attemptTokensIn: 0,
      attemptTokensOut: 0,
      attemptCostUsd: 0,
      workspaceDir: null,
      branch: null,
      workspaceCommitted: null,
      lastValidationErrors: [] as ValidationIssue[],
      lastTranscript: null,
      lastError: null,
    };
    expect(
      isDurablyComplete({
        ...base,
        status: "succeeded",
        kind: "workflow",
        workflow: {
          childRunId: "c",
          workflowId: "w",
          status: "succeeded",
          resultRef: "o",
          eventId: 1,
        },
        foreach: null,
        recordedOutput: { attempt: 1, generation: 1, outputId: "o", outputHash: "h", eventId: 2 },
      }),
    ).toBe(true);
    expect(
      isDurablyComplete({
        ...base,
        status: "running",
        kind: "workflow",
        workflow: {
          childRunId: "c",
          workflowId: "w",
          status: "running",
          resultRef: null,
          eventId: 1,
        },
        foreach: null,
      }),
    ).toBe(false);
    expect(
      isDurablyComplete({
        ...base,
        status: "succeeded",
        kind: "foreach",
        workflow: null,
        foreach: {
          total: 2,
          processed: 1,
          succeeded: 1,
          failed: 0,
          rejected: 0,
          resultsRef: "s",
          sourceId: "s",
          eventId: 1,
        },
      }),
    ).toBe(false);
  });
});
