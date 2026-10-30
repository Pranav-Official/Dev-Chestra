import { beforeEach, describe, expect, it } from "vitest";
import {
  DevChestraError,
  deriveRouting,
  type EventEnvelope,
  type ExecView,
  isDurablyComplete,
  LOOP_EXHAUSTED_HANDLE,
  type LoopOutcome,
  loopDecisionProblem,
  loopRoundOutcome,
  loopTerminalOutcome,
  project,
  type RoutingGraph,
  type RunView,
} from "../src/index.js";
import { ev, nodePath, RUN_PATH, resetEventIds } from "./helpers.js";

const LOOP_PATH = nodePath("refine");

// Decisions are built before the preamble in some tests, so give them their own
// ascending id range (the reducer ignores non-monotonic ids).
let decisionId = 100;
function nextDecisionId(): number {
  decisionId += 1;
  return decisionId;
}

function preamble(): EventEnvelope[] {
  return [
    ev(
      "run.created",
      {
        workflowId: "loops",
        workflowHash: "h",
        runNumber: 1,
        params: {},
        budgets: {},
        kind: "run",
      },
      { path: RUN_PATH, actor: "user" },
    ),
    ev("run.started", {}, { path: RUN_PATH }),
    ev(
      "node.state",
      {
        from: "pending",
        to: "ready",
        attempt: 1,
        generation: 1,
        init: { kind: "loop", requireSubmission: false },
      },
      { path: LOOP_PATH },
    ),
    ev(
      "node.state",
      { from: "ready", to: "running", attempt: 1, generation: 1 },
      {
        path: LOOP_PATH,
      },
    ),
    ev(
      "loop.started",
      { iteration: 1, parent: {}, state: { n: 0 }, attempt: 1, generation: 1 },
      { path: LOOP_PATH },
    ),
  ];
}

function decided(
  iteration: number,
  fields: {
    done: boolean;
    outcome?: LoopOutcome;
    nextState?: Record<string, never> | { n: number };
    result?: unknown;
  },
): EventEnvelope<"loop.iteration.decided"> {
  return ev(
    "loop.iteration.decided",
    {
      iteration,
      result: (fields.result ?? { r: iteration }) as never,
      done: fields.done,
      ...(fields.nextState === undefined ? {} : { nextState: fields.nextState }),
      ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
      attempt: 1,
      generation: 1,
    },
    { path: LOOP_PATH, id: nextDecisionId() },
  );
}

function loopOf(view: RunView) {
  const loop = view.executions[LOOP_PATH as string]?.loop;
  if (!loop) throw new Error("loop missing");
  return loop;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DevChestraError) return error.code;
    throw error;
  }
  return "none";
}

beforeEach(() => {
  resetEventIds();
  decisionId = 100;
});

describe("loop terminal outcome reducer", () => {
  it("records iteration_limit as a terminal round without advancing or faking done", () => {
    const view = project([
      ...preamble(),
      decided(1, { done: false, nextState: { n: 1 } }),
      decided(2, { done: false, outcome: "iteration_limit" }),
    ]);
    const loop = loopOf(view);
    expect(loop.iteration).toBe(2);
    expect(loop.state).toEqual({ n: 1 });
    expect(loop.rounds[0]).toMatchObject({ done: false, outcome: null });
    expect(loop.rounds[1]).toMatchObject({ iteration: 2, done: false, outcome: "iteration_limit" });
    expect(loopTerminalOutcome(loop)).toBe("iteration_limit");
  });

  it("infers condition_met for legacy done=true rounds and null for legacy false rounds", () => {
    const view = project([
      ...preamble(),
      decided(1, { done: false, nextState: { n: 1 } }),
      decided(2, { done: true }),
    ]);
    expect(loopOf(view).rounds.map((round) => round.outcome)).toEqual([null, "condition_met"]);
    expect(loopRoundOutcome({ done: true })).toBe("condition_met");
    expect(loopRoundOutcome({ done: false })).toBeNull();
    expect(loopRoundOutcome({ done: false, outcome: "iteration_limit" })).toBe("iteration_limit");
  });

  it("rejects invalid done/outcome/nextState combinations", () => {
    const rejects = (event: EventEnvelope<"loop.iteration.decided">) =>
      expect(() => project([...preamble(), event])).toThrow(DevChestraError);
    rejects(decided(1, { done: true, outcome: "iteration_limit" }));
    rejects(decided(1, { done: false, outcome: "condition_met" }));
    rejects(decided(1, { done: false, outcome: "iteration_limit", nextState: { n: 1 } }));
    rejects(decided(1, { done: true, outcome: "condition_met", nextState: { n: 1 } }));
    rejects(decided(1, { done: true, nextState: { n: 1 } }));
    rejects(decided(1, { done: false, outcome: "bogus" as never }));
  });

  it("rejects any later decision after a terminal outcome, whichever kind", () => {
    const exhausted = [...preamble(), decided(1, { done: false, outcome: "iteration_limit" })];
    expect(code(() => project([...exhausted, decided(2, { done: false })]))).toBe("E_CONFLICT");
    expect(code(() => project([...exhausted, decided(2, { done: true })]))).toBe("E_CONFLICT");
    const matched = [...preamble(), decided(1, { done: true, outcome: "condition_met" })];
    expect(code(() => project([...matched, decided(2, { done: false })]))).toBe("E_CONFLICT");
  });

  it("replays an identical terminal decision idempotently and rejects a changed outcome", () => {
    const first = decided(1, { done: false, outcome: "iteration_limit" });
    const once = project([...preamble(), first]);
    const twice = project([
      ...preamble(),
      first,
      decided(1, { done: false, outcome: "iteration_limit" }),
    ]);
    expect(loopOf(twice).rounds).toEqual(loopOf(once).rounds);
    expect(loopOf(twice).rounds).toHaveLength(1);
    // Same result and done=false, but a non-terminal replay differs in outcome.
    expect(
      code(() => project([...preamble(), first, decided(1, { done: false, nextState: { n: 1 } })])),
    ).toBe("E_CONFLICT");
    // done=true/condition_met cannot overwrite an iteration_limit round.
    expect(code(() => project([...preamble(), first, decided(1, { done: true })]))).toBe(
      "E_CONFLICT",
    );
    // Legacy done=true replays equal an explicit condition_met round.
    const legacy = decided(1, { done: true });
    const explicit = decided(1, { done: true, outcome: "condition_met" });
    expect(loopOf(project([...preamble(), legacy, explicit])).rounds).toHaveLength(1);
  });
});

describe("loopDecisionProblem", () => {
  it("accepts only coherent combinations", () => {
    expect(loopDecisionProblem({ done: false })).toBeNull();
    expect(loopDecisionProblem({ done: false, nextState: {} })).toBeNull();
    expect(loopDecisionProblem({ done: true })).toBeNull();
    expect(loopDecisionProblem({ done: true, outcome: "condition_met" })).toBeNull();
    expect(loopDecisionProblem({ done: false, outcome: "iteration_limit" })).toBeNull();
    expect(loopDecisionProblem({ done: true, outcome: "iteration_limit" })).not.toBeNull();
    expect(loopDecisionProblem({ done: false, outcome: "condition_met" })).not.toBeNull();
    expect(
      loopDecisionProblem({ done: false, outcome: "iteration_limit", nextState: {} }),
    ).not.toBeNull();
    expect(loopDecisionProblem({ done: false, outcome: "other" })).not.toBeNull();
  });
});

describe("loop durable completion", () => {
  function exec(rounds: { done: boolean; outcome?: LoopOutcome | null }[]): ExecView {
    return {
      kind: "loop",
      status: "running",
      attempt: 1,
      generation: 1,
      requiresAcceptedResult: false,
      acceptedResult: null,
      recordedOutput: { attempt: 1, generation: 1, outputId: "o", outputHash: "h", eventId: 9 },
      loop: {
        iteration: 1,
        parent: {},
        parentRef: null,
        state: {},
        rounds: rounds.map((round, index) => ({
          iteration: index + 1,
          result: {},
          nextState: null,
          eventId: index + 1,
          ...round,
        })),
      },
    } as unknown as ExecView;
  }

  it("is complete for either terminal outcome and not for a plain false round", () => {
    expect(isDurablyComplete(exec([{ done: true }]))).toBe(true);
    expect(isDurablyComplete(exec([{ done: false, outcome: "iteration_limit" }]))).toBe(true);
    expect(isDurablyComplete(exec([{ done: false }]))).toBe(false);
    expect(isDurablyComplete(exec([]))).toBe(false);
  });
});

describe("loop routing", () => {
  const graph: RoutingGraph = {
    nodes: [
      { id: "start", type: "start" },
      { id: "refine", type: "loop" },
      { id: "ok", type: "end" },
      { id: "spent", type: "end" },
    ],
    edges: [
      { id: "s", from: "start", to: "refine" },
      { id: "success", from: "refine", to: "ok" },
      { id: "exhausted", from: `refine.${LOOP_EXHAUSTED_HANDLE}`, to: "spent" },
    ],
  };
  const start = { status: "succeeded" } as const;

  it("activates only the exhausted edge for an iteration_limit loop", () => {
    const routing = deriveRouting(graph, {
      start,
      refine: {
        status: "succeeded",
        loop: { rounds: [{ done: false, outcome: "iteration_limit" }] },
      },
    });
    expect(routing.edges.success).toBe("dead");
    expect(routing.edges.exhausted).toBe("active");
    expect(routing.ready).toEqual(["spent"]);
    expect(routing.skipped).toEqual(["ok"]);
  });

  it("activates only the success edge for condition_met and for legacy succeeded loops", () => {
    for (const loop of [
      { rounds: [{ done: true, outcome: "condition_met" as const }] },
      { rounds: [{ done: true }] },
      null,
      undefined,
    ]) {
      const routing = deriveRouting(graph, {
        start,
        refine: { status: "succeeded", ...(loop === undefined ? {} : { loop }) },
      });
      expect(routing.edges.success).toBe("active");
      expect(routing.edges.exhausted).toBe("dead");
      expect(routing.ready).toEqual(["ok"]);
      expect(routing.skipped).toEqual(["spent"]);
    }
  });

  it("keeps both edges pending while running and kills both when the loop failed", () => {
    const running = deriveRouting(graph, { start, refine: { status: "running" } });
    expect([running.edges.success, running.edges.exhausted]).toEqual(["pending", "pending"]);
    const failed = deriveRouting(graph, {
      start,
      refine: { status: "failed", loop: { rounds: [{ done: false, outcome: "iteration_limit" }] } },
    });
    expect([failed.edges.success, failed.edges.exhausted]).toEqual(["dead", "dead"]);
  });

  it("supports explicit sourceHandle for the exhausted edge", () => {
    const routing = deriveRouting(
      {
        nodes: graph.nodes,
        edges: [
          { id: "s", from: "start", to: "refine" },
          { id: "x", from: "refine", sourceHandle: "exhausted", to: "spent" },
        ],
      },
      {
        start,
        refine: {
          status: "succeeded",
          loop: { rounds: [{ done: false, outcome: "iteration_limit" }] },
        },
      },
    );
    expect(routing.edges.x).toBe("active");
  });
});
