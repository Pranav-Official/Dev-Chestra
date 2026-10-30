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

  describe("terminal loop outcome", () => {
    const prelude = [
      envelope(1, "node.state", {
        from: "pending",
        to: "ready",
        attempt: 1,
        generation: 1,
        init: { kind: "loop", requireSubmission: false },
      }),
      envelope(2, "node.state", { from: "ready", to: "running", attempt: 1, generation: 1 }),
      envelope(3, "loop.started", { iteration: 1, parent: {}, state: {} }),
    ];
    function project(...decisions: unknown[]) {
      let view = emptyRunView();
      for (const event of [...prelude, ...decisions]) {
        expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
        view = reduce(view, event as EventEnvelope);
      }
      return view;
    }

    it("round-trips an explicit iteration_limit round through events and the view", () => {
      const view = project(
        envelope(4, "loop.iteration.decided", {
          iteration: 1,
          result: { r: 1 },
          done: false,
          outcome: "iteration_limit",
        }),
      );
      expect(runViewSchema.safeParse(view).success).toBe(true);
      expect(view.executions.refine?.loop?.rounds[0]).toMatchObject({
        done: false,
        outcome: "iteration_limit",
      });
      const parsed = runViewSchema.parse(view);
      expect(parsed.executions.refine?.loop?.rounds[0]?.outcome).toBe("iteration_limit");
    });

    it("keeps legacy events and cached views without outcome valid", () => {
      const view = project(
        envelope(4, "loop.iteration.decided", { iteration: 1, result: {}, done: true }),
      );
      expect(view.executions.refine?.loop?.rounds[0]?.outcome).toBe("condition_met");
      const legacy = structuredClone(view);
      // A view cached before explicit outcomes has no `outcome` key at all.
      const round = legacy.executions.refine?.loop?.rounds[0] as unknown as Record<string, unknown>;
      delete round.outcome;
      expect(runViewSchema.safeParse(legacy).success).toBe(true);
    });

    it("rejects unknown outcomes in events and views", () => {
      expect(
        eventEnvelopeSchema.safeParse(
          envelope(4, "loop.iteration.decided", {
            iteration: 1,
            result: {},
            done: false,
            outcome: "gave_up",
          }),
        ).success,
      ).toBe(false);
      const view = project(
        envelope(4, "loop.iteration.decided", { iteration: 1, result: {}, done: true }),
      );
      const bad = structuredClone(view);
      (bad.executions.refine?.loop?.rounds[0] as unknown as Record<string, unknown>).outcome =
        "gave_up";
      expect(runViewSchema.safeParse(bad).success).toBe(false);
    });

    it("accepts a normalized workflow wiring the exhausted output", () => {
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
        graph: {
          nodes: [
            { ...base, id: "start", type: "start", params: [] },
            loop,
            { ...base, id: "ok", type: "end", status: "success", result: "refine" },
            { ...base, id: "spent", type: "end", status: "failed", result: "refine" },
          ],
          edges: [
            { id: "e0", from: "start", to: "refine" },
            { id: "e1", from: "refine", to: "ok" },
            { id: "e2", from: "refine.exhausted", to: "spent" },
          ],
        },
      };
      expect(normalizedWorkflowSchema.safeParse(workflow).success).toBe(true);
    });
  });

  it("exposes an actionable iteration-limit error", () => {
    expect(httpStatusForErrorCode("E_LOOP_LIMIT")).toBe(409);
  });
});
