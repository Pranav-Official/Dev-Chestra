import { describe, expect, it } from "vitest";
import { deriveRouting, type RoutingExecutionState, type RoutingGraph } from "../src/index.js";

const graph: RoutingGraph = {
  nodes: [
    { id: "start", type: "start" },
    { id: "gate", type: "gate", branches: [{ id: "yes" }, { id: "no" }] },
    { id: "left", type: "agent" },
    { id: "right", type: "agent" },
    { id: "join", type: "join", mode: "all", inputs: ["a", "b"] },
    { id: "end", type: "end" },
  ],
  edges: [
    { id: "s-g", from: "start", to: "gate" },
    { id: "g-y", from: "gate.yes", to: "left" },
    { id: "g-n", from: "gate.no", to: "right" },
    { id: "l-a", from: "left", to: "join.a" },
    { id: "r-b", from: "right", to: "join.b" },
    { id: "j-e", from: "join", to: "end" },
  ],
};

function exec(
  status: RoutingExecutionState["status"],
  gateBranch?: string | null,
): RoutingExecutionState {
  return {
    status,
    ...(gateBranch === undefined ? {} : { gateDecision: { branch: gateBranch } }),
  };
}

describe("deriveRouting", () => {
  it("keeps unstarted work pending and exposes only start as ready", () => {
    const routing = deriveRouting(graph, { start: exec("succeeded") });
    expect(routing.edges["s-g"]).toBe("active");
    expect(routing.edges["g-y"]).toBe("pending");
    expect(routing.ready).toEqual(["gate"]);
    expect(routing.skipped).toEqual([]);
  });

  it("activates only the chosen gate branch and skips its exclusive sibling", () => {
    const routing = deriveRouting(graph, {
      start: exec("succeeded"),
      gate: exec("succeeded", "yes"),
    });
    expect(routing.edges["g-y"]).toBe("active");
    expect(routing.edges["g-n"]).toBe("dead");
    expect(routing.ready).toContain("left");
    expect(routing.skipped).toContain("right");
    expect(routing.edges["l-a"]).toBe("pending");
  });

  it("waits for all join inputs, mapping a dead input to skipped", () => {
    const routing = deriveRouting(graph, {
      start: exec("succeeded"),
      gate: exec("succeeded", "yes"),
      left: exec("succeeded"),
      right: exec("skipped"),
    });
    expect(routing.edges["l-a"]).toBe("active");
    expect(routing.edges["r-b"]).toBe("dead");
    expect(routing.ready).toContain("join");
    expect(routing.conflicts).toEqual([]);
  });

  it("reports a join-first conflict instead of ready", () => {
    const first: RoutingGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "join" ? { ...node, mode: "first" } : node)),
    };
    const routing = deriveRouting(first, {
      left: exec("succeeded"),
      right: exec("succeeded"),
    });
    expect(routing.conflicts).toEqual(["join"]);
    expect(routing.ready).not.toContain("join");
    expect(routing.skipped).not.toContain("join");
  });

  it("propagates a durable skip through its outgoing edges", () => {
    const routing = deriveRouting(graph, {
      start: exec("succeeded"),
      gate: exec("succeeded", "no"),
      right: exec("skipped"),
    });
    expect(routing.edges["g-y"]).toBe("dead");
    expect(routing.edges["g-n"]).toBe("active");
    expect(routing.edges["r-b"]).toBe("dead");
    expect(routing.skipped).toContain("left");
  });

  it("keeps an interrupted ancestor pending so descendants cannot be skipped", () => {
    const routing = deriveRouting(graph, {
      start: exec("succeeded"),
      gate: exec("interrupted"),
    });
    expect(routing.edges["g-y"]).toBe("pending");
    expect(routing.edges["g-n"]).toBe("pending");
    expect(routing.skipped).toEqual([]);
  });

  it("accepts explicit handles and fans out a normal node", () => {
    const fanout: RoutingGraph = {
      nodes: [
        { id: "a", type: "agent" },
        { id: "b", type: "agent" },
        { id: "c", type: "agent" },
      ],
      edges: [
        { id: "a-b", from: "a", to: "b" },
        { id: "a-c", from: "a", to: "c" },
      ],
    };
    const routing = deriveRouting(fanout, { a: exec("succeeded") });
    expect(routing.edges).toEqual({ "a-b": "active", "a-c": "active" });
    expect(routing.ready.sort()).toEqual(["b", "c"]);
  });
});
