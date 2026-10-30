import { describe, expect, it } from "vitest";
import {
  eventEnvelopeSchema,
  extendedEventPayloadSchemas,
  foreachItemsResponseSchema,
  normalizedWorkflowSchema,
  runChildrenResponseSchema,
  runViewSchema,
} from "../src/index.js";

const base = { name: "Node", supervise: "default", env: [] };
const envelope = (id: number, type: string, payload: unknown) => ({
  id,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  path: "each",
  ts: "2026-10-29T10:00:00Z",
  actor: "engine",
  type,
  v: 1,
  payload,
});

describe("foreach + workflow API contracts", () => {
  it("accepts normalized foreach and workflow nodes", () => {
    const foreach = {
      ...base,
      id: "each",
      type: "foreach",
      source: { kind: "expression", expression: "start.items" },
      maxItems: 10,
      onItemFailure: "stop",
      result: "{}",
      output: { type: "object" },
      body: {
        nodes: [{ ...base, id: "done", type: "end", status: "success", result: "{}" }],
        edges: [],
      },
    };
    const child = {
      ...base,
      id: "sub",
      type: "workflow",
      workflowId: "other",
      inputs: { topic: "start.topic" },
    };
    const workflow = {
      schemaVersion: 1,
      id: "w",
      name: "Workflow",
      graph: { nodes: [foreach, child], edges: [] },
    };
    expect(normalizedWorkflowSchema.safeParse(workflow).success).toBe(true);
    expect(
      normalizedWorkflowSchema.safeParse({
        ...workflow,
        graph: {
          nodes: [{ ...foreach, body: { nodes: [foreach], edges: [] } }],
          edges: [],
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedWorkflowSchema.safeParse({
        ...workflow,
        graph: { nodes: [{ ...foreach, maxItems: 0 }], edges: [] },
      }).success,
    ).toBe(false);
  });

  it("validates new strict event payloads without hydration", () => {
    expect(
      eventEnvelopeSchema.safeParse(
        envelope(1, "workflow.linked", {
          childRunId: "01ARZ3NDEKTSV4RRFFQ69G5FBV",
          workflowId: "other",
          workflowHash: "abc",
        }),
      ).success,
    ).toBe(true);
    expect(
      eventEnvelopeSchema.safeParse(
        envelope(2, "workflow.completed", {
          childRunId: "01ARZ3NDEKTSV4RRFFQ69G5FBV",
          status: "succeeded",
          resultRef: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
      ).success,
    ).toBe(true);
    expect(
      eventEnvelopeSchema.safeParse(
        envelope(3, "foreach.started", {
          total: 3,
          maxItems: 1000,
          sourceId: "s1",
          sourceHash: "h",
        }),
      ).success,
    ).toBe(true);
    expect(
      eventEnvelopeSchema.safeParse(
        envelope(4, "foreach.item.decided", { index: 0, status: "succeeded" }),
      ).success,
    ).toBe(true);
    // Payload shapes are strict: wrong status rejected.
    expect(extendedEventPayloadSchemas["workflow.completed"].safeParse({}).success).toBe(false);
  });

  it("projects foreach/workflow controller refs on exec views", () => {
    const view = {
      status: "running",
      runNumber: 1,
      executions: {
        each: {
          path: "each",
          nodeId: "each",
          status: "running",
          attempt: 1,
          generation: 1,
          kind: "foreach",
          loop: null,
          workflow: null,
          foreach: {
            total: 2,
            processed: 1,
            succeeded: 1,
            failed: 0,
            rejected: 0,
            resultsRef: "r1",
            sourceId: "s1",
            eventId: 3,
          },
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
          lastValidationErrors: [],
          lastTranscript: null,
          lastError: null,
          gateDecision: null,
          joinResolution: null,
        },
      },
      edges: {},
      providers: {},
      budget: { usd: 0, tokens: 0, activeMs: 0, supervisorUsd: 0 },
      activeSince: null,
      pausedAt: null,
      pausedMs: 0,
      pauseReason: null,
      pauseDetail: null,
      pausePath: null,
      supervisor: { wakes: 0, interventions: 0, recs: [] },
      errors: [],
      lastEventId: 1,
    };
    expect(runViewSchema.safeParse(view).success).toBe(true);
  });

  it("types paginated children/items responses (refs only)", () => {
    expect(
      runChildrenResponseSchema.safeParse({
        items: [{ childRunId: "a", workflowId: "w", path: "sub", status: "succeeded" }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      foreachItemsResponseSchema.safeParse({
        source: { sourceId: "fs_abc", kind: "expression", path: "each", total: 2 },
        items: [{ index: 0, status: "succeeded", path: "each[0]", outputId: "out-1" }],
        nextCursor: "n",
      }).success,
    ).toBe(true);
    expect(
      foreachItemsResponseSchema.safeParse({
        source: { sourceId: "fs_abc", kind: "expression", path: "each", total: 0 },
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});
