import { describe, expect, it } from "vitest";
import { analyzeWorkflowPlan } from "../src/graph-plan.js";

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});
const shell = (id: string) => node(id, "shell", { command: "true", timeoutMin: 1 });
const end = (id: string) => node(id, "end", { status: "success", result: "{}" });
const gate = (id: string, branches: unknown[]) => node(id, "gate", { branches });
const join = (id: string, mode: "first" | "all", inputs: string[]) =>
  node(id, "join", { mode, inputs });

function graph(nodes: unknown[], edges: [string, string][]): unknown {
  return {
    graph: {
      nodes,
      edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to })),
    },
  };
}

describe("analyzeWorkflowPlan", () => {
  it("accepts a gate/join DAG with multiple exclusive ends", () => {
    const plan = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          gate("route", [
            { id: "a", when: "start.kind = 'a'" },
            { id: "b", otherwise: true },
          ]),
          shell("sa"),
          shell("sb"),
          join("both", "all", ["in_a", "in_b"]),
          end("done"),
          end("other"),
        ],
        [
          ["start", "route"],
          ["route.a", "sa"],
          ["route.b", "sb"],
          ["sa", "both.in_a"],
          ["sb", "both.in_b"],
          ["both", "done"],
          ["both", "other"],
        ],
      ),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.ends.map((entry) => entry.id)).toEqual(["done", "other"]);
    expect([...plan.value.ancestorsOf("both")].sort()).toEqual(["route", "sa", "sb", "start"]);
  });

  it("rejects invalid gate ordering and shape", () => {
    for (const branches of [
      [{ id: "a", when: "true" }],
      [
        { id: "a", otherwise: true },
        { id: "b", when: "true" },
      ],
      [
        { id: "a", when: "true" },
        { id: "b", otherwise: true },
        { id: "c", otherwise: true },
      ],
      [{ id: "a" }, { id: "b", otherwise: true }],
    ]) {
      const result = analyzeWorkflowPlan(
        graph(
          [node("start", "start", { params: [] }), gate("g", branches), end("e")],
          [
            ["start", "g"],
            ["g.a", "e"],
          ],
        ),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects missing/duplicate join inputs and non-join inbound fan-in", () => {
    const missing = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          shell("a"),
          shell("b"),
          join("j", "all", ["x", "y"]),
          end("e"),
        ],
        [
          ["start", "a"],
          ["start", "b"],
          ["a", "j.x"],
          ["j", "e"],
        ],
      ),
    );
    expect(missing.ok).toBe(false);

    const fanIn = analyzeWorkflowPlan(
      graph(
        [node("start", "start", { params: [] }), shell("a"), shell("b"), end("e")],
        [
          ["start", "a"],
          ["start", "b"],
          ["a", "e"],
          ["b", "e"],
        ],
      ),
    );
    expect(fanIn.ok).toBe(false);
  });

  it("rejects unknown branch/input handles, unreachable nodes and unsupported types", () => {
    const handle = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          gate("g", [{ id: "a", otherwise: true }]),
          end("e"),
        ],
        [
          ["start", "g"],
          ["g.missing", "e"],
        ],
      ),
    );
    expect(handle.ok).toBe(false);

    const unreachable = analyzeWorkflowPlan(
      graph([node("start", "start", { params: [] }), end("e"), shell("orphan")], [["start", "e"]]),
    );
    expect(unreachable.ok).toBe(false);

    const unsupported = analyzeWorkflowPlan(
      graph(
        [node("start", "start", { params: [] }), node("m", "map", {}), end("e")],
        [
          ["start", "m"],
          ["m", "e"],
        ],
      ),
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.message).toContain("not supported");
  });

  it("uses canonical handle ids for branches and join inputs, node ids stay lowercase", () => {
    const handles = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          gate("g", [
            { id: "High", when: "true" },
            { id: "2low", otherwise: true },
          ]),
          shell("a"),
          shell("b"),
          join("j", "all", ["1in", "Input_2"]),
          end("e"),
        ],
        [
          ["start", "g"],
          ["g.High", "a"],
          ["g.2low", "b"],
          ["a", "j.1in"],
          ["b", "j.Input_2"],
          ["j", "e"],
        ],
      ),
    );
    expect(handles.ok).toBe(true);

    const badNode = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          node("Upper", "shell", { command: "true" }),
          end("e"),
        ],
        [
          ["start", "Upper"],
          ["Upper", "e"],
        ],
      ),
    );
    expect(badNode.ok).toBe(false);
  });

  it("rejects an End with an outbound edge", () => {
    const result = analyzeWorkflowPlan(
      graph(
        [node("start", "start", { params: [] }), end("e"), shell("after")],
        [
          ["start", "e"],
          ["e", "after"],
        ],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("E_CHAIN_END");
  });

  it("requires join.output when a referenced first-join has heterogeneous sources", () => {
    const nodes = [
      node("start", "start", { params: [] }),
      shell("a"),
      gate("g", [{ id: "only", otherwise: true }]),
      join("j", "first", ["x", "y"]),
      node("done", "end", { status: "success", result: '{ "j": j }' }),
    ];
    const edges: [string, string][] = [
      ["start", "a"],
      ["start", "g"],
      ["a", "j.x"],
      ["g.only", "j.y"],
      ["j", "done"],
    ];
    const missing = analyzeWorkflowPlan(graph(nodes, edges));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("declare output");

    (nodes[3] as Record<string, unknown>).output = { type: "object" };
    const declared = analyzeWorkflowPlan(graph(nodes, edges));
    expect(declared.ok).toBe(true);
  });

  it("accepts a start fan-out to two ends (conflict is a run-time check)", () => {
    const result = analyzeWorkflowPlan(
      graph(
        [node("start", "start", { params: [] }), end("one"), end("two")],
        [
          ["start", "one"],
          ["start", "two"],
        ],
      ),
    );
    expect(result.ok).toBe(true);
  });
});
