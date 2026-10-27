import { describe, expect, it } from "vitest";
import {
  analyzeGraph,
  analyzeJoinSources,
  assignableOutputSchemas,
  evaluateGate,
  type GateNode,
  type JoinNode,
  MAX_GATE_BRANCHES,
  normalizeWorkflow,
  SCHEMA_CAPABILITIES,
  validateWorkflow,
  type WorkflowFile,
} from "../src/index.js";
import { createNodeExpressionExecutor } from "../src/node/index.js";
import { clone, edges, fanoutRaw, node, nodes, parseOk, routingRaw } from "./helpers.js";

const executor = createNodeExpressionExecutor();

function codes(file: WorkflowFile, severity: "error" | "warning" = "error"): string[] {
  return validateWorkflow(file)[severity === "error" ? "errors" : "warnings"].map(
    (item) => item.code,
  );
}

function normalized(raw: Record<string, unknown>) {
  const result = normalizeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  return result.value;
}

function gate(raw: Record<string, unknown>): GateNode {
  return node(raw, "gate") as unknown as GateNode;
}

function join(raw: Record<string, unknown>): JoinNode {
  return node(raw, "join") as unknown as JoinNode;
}

describe("gate and join schema", () => {
  it("parses, validates, normalizes and hashes the routing example", async () => {
    const file = parseOk(routingRaw());
    const report = validateWorkflow(file);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);

    const workflow = normalized(routingRaw());
    const gateNode = workflow.graph.nodes.find((item) => item.id === "gate");
    expect(gateNode).toMatchObject({
      type: "gate",
      branches: [
        { id: "quick", when: "start.topic = 'quick'" },
        { id: "careful", when: "start.topic = 'careful'" },
        { id: "otherwise", otherwise: true },
      ],
    });
    const joinNode = workflow.graph.nodes.find((item) => item.id === "join");
    expect(joinNode).toMatchObject({ type: "join", mode: "all", inputs: ["fast", "slow"] });
    expect(SCHEMA_CAPABILITIES.nodeTypes).toEqual([
      "start",
      "agent",
      "shell",
      "gate",
      "join",
      "approval",
      "end",
    ]);
  });

  it("keeps branch order but sorts join inputs for a stable normalized hash", async () => {
    const first = normalized(routingRaw());
    const secondRaw = routingRaw();
    join(secondRaw).inputs = ["fast", "slow"];
    const second = normalized(secondRaw);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const reordered = routingRaw();
    gate(reordered).branches = [
      gate(reordered).branches[0] as never,
      { id: "otherwise", otherwise: true },
      gate(reordered).branches[1] as never,
    ];
    expect(codes(parseOk(reordered))).toContain("E_GATE_OTHERWISE");
  });

  it("rejects invalid gate branch shapes", () => {
    const cases: [string, (raw: Record<string, unknown>) => void, string][] = [
      [
        "missing otherwise",
        (raw) => {
          gate(raw).branches = [{ id: "only", when: "true" }];
        },
        "E_GATE_OTHERWISE",
      ],
      [
        "otherwise not last",
        (raw) => {
          gate(raw).branches = [
            { id: "otherwise", otherwise: true },
            { id: "later", when: "true" },
          ];
        },
        "E_GATE_OTHERWISE",
      ],
      [
        "duplicate otherwise",
        (raw) => {
          gate(raw).branches = [
            { id: "a", when: "true" },
            { id: "one", otherwise: true },
            { id: "two", otherwise: true },
          ];
        },
        "E_GATE_OTHERWISE",
      ],
      [
        "missing when",
        (raw) => {
          gate(raw).branches = [{ id: "a" }, { id: "otherwise", otherwise: true }];
        },
        "E_GATE_WHEN",
      ],
      [
        "duplicate branch",
        (raw) => {
          gate(raw).branches = [
            { id: "a", when: "true" },
            { id: "a", when: "false" },
            { id: "otherwise", otherwise: true },
          ];
        },
        "E_GATE_BRANCH_DUPLICATE",
      ],
    ];
    for (const [name, mutate, expected] of cases) {
      const raw = routingRaw();
      mutate(raw);
      expect(codes(parseOk(raw)), name).toContain(expected);
    }
  });

  it("rejects gates above the branch cap at save time", () => {
    const raw = routingRaw();
    gate(raw).branches = [
      ...Array.from({ length: MAX_GATE_BRANCHES }, (_, index) => ({
        id: `b${index}`,
        when: "false",
      })),
      { id: "otherwise", otherwise: true },
    ];
    expect(codes(parseOk(raw))).toContain("E_GATE_BRANCHES");
  });

  it("rejects invalid handles and join wiring", () => {
    const cases: [string, (raw: Record<string, unknown>) => void, string][] = [
      [
        "unknown gate branch",
        (raw) => {
          const edge = edges(raw)[1];
          if (edge !== undefined) edge.from = "gate.missing";
        },
        "E_EDGE_BRANCH",
      ],
      [
        "branch handle on non-gate",
        (raw) => {
          const edge = edges(raw)[0];
          if (edge !== undefined) edge.from = "start.some";
        },
        "E_EDGE_HANDLE",
      ],
      [
        "plain gate source",
        (raw) => {
          const edge = edges(raw)[1];
          if (edge !== undefined) edge.from = "gate";
        },
        "E_EDGE_HANDLE",
      ],
      [
        "unknown join input",
        (raw) => {
          const edge = edges(raw)[3];
          if (edge !== undefined) edge.to = "join.missing";
        },
        "E_EDGE_INPUT",
      ],
      [
        "plain join target",
        (raw) => {
          const edge = edges(raw)[3];
          if (edge !== undefined) edge.to = "join";
        },
        "E_EDGE_HANDLE",
      ],
    ];
    for (const [name, mutate, code] of cases) {
      const raw = routingRaw();
      mutate(raw);
      expect(codes(parseOk(raw)), name).toContain(code);
    }

    const missingEdge = routingRaw();
    missingEdge.graph = { nodes: nodes(missingEdge), edges: edges(missingEdge).slice(0, 4) };
    expect(codes(parseOk(missingEdge))).toContain("E_JOIN_INPUT_EDGES");
  });

  it("allows fan-out and multiple ends but rejects cycles and dangling nodes", () => {
    expect(validateWorkflow(parseOk(fanoutRaw())).ok).toBe(true);

    const multipleEnds = clone(routingRaw());
    nodes(multipleEnds).push(
      {
        id: "other_end",
        type: "end",
        name: "Other",
        status: "success",
        result: "start.topic",
      },
      {
        id: "second_gate",
        type: "gate",
        name: "Second",
        branches: [
          { id: "a", when: "true" },
          { id: "otherwise", otherwise: true },
        ],
      },
    );
    edges(multipleEnds).push(
      { id: "e20", from: "gate.otherwise", to: "second_gate" },
      { id: "e21", from: "second_gate.a", to: "other_end" },
    );
    const report = validateWorkflow(parseOk(multipleEnds));
    expect(report.errors).toEqual([]);

    const cycle = clone(fanoutRaw());
    edges(cycle).push({ id: "e6", from: "join", to: "left" });
    expect(codes(parseOk(cycle))).toContain("E_CHAIN_IN");

    const unreachable = clone(routingRaw());
    nodes(unreachable).push({
      id: "island",
      type: "shell",
      name: "Island",
      command: "true",
      workspace: { mode: "scratch" },
    });
    const unreachableCodes = codes(parseOk(unreachable));
    expect(unreachableCodes).toContain("E_UNREACHABLE");
    expect(unreachableCodes).toContain("E_NO_END");
  });

  it("rejects joins that merge a gate branch with another inbound edge", () => {
    const raw = routingRaw();
    edges(raw).push({ id: "e9", from: "start", to: "fast" });
    const found = codes(parseOk(raw));
    expect(found).toContain("E_CHAIN_IN");
    expect(found).toContain("E_GATE_INBOUND");
  });

  it("uses true ancestors, not topological siblings, for scope", () => {
    const sibling = routingRaw();
    node(sibling, "fast").prompt = "{{ slow.summary }}";
    expect(codes(parseOk(sibling))).toContain("E_EXPR_SCOPE");

    const downstream = routingRaw();
    node(downstream, "end").result = '{ "fast": fast.summary, "slow": slow.summary }';
    expect(validateWorkflow(parseOk(downstream)).errors).toEqual([]);

    const gateForward = routingRaw();
    gate(gateForward).branches = [
      { id: "quick", when: "slow.summary = 'x'" },
      { id: "otherwise", otherwise: true },
    ];
    expect(codes(parseOk(gateForward))).toContain("E_EXPR_SCOPE");
  });

  it("requires and checks join output only when a first join is referenced", () => {
    const raw = fanoutRaw();
    join(raw).output = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    expect(validateWorkflow(parseOk(raw)).errors).toEqual([]);

    const incompatible = fanoutRaw();
    join(incompatible).output = {
      type: "object",
      properties: { summary: { type: "integer" } },
      required: ["summary"],
    };
    expect(codes(parseOk(incompatible))).toContain("E_JOIN_ASSIGNABILITY");

    const different = fanoutRaw();
    node(different, "right").output = {
      type: "object",
      properties: { summary: { type: "string" }, extra: { type: "number" } },
      required: ["summary", "extra"],
    };
    expect(codes(parseOk(different))).toContain("E_JOIN_OUTPUT");
    join(different).output = {
      type: "object",
      properties: { summary: { type: "string" }, extra: { type: "number" } },
      required: ["summary"],
      additionalProperties: true,
    };
    expect(validateWorkflow(parseOk(different)).ok).toBe(true);

    const unreferenced = fanoutRaw();
    node(unreferenced, "end").result = "start.topic";
    node(unreferenced, "right").output = {
      type: "object",
      properties: { summary: { type: "integer" } },
      required: ["summary"],
    };
    expect(validateWorkflow(parseOk(unreferenced)).errors).toEqual([]);
  });

  it("validates join output against the same restricted profile", () => {
    const raw = fanoutRaw();
    join(raw).output = { type: "array", items: { type: "string" }, maxItems: 2 };
    expect(codes(parseOk(raw))).toContain("E_WORKFLOW_INVALID");
  });

  it("analyzes handles, ancestors and join sources", () => {
    const file = parseOk(routingRaw());
    const { analysis, issues } = analyzeGraph(file.graph);
    expect(issues).toEqual([]);
    expect(analysis.ancestors("join").has("gate")).toBe(true);
    expect(analysis.ancestors("fast").has("slow")).toBe(false);
    expect(analysis.descendants("gate").has("end")).toBe(true);
    expect(analysis.gateBranches("gate").map((branch) => branch.id)).toEqual([
      "quick",
      "careful",
      "otherwise",
    ]);
    expect(analysis.joinInputs("join")).toEqual(["fast", "slow"]);

    const sources = analyzeJoinSources(file.graph, join(routingRaw()));
    expect(sources).toEqual([
      expect.objectContaining({ input: "fast", nodeId: "fast", known: true }),
      expect.objectContaining({ input: "slow", nodeId: "slow", known: true }),
    ]);
  });
});

describe("evaluateGate", () => {
  const branches = [
    { id: "high", when: "start.score >= 0.8" },
    { id: "low", when: "start.score < 0.2" },
    { id: "otherwise", otherwise: true as const },
  ];

  it("returns the first true branch in order", async () => {
    const result = await evaluateGate({ branches }, { start: { score: 0.9 } }, { executor });
    expect(result).toEqual({
      ok: true,
      value: {
        branch: "high",
        evaluated: [{ branch: "high", matched: true }],
      },
    });
  });

  it("falls through false branches to otherwise", async () => {
    const result = await evaluateGate({ branches }, { start: { score: 0.5 } }, { executor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.branch).toBe("otherwise");
  });

  it("treats a missing field equality as non-matching", async () => {
    const result = await evaluateGate(
      {
        branches: [
          { id: "named", when: "start.topic = 'quick'" },
          { id: "otherwise", otherwise: true },
        ],
      },
      { start: {} },
      { executor },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.branch).toBe("otherwise");
  });

  it("fails the gate on a non-boolean result instead of falling through", async () => {
    const result = await evaluateGate(
      {
        branches: [
          { id: "string", when: "start.score" },
          { id: "otherwise", otherwise: true },
        ],
      },
      { start: { score: "yes" } },
      { executor },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBeNull();
    expect(result.value.error?.code).toBe("E_EXPR");
    expect(result.value.evaluated[0]?.error).toContain("boolean");
  });

  it("fails the gate on expression errors and stops evaluating", async () => {
    const result = await evaluateGate(
      {
        branches: [
          { id: "bad", when: "$notAllowed()" },
          { id: "otherwise", otherwise: true },
        ],
      },
      { start: {} },
      { executor },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBeNull();
    expect(result.value.error?.code).toBe("E_EXPR");
    expect(result.value.evaluated).toHaveLength(1);
  });

  it("does not evaluate later branches after a match", async () => {
    const result = await evaluateGate(
      {
        branches: [
          { id: "first", when: "true" },
          { id: "later", when: "$notAllowed()" },
          { id: "otherwise", otherwise: true },
        ],
      },
      {},
      { executor },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branch).toBe("first");
      expect(result.value.error).toBeUndefined();
    }
  });

  it("rejects malformed gates before evaluating", async () => {
    for (const gate of [
      { branches: [] },
      { branches: [{ id: "only", when: "true" }] },
      {
        branches: [
          { id: "otherwise", otherwise: true as const },
          { id: "later", when: "true" },
        ],
      },
    ]) {
      const result = await evaluateGate(gate, {}, { executor });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("E_WORKFLOW_INVALID");
    }
  });

  it("bounds branch count", async () => {
    const tooMany = Array.from({ length: MAX_GATE_BRANCHES + 1 }, (_, index) => ({
      id: `b${index}`,
      when: "false",
    }));
    tooMany.push({ id: "otherwise", when: undefined } as never);
    const result = await evaluateGate({ branches: tooMany }, {}, { executor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_WORKFLOW_INVALID");
  });

  it("applies the overall budget across branches", async () => {
    const slow = {
      async evaluate() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return false;
      },
    };
    const result = await evaluateGate(
      {
        branches: [
          { id: "a", when: "false" },
          { id: "b", when: "false" },
          { id: "otherwise", otherwise: true },
        ],
      },
      {},
      { executor: slow, overallTimeoutMs: 60 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBeNull();
    expect(result.value.error?.code).toBe("E_EXPR");
    expect(result.value.evaluated.length).toBe(2);

    const invalid = await evaluateGate({ branches }, {}, { executor, overallTimeoutMs: 2_001 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("E_WORKFLOW_INVALID");
  });

  it("does not choose otherwise or a late true result after the budget", async () => {
    const block = (value: boolean) => ({
      async evaluate() {
        const end = Date.now() + 55;
        while (Date.now() < end) {
          // Controlled boundary: blocks past the 50 ms overall budget.
        }
        return value;
      },
    });
    for (const value of [false, true]) {
      const result = await evaluateGate(
        {
          branches: [
            { id: "slow", when: "false" },
            { id: "otherwise", otherwise: true },
          ],
        },
        {},
        { executor: block(value), overallTimeoutMs: 50 },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.branch).toBeNull();
      expect(result.value.error?.code).toBe("E_EXPR");
      expect(result.value.evaluated).toHaveLength(1);
      expect(result.value.evaluated[0]).toMatchObject({ branch: "slow", matched: false });
    }
  });

  it("requires an executor in the browser-safe entry", async () => {
    const result = await evaluateGate({ branches }, { start: { score: 0.9 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBeNull();
    expect(result.value.error?.code).toBe("E_EXPR");
  });
});

describe("join assignability", () => {
  it("accepts equal, subtype, enum-subset and tighter maxItems schemas", () => {
    expect(
      assignableOutputSchemas(
        { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
        { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      ),
    ).toBe("yes");
    expect(
      assignableOutputSchemas(
        { type: "string", enum: ["a", "b"] },
        { type: "string", enum: ["a", "b", "c"] },
      ),
    ).toBe("yes");
    expect(
      assignableOutputSchemas(
        { type: "array", items: { type: "string" }, maxItems: 2 },
        { type: "array", items: { type: "string" }, maxItems: 4 },
      ),
    ).toBe("yes");
  });

  it("rejects missing required keys, wrong types, wider arrays and extra closed keys", () => {
    expect(
      assignableOutputSchemas(
        { type: "object", properties: {}, required: [] },
        { type: "object", properties: { n: { type: "string" } }, required: ["n"] },
      ),
    ).toBe("no");
    expect(
      assignableOutputSchemas(
        { type: "object", properties: { n: { type: "string" } }, required: ["n"] },
        { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      ),
    ).toBe("no");
    expect(
      assignableOutputSchemas(
        { type: "array", items: { type: "string" }, maxItems: 5 },
        { type: "array", items: { type: "string" }, maxItems: 2 },
      ),
    ).toBe("no");
    expect(
      assignableOutputSchemas(
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      ),
    ).toBe("yes");
  });

  it("returns unknown when it cannot decide", () => {
    expect(assignableOutputSchemas({}, { type: "object" })).toBe("unknown");
    expect(
      assignableOutputSchemas(
        { type: "object", additionalProperties: true },
        {
          type: "object",
          properties: { n: { type: "string" } },
          required: ["n"],
          additionalProperties: false,
        },
      ),
    ).toBe("unknown");
  });
});
