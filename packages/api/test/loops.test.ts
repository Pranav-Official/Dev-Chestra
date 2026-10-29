import { type EventEnvelope, emptyRunView, reduce } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import {
  eventEnvelopeSchema,
  httpStatusForErrorCode,
  normalizedWorkflowSchema,
  runViewSchema,
} from "../src/index.js";

const base = { name: "Node", supervise: "default", env: [] };
const envelope = (id: number, type: string, payload: unknown) => ({
  id,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  path: "refine",
  ts: "2026-10-29T10:00:00Z",
  actor: "engine",
  type,
  v: 1,
  payload,
});

describe("loop API contracts", () => {
  it("accepts normalized loop bodies and rejects nested loops", () => {
    const loop = {
      ...base,
      id: "refine",
      type: "loop",
      mode: "repeatUntil",
      maxIterations: 3,
      initialState: "{}",
      nextState: "loop.state",
      result: "{}",
      until: "true",
      output: { type: "object" },
      body: {
        nodes: [{ ...base, id: "done", type: "end", status: "success", result: "{}" }],
        edges: [],
      },
    };
    const workflow = {
      schemaVersion: 1,
      id: "w",
      name: "Workflow",
      graph: { nodes: [loop], edges: [] },
    };
    expect(normalizedWorkflowSchema.safeParse(workflow).success).toBe(true);
    expect(
      normalizedWorkflowSchema.safeParse({
        ...workflow,
        graph: { nodes: [{ ...loop, body: { nodes: [loop], edges: [] } }], edges: [] },
      }).success,
    ).toBe(false);
  });

  it("validates durable loop events and their projected controller", () => {
    const events = [
      envelope(1, "node.state", {
        from: "pending",
        to: "ready",
        attempt: 1,
        generation: 1,
        init: { kind: "loop", requireSubmission: false },
      }),
      envelope(2, "node.attempt.started", {
        attempt: 1,
        generation: 2,
        mode: "fresh",
        resolvedConfigHash: "hash",
        nodeKind: "loop",
        requireSubmission: false,
      }),
      envelope(3, "node.state", { from: "ready", to: "running", attempt: 1, generation: 2 }),
      envelope(4, "loop.started", {
        iteration: 1,
        parent: {},
        state: {},
        attempt: 1,
        generation: 2,
      }),
      envelope(5, "loop.iteration.decided", {
        iteration: 1,
        result: { passed: true },
        done: true,
        attempt: 1,
        generation: 2,
      }),
    ];
    let view = emptyRunView();
    for (const event of events) {
      expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
      view = reduce(view, event as EventEnvelope);
    }
    expect(runViewSchema.safeParse(view).success).toBe(true);
    expect(view.executions.refine?.loop?.rounds[0]?.result).toEqual({ passed: true });
    expect(
      eventEnvelopeSchema.safeParse(
        envelope(5, "loop.iteration.decided", { iteration: 2, result: {}, done: "yes" }),
      ).success,
    ).toBe(false);
  });

  it("exposes an actionable iteration-limit error", () => {
    expect(httpStatusForErrorCode("E_LOOP_LIMIT")).toBe(409);
  });
});
