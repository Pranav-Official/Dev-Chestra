import { describe, expect, it } from "vitest";
import {
  allWorkflowNodes,
  loopEnvelopeSchema,
  nodeAtPath,
  normalizeWorkflow,
  parseWorkflow,
  parseWorkflowJson,
  serializeWorkflow,
  validateLoopNode,
  validateWorkflow,
  workflowNodes,
} from "../src/index.js";
import { clone } from "./helpers.js";

function bodyAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "agent",
    name: id,
    cli: "fake",
    prompt: "Do {{ start.topic }}.",
    output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
    ...extra,
  };
}

function loopBody(
  extraNodes: Record<string, unknown>[] = [],
  extraEdges: Array<[string, string]> = [],
) {
  const nodes: Record<string, unknown>[] = [
    { id: "start", type: "start", name: "Body inputs", params: [] },
    bodyAgent("work"),
    { id: "done", type: "end", name: "Round done", status: "success", result: "work.summary" },
    ...extraNodes,
  ];
  const edges: Array<{ id: string; from: string; to: string }> = [
    { id: "b1", from: "start", to: "work" },
    { id: "b2", from: "work", to: "done" },
    ...extraEdges.map(([from, to], i) => ({ id: `bx${i}`, from, to })),
  ];
  return { nodes, edges };
}

function loopNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "refine",
    type: "loop",
    name: "Refine",
    mode: "repeatUntil",
    maxIterations: 5,
    initialState: '{"value":0}',
    nextState: '{"value":result.round}',
    result: '{"round":loop.iteration}',
    until: "loop.iteration >= 3",
    output: { type: "object", properties: { round: { type: "number" } }, required: ["round"] },
    body: loopBody(),
    ...extra,
  };
}

function loopWorkflow(extraLoop: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "loops",
    name: "Loops",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Inputs",
          params: [{ name: "topic", type: "string", required: true }],
        },
        loopNode(extraLoop),
        { id: "end", type: "end", name: "End", status: "success", result: "refine" },
      ],
      edges: [
        { id: "e1", from: "start", to: "refine" },
        { id: "e2", from: "refine", to: "end" },
      ],
    },
  };
}

function parseOk(raw: unknown) {
  const parsed = parseWorkflow(raw);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function errorCodes(raw: Record<string, unknown>): string[] {
  return validateWorkflow(parseOk(raw)).errors.map((item) => item.code);
}

describe("bounded repeat-until loops", () => {
  it("accepts the engine minimal snapshot shape", () => {
    const raw = {
      schemaVersion: 1,
      id: "loops",
      name: "Loops",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Inputs", params: [] },
          {
            id: "refine",
            type: "loop",
            name: "refine",
            mode: "repeatUntil",
            maxIterations: 5,
            initialState: '{"value":0}',
            nextState: '{"value":result.round}',
            result: '{"round":loop.iteration,"previous":loop.state.value}',
            until: "loop.iteration >= 3",
            output: { type: "object", additionalProperties: true },
            body: {
              nodes: [
                { id: "start", type: "start", name: "start", params: [] },
                { id: "done", type: "end", name: "done", status: "success", result: "{}" },
              ],
              edges: [{ id: "e0", from: "start", to: "done" }],
            },
          },
          { id: "end", type: "end", name: "end", status: "success", result: "refine" },
        ],
        edges: [
          { id: "e1", from: "start", to: "refine" },
          { id: "e2", from: "refine", to: "end" },
        ],
      },
    };
    const report = validateWorkflow(parseOk(raw));
    expect(report.ok).toBe(true);
    const standalone = validateLoopNode((raw.graph as never as { nodes: unknown[] }).nodes[1], {
      parentAllowed: ["start"],
    });
    expect(standalone.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects maxIterations outside 1..1000", () => {
    for (const maxIterations of [0, 1001, 2.5]) {
      const codes = errorCodes(loopWorkflow({ maxIterations }));
      expect(codes, String(maxIterations)).toContain("E_LOOP_MAX_ITERATIONS");
    }
    // Non-numbers never reach semantic validation: the structural parser rejects them.
    for (const maxIterations of ["5", Number.NaN]) {
      expect(parseWorkflow(loopWorkflow({ maxIterations: maxIterations as never })).ok).toBe(false);
    }
    expect(errorCodes(loopWorkflow({ maxIterations: 1 }))).not.toContain("E_LOOP_MAX_ITERATIONS");
    expect(errorCodes(loopWorkflow({ maxIterations: 1000 }))).not.toContain(
      "E_LOOP_MAX_ITERATIONS",
    );
  });

  it("rejects loop common fields (name/supervise/env) like every node", () => {
    const emptyName = loopWorkflow({ name: "  " });
    expect(errorCodes(emptyName)).toContain("E_NODE_NAME");
    const badSupervise = loopWorkflow({ supervise: "checkpoint" });
    expect(errorCodes(badSupervise)).toContain("E_WORKFLOW_INVALID");
    const withEnv = loopWorkflow({ env: ["HOME"] });
    expect(errorCodes(withEnv)).toContain("E_WORKFLOW_INVALID");
    // Engine raw path enforces the same via validateLoopNode.
    const rawLoop = loopNode({ name: "" });
    const standalone = validateLoopNode(rawLoop, { parentAllowed: ["start"] });
    expect(standalone.filter((i) => i.severity === "error").map((i) => i.code)).toContain(
      "E_NODE_NAME",
    );
  });

  it("rejects bad loop expressions with scope-aware errors", () => {
    expect(errorCodes(loopWorkflow({ until: "" }))).toContain("E_LOOP_UNTIL");
    expect(errorCodes(loopWorkflow({ result: "" }))).toContain("E_LOOP_RESULT");
    // until sees body ancestors + loop + start + result, not parent nodes
    const badUntil = loopWorkflow({ until: "agent.summary = 'x'" });
    expect(errorCodes(badUntil)).toContain("E_EXPR_SCOPE");
    // result sees body ancestors (not end output, not result)
    const badResult = loopWorkflow({ result: "done = 1" });
    expect(errorCodes(badResult)).toContain("E_EXPR_SCOPE");
    const resultSelf = loopWorkflow({ result: "result.round > 1" });
    expect(errorCodes(resultSelf)).toContain("E_EXPR_SCOPE");
    // nextState additionally sees result
    expect(errorCodes(loopWorkflow({ nextState: '{"v":result.round}' }))).not.toContain(
      "E_EXPR_SCOPE",
    );
    // initialState evaluates in parent scope
    expect(errorCodes(loopWorkflow({ initialState: "work.summary" }))).toContain("E_EXPR_SCOPE");
    expect(errorCodes(loopWorkflow({ initialState: "start.topic" }))).not.toContain("E_EXPR_SCOPE");
    // until sees reserved result
    expect(errorCodes(loopWorkflow({ until: "result.round > 2" }))).not.toContain("E_EXPR_SCOPE");
  });

  it("enforces body boundaries", () => {
    // two ends
    const twoEnds = loopWorkflow();
    const body = (twoEnds.graph as never as { nodes: Array<{ id: string }> }).nodes;
    void body;
    const rawTwoEnds = clone(loopWorkflow()) as Record<string, unknown>;
    const loop = (rawTwoEnds.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    const bodyGraph = loop.body as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    bodyGraph.nodes.push({
      id: "done2",
      type: "end",
      name: "Done 2",
      status: "success",
      result: "{}",
    });
    bodyGraph.edges.push({ id: "b3", from: "work", to: "done2" });
    expect(errorCodes(rawTwoEnds)).toContain("E_LOOP_BODY");

    // end status must be success
    const badEnd = clone(loopWorkflow()) as Record<string, unknown>;
    const loop2 = (badEnd.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    const done = (loop2.body as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "done",
    ) as Record<string, unknown>;
    done.status = "failed";
    expect(errorCodes(badEnd)).toContain("E_LOOP_BODY_END_STATUS");

    // nested loop rejected at parse
    const nested = clone(loopWorkflow()) as Record<string, unknown>;
    const loop3 = (nested.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (loop3.body as { nodes: Record<string, unknown>[] }).nodes.push({
      id: "inner",
      type: "loop",
      name: "Inner",
      mode: "repeatUntil",
      maxIterations: 2,
      until: "true",
      result: "{}",
      output: { type: "object" },
      body: { nodes: [], edges: [] },
    });
    const nestedParse = parseWorkflow(nested);
    expect(nestedParse.ok).toBe(false);

    // reserved body ids
    for (const reserved of ["loop", "result"]) {
      const raw = clone(loopWorkflow()) as Record<string, unknown>;
      const lp = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "refine",
      ) as Record<string, unknown>;
      (lp.body as { nodes: Record<string, unknown>[] }).nodes.push({
        id: reserved,
        type: "shell",
        name: reserved,
        command: "true",
        workspace: { mode: "scratch" },
      });
      expect(errorCodes(raw), reserved).toContain("E_LOOP_BODY_ID");
    }

    // body start params must be empty
    const rawParams = clone(loopWorkflow()) as Record<string, unknown>;
    const lp4 = (rawParams.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (
      (lp4.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "start",
      ) as Record<string, unknown>
    ).params = [{ name: "x", type: "string", required: false }];
    expect(errorCodes(rawParams)).toContain("E_LOOP_BODY_START_PARAMS");

    // worktree rejected, scratch allowed
    const rawWorktree = clone(loopWorkflow()) as Record<string, unknown>;
    const lp5 = (rawWorktree.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (
      (lp5.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown>
    ).workspace = { mode: "worktree" };
    expect(errorCodes(rawWorktree)).toContain("E_LOOP_BODY_WORKSPACE");
  });

  it("applies ordinary child rules inside bodies (permissions/limits/shell/mcp)", () => {
    // project write fails like top-level (passes parse, fails semantic validation)
    const badPerms = clone(loopWorkflow()) as Record<string, unknown>;
    const lp = (badPerms.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (
      (lp.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown>
    ).permissions = {
      network: false,
      write: ["workspace", "project"],
    };
    expect(errorCodes(badPerms)).toContain("E_WORKFLOW_INVALID");

    // bad limits fail like top-level
    const badLimits = clone(loopWorkflow()) as Record<string, unknown>;
    const lp2 = (badLimits.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (
      (lp2.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown> & { limits: unknown }
    ).limits = { timeoutMin: 9999 };
    expect(errorCodes(badLimits)).toContain("E_LIMITS");

    // empty shell command fails like top-level (routed through the body end)
    const badShell = clone(loopWorkflow()) as Record<string, unknown>;
    const lp3 = (badShell.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    const shellBody = lp3.body as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    shellBody.nodes.push({
      id: "sh",
      type: "shell",
      name: "Sh",
      command: "   ",
      workspace: { mode: "scratch" },
    });
    shellBody.edges = shellBody.edges.filter((e) => e.id !== "b2");
    shellBody.edges.push({ id: "b9", from: "work", to: "sh" });
    shellBody.edges.push({ id: "b10", from: "sh", to: "done" });
    expect(errorCodes(badShell)).toContain("E_SHELL_COMMAND");

    // bad mcpServers fail like top-level (engine raw path bypasses zod)
    const badMcp = clone(loopNode()) as Record<string, unknown>;
    (
      (badMcp.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown>
    ).mcpServers = [{ name: "devchestra", scope: "global" }];
    const mcpIssues = validateLoopNode(badMcp, { parentAllowed: new Set(["start"]) });
    expect(mcpIssues.filter((i) => i.severity === "error").map((i) => i.code)).toContain(
      "E_MCP_SERVERS",
    );
  });

  it("keeps unreferenced join warnings non-fatal and requires output when referenced", () => {
    const raw = clone(loopWorkflow()) as Record<string, unknown>;
    const lp = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    const bodyGraph = lp.body as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    bodyGraph.nodes = [
      { id: "start", type: "start", name: "Body inputs", params: [] },
      { ...bodyAgent("left"), id: "left" },
      { ...bodyAgent("right"), id: "right" },
      { id: "merge", type: "join", name: "Merge", mode: "first", inputs: ["left", "right"] },
      { id: "done", type: "end", name: "Done", status: "success", result: "left.summary" },
    ];
    // fix outputs so shapes differ
    (
      (bodyGraph.nodes.find((n) => n.id === "right") as Record<string, unknown>).output as {
        properties: Record<string, unknown>;
      }
    ).properties.note = { type: "string" };
    bodyGraph.edges = [
      { id: "b1", from: "start", to: "left" },
      { id: "b2", from: "start", to: "right" },
      { id: "b3", from: "left", to: "merge.left" },
      { id: "b4", from: "right", to: "merge.right" },
      { id: "b5", from: "merge", to: "done" },
    ];
    // merge unreferenced: warning only, workflow stays valid
    const report = validateWorkflow(parseOk(raw));
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).not.toContain("E_JOIN_OUTPUT");

    // reference merge from loop result -> output required
    (lp as Record<string, unknown>).result = "merge";
    const report2 = validateWorkflow(parseOk(raw));
    expect(report2.ok).toBe(false);
    expect(report2.errors.map((e) => e.code)).toContain("E_JOIN_OUTPUT");
  });

  it("exposes the loop envelope for parent joins", () => {
    const envelope = loopEnvelopeSchema({
      type: "object",
      properties: { round: { type: "number" } },
      required: ["round"],
    });
    expect(envelope).toMatchObject({
      type: "object",
      required: ["iterations", "outcome", "result"],
      additionalProperties: false,
    });
    expect((envelope.properties as Record<string, unknown>).outcome).toEqual({
      type: "string",
      enum: ["condition_met", "iteration_limit"],
    });
    // parent join over loop + agent with different shapes requires output
    const raw = loopWorkflow();
    const graph = raw.graph as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    graph.nodes.push({
      id: "extra",
      type: "agent",
      name: "Extra",
      cli: "fake",
      prompt: "Hi {{ start.topic }}.",
      output: { type: "object", properties: { other: { type: "string" } }, required: ["other"] },
      permissions: { network: false, write: ["workspace"] },
      workspace: { mode: "scratch" },
    });
    graph.nodes.push({
      id: "merge",
      type: "join",
      name: "Merge",
      mode: "first",
      inputs: ["looped", "single"],
    });
    graph.nodes.find((n) => n.id === "end");
    const endNode = graph.nodes.find((n) => n.id === "end") as Record<string, unknown>;
    endNode.result = "merge";
    graph.edges = [
      { id: "e1", from: "start", to: "refine" },
      { id: "e2", from: "start", to: "extra" },
      { id: "e3", from: "refine", to: "merge.looped" },
      { id: "e4", from: "extra", to: "merge.single" },
      { id: "e5", from: "merge", to: "end" },
    ];
    // rename edge from refine: loop id is refine
    const report = validateWorkflow(parseOk(raw));
    expect(report.errors.map((e) => e.code)).toContain("E_JOIN_OUTPUT");
  });

  it("normalizes bodies with defaults, strips UI and sorts", () => {
    const raw = loopWorkflow({ initialState: undefined, nextState: undefined });
    delete (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find((n) => n.id === "refine")
      ?.initialState;
    delete (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find((n) => n.id === "refine")
      ?.nextState;
    const loop = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    loop.ui = { x: 1 };
    (
      (loop.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown>
    ).ui = { x: 2 };
    const result = normalizeWorkflow(parseOk(raw));
    if (!result.ok) throw result.error;
    const normalized = result.value.graph.nodes.find((n) => n.id === "refine") as unknown as {
      initialState: string;
      nextState: string;
      output: unknown;
      body: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> };
    };
    expect(normalized.initialState).toBe("{}");
    expect(normalized.nextState).toBe("loop.state");
    expect(JSON.stringify(result.value)).not.toContain('"ui"');
    const ids = normalized.body.nodes.map((n) => n.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("serializes bodies with UI preserved and round-trips", () => {
    const raw = loopWorkflow();
    const loop = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    loop.ui = { collapsed: true };
    const text = serializeWorkflow(parseOk(raw));
    if (!text.ok) throw text.error;
    expect(text.value).toContain("refine");
    expect(text.value).toContain('"body"');
    const reparsed = parseWorkflow(JSON.parse(text.value) as unknown);
    expect(reparsed.ok).toBe(true);
  });

  it("traverses bodies and resolves round paths", () => {
    const file = parseOk(loopWorkflow());
    const ids = allWorkflowNodes(file.graph).map((n) => n.id);
    expect(ids).toContain("refine");
    expect(ids).toContain("work");
    expect(ids).toContain("done");
    expect([...workflowNodes(file.graph)].length).toBe(allWorkflowNodes(file.graph).length);
    expect(nodeAtPath(file.graph, "refine")?.id).toBe("refine");
    expect(nodeAtPath(file.graph, "refine#2/done")?.id).toBe("done");
    expect(nodeAtPath(file.graph, "refine#1/work")?.id).toBe("work");
    expect(nodeAtPath(file.graph, "missing")).toBeUndefined();
    expect(nodeAtPath(file.graph, "end/extra/deep")).toBeUndefined();
  });

  it("requires summary includes body CLIs and shells", () => {
    const raw = clone(loopWorkflow()) as Record<string, unknown>;
    const lp = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    const shellBody = lp.body as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    shellBody.nodes.push({
      id: "sh",
      type: "shell",
      name: "Sh",
      command: "echo hi",
      workspace: { mode: "scratch" },
    });
    shellBody.edges = shellBody.edges.filter((e) => e.id !== "b2");
    shellBody.edges.push({ id: "b9", from: "work", to: "sh" });
    shellBody.edges.push({ id: "b10", from: "sh", to: "done" });
    const report = validateWorkflow(parseOk(raw));
    expect(report.ok).toBe(true);
    expect(report.requires.clis).toContain("fake");
    expect(report.requires.shellCommands.map((s) => s.nodeId)).toContain("sh");
  });

  it("rejects unknown node types explicitly (schemaVersion 1 readers)", () => {
    // top-level unknown type: structural parse rejects with an explicit message
    const topRaw = clone(loopWorkflow()) as Record<string, unknown>;
    (
      (topRaw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "refine",
      ) as Record<string, unknown>
    ).type = "map";
    const topParse = parseWorkflow(topRaw);
    expect(topParse.ok).toBe(false);
    if (!topParse.ok) expect(topParse.error.message).toContain("Unsupported node type");
    // body unknown type: structural parse rejects with a body pointer
    const bodyRaw = clone(loopWorkflow()) as Record<string, unknown>;
    const lp = (bodyRaw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "refine",
    ) as Record<string, unknown>;
    (
      (lp.body as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "work",
      ) as Record<string, unknown>
    ).type = "map";
    expect(parseWorkflow(bodyRaw).ok).toBe(false);
  });

  describe("alternate exhausted output", () => {
    function withExhausted(from = "refine.exhausted"): Record<string, unknown> {
      const raw = loopWorkflow();
      const graph = raw.graph as {
        nodes: Record<string, unknown>[];
        edges: Record<string, unknown>[];
      };
      graph.nodes.push({
        id: "spent",
        type: "end",
        name: "Spent",
        status: "failed",
        result: "refine",
      });
      graph.edges.push({ id: "e3", from, to: "spent" });
      return raw;
    }

    it("accepts a plain success edge plus a refine.exhausted edge", () => {
      expect(errorCodes(withExhausted())).toEqual([]);
    });

    it("keeps legacy plain-edge workflows valid and byte-stable", () => {
      const raw = loopWorkflow();
      expect(errorCodes(raw)).toEqual([]);
      const text = serializeWorkflow(parseOk(raw));
      if (!text.ok) throw text.error;
      expect(text.value).toContain('"from": "refine"');
      expect(text.value).not.toContain("exhausted");
    });

    it("round-trips the exhausted handle through serialize and parse", () => {
      const text = serializeWorkflow(parseOk(withExhausted()));
      if (!text.ok) throw text.error;
      expect(text.value).toContain('"from": "refine.exhausted"');
      const again = parseWorkflowJson(text.value);
      if (!again.ok) throw again.error;
      expect(again.value.graph.edges.find((e) => e.id === "e3")?.from).toBe("refine.exhausted");
      expect(serializeWorkflow(again.value)).toEqual(text);
    });

    it.each(["refine.success", "refine.rejected", "refine.other", "refine.out"])(
      "rejects the arbitrary loop handle %s",
      (from) => {
        expect(errorCodes(withExhausted(from))).toContain("E_EDGE_HANDLE");
      },
    );

    it("rejects a second inbound edge into the same node from both outputs", () => {
      const raw = withExhausted();
      const graph = raw.graph as { edges: Record<string, unknown>[] };
      (graph.edges.find((e) => e.id === "e3") as Record<string, unknown>).to = "end";
      expect(errorCodes(raw)).toContain("E_CHAIN_IN");
    });
  });
});
