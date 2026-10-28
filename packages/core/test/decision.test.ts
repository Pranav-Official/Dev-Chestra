import { beforeEach, describe, expect, it } from "vitest";
import {
  type DecisionOutput,
  deriveRouting,
  type EventEnvelope,
  type ExecStatus,
  emptyRunView,
  type NodeStateInit,
  reduce,
} from "../src/index.js";
import { ev, nodePath, RUN_PATH, resetEventIds } from "./helpers.js";

const DECISION_PATH = nodePath("decide");

function state(
  from: ExecStatus,
  to: ExecStatus,
  init?: NodeStateInit,
  attempt = 1,
  generation = 1,
): EventEnvelope<"node.state"> {
  return ev(
    "node.state",
    { from, to, attempt, generation, ...(init === undefined ? {} : { init }) },
    { path: DECISION_PATH },
  );
}

function answered(
  output: DecisionOutput,
  branch: string | null,
  reason: "matched" | "low_confidence" | "refused" | "error" = "matched",
  attempt = 1,
  generation = 1,
): EventEnvelope<"decision.answered"> {
  return ev(
    "decision.answered",
    { output, routing: { branch, reason }, attempt, generation },
    { path: DECISION_PATH },
  );
}

function booleanOutput(probability: number): DecisionOutput {
  return {
    kind: "boolean",
    value: probability >= 0.5,
    probability,
    confidence: Math.max(probability, 1 - probability),
    confidenceSource: "derived",
    model: "jev-latest",
  };
}

function runningView() {
  let view = emptyRunView();
  view = reduce(
    view,
    ev(
      "run.created",
      { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
      { path: RUN_PATH, actor: "user" },
    ),
  );
  view = reduce(view, ev("run.started", {}, { path: RUN_PATH }));
  view = reduce(view, state("pending", "ready", { kind: "decision", requireSubmission: false }));
  view = reduce(view, state("ready", "running"));
  return view;
}

describe("decision reducer", () => {
  beforeEach(() => resetEventIds());

  it("projects decision output and routing on answer", () => {
    let view = runningView();
    view = reduce(view, answered(booleanOutput(0.8), "true"));
    expect(view.executions[DECISION_PATH as string]?.decision).toMatchObject({
      routing: { branch: "true", reason: "matched" },
    });
  });

  it("replays the same answer idempotently", () => {
    const view = runningView();
    const event = answered(booleanOutput(0.8), "true");
    const once = reduce(view, event);
    const twice = reduce(once, { ...event, id: event.id + 100 });
    expect(twice.executions[DECISION_PATH as string]?.decision?.routing.branch).toBe("true");
    expect(twice.lastEventId).toBe(event.id + 100);
  });

  it("rejects a conflicting second answer", () => {
    let view = runningView();
    view = reduce(view, answered(booleanOutput(0.8), "true"));
    expect(() => reduce(view, answered(booleanOutput(0.1), "false"))).toThrow(/immutable/);
  });

  it("treats legacy answers without output as audit-only", () => {
    const view = runningView();
    const legacy = ev("decision.answered", { latencyMs: 12 }, { path: DECISION_PATH });
    const next = reduce(view, legacy);
    expect(next.executions[DECISION_PATH as string]?.decision).toBeNull();
    expect(next.lastEventId).toBe(legacy.id);
  });

  it("fences answers by attempt and generation", () => {
    const view = runningView();
    expect(() => reduce(view, answered(booleanOutput(0.8), "true", "matched", 2, 1))).toThrow(
      /fenced/,
    );
    expect(() => reduce(view, answered(booleanOutput(0.8), "true", "matched", 1, 2))).toThrow(
      /fenced/,
    );
  });

  it("clears the projection on retry and new generation", () => {
    let view = runningView();
    view = reduce(view, answered(booleanOutput(0.8), "true"));
    expect(view.executions[DECISION_PATH as string]?.decision).not.toBeNull();
    view = reduce(view, state("running", "failed"));
    view = reduce(view, state("failed", "pending", undefined, 2, 2));
    expect(view.executions[DECISION_PATH as string]?.decision).toBeNull();
    let regen = runningView();
    regen = reduce(regen, answered(booleanOutput(0.8), "true"));
    expect(regen.executions[DECISION_PATH as string]?.decision).not.toBeNull();
    regen = reduce(
      regen,
      ev(
        "node.attempt.started",
        {
          attempt: 1,
          generation: 2,
          mode: "resume",
          resolvedConfigHash: "c",
          nodeKind: "decision",
        },
        { path: DECISION_PATH },
      ),
    );
    expect(regen.executions[DECISION_PATH as string]?.decision).toBeNull();
  });

  it("reproduces the projection from a full replay", () => {
    const events = [
      ev(
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
        { path: RUN_PATH, actor: "user" },
      ),
      ev("run.started", {}, { path: RUN_PATH }),
      state("pending", "ready", { kind: "decision", requireSubmission: false }),
      state("ready", "running"),
      answered(booleanOutput(0.2), "false"),
    ];
    const live = events.reduce(
      (view, event) => reduce(view, event as EventEnvelope),
      emptyRunView(),
    );
    const replayed = events.reduce(
      (view, event) => reduce(view, event as EventEnvelope),
      emptyRunView(),
    );
    expect(replayed).toEqual(live);
    expect(replayed.executions[DECISION_PATH as string]?.decision?.routing.branch).toBe("false");
  });
});

describe("decision routing", () => {
  beforeEach(() => resetEventIds());

  const graph = {
    nodes: [
      { id: "start", type: "start" },
      { id: "decide", type: "decision" },
      { id: "left", type: "agent" },
      { id: "right", type: "agent" },
    ],
    edges: [
      { id: "s-d", from: "start", to: "decide" },
      { id: "d-t", from: "decide.true", to: "left" },
      { id: "d-f", from: "decide.false", to: "right" },
    ],
  };

  it("activates only the answered branch and skips the sibling", () => {
    const routing = deriveRouting(graph, {
      start: { status: "succeeded" },
      decide: { status: "succeeded", decision: { routing: { branch: "true" } } },
    });
    expect(routing.edges["d-t"]).toBe("active");
    expect(routing.edges["d-f"]).toBe("dead");
    expect(routing.ready).toContain("left");
    expect(routing.skipped).toContain("right");
  });

  it("marks uncertain active when answered uncertain", () => {
    const uncertain = {
      nodes: [
        { id: "start", type: "start" },
        { id: "decide", type: "decision" },
        { id: "alt", type: "agent" },
      ],
      edges: [
        { id: "s-d", from: "start", to: "decide" },
        { id: "d-u", from: "decide.uncertain", to: "alt" },
      ],
    };
    const routing = deriveRouting(uncertain, {
      start: { status: "succeeded" },
      decide: { status: "succeeded", decision: { routing: { branch: "uncertain" } } },
    });
    expect(routing.edges["d-u"]).toBe("active");
    expect(routing.ready).toContain("alt");
  });

  it("keeps decision edges pending before success", () => {
    const routing = deriveRouting(graph, {
      start: { status: "succeeded" },
      decide: { status: "running" },
    });
    expect(routing.edges["d-t"]).toBe("pending");
    expect(routing.edges["d-f"]).toBe("pending");
  });
});
