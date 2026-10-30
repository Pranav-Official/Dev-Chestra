import { describe, expect, it } from "vitest";
import {
  allWorkflowNodes,
  catalogForField,
  declaredOutputSchema,
  foreachEnvelopeSchema,
  nodeAtPath,
  normalizeWorkflow,
  parseWorkflow,
  validateChildWorkflowNode,
  validateForEachNode,
  validateWorkflow,
  workflowEnvelopeSchema,
  workflowNodes,
} from "../src/index.js";
import { clone, parseOk } from "./helpers.js";

function bodyAgent(id: string): Record<string, unknown> {
  return {
    id,
    type: "agent",
    name: id,
    cli: "fake",
    prompt: "Do {{ foreach.item }}.",
    output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
  };
}

function foreachBody(extraNodes: Record<string, unknown>[] = []) {
  return {
    nodes: [
      { id: "start", type: "start", name: "Body inputs", params: [] },
      bodyAgent("work"),
      { id: "done", type: "end", name: "Round done", status: "success", result: "work.summary" },
      ...extraNodes,
    ],
    edges: [
      { id: "b1", from: "start", to: "work" },
      { id: "b2", from: "work", to: "done" },
    ],
  };
}

function foreachNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "each",
    type: "foreach",
    name: "Each",
    source: { kind: "expression", expression: "start.items" },
    result: "work.summary",
    output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    body: foreachBody(),
    ...extra,
  };
}

function workflowCallNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "child",
    type: "workflow",
    name: "Child",
    workflowId: "summarize-topic",
    inputs: { topic: "start.topic" },
    ...extra,
  };
}

function baseWorkflow(...nodes: Record<string, unknown>[]): Record<string, unknown> {
  const mids = nodes.map((n) => String(n.id));
  const edges: Record<string, unknown>[] = [];
  let prev = "start";
  for (const id of mids) {
    edges.push({ id: `e_${prev}_${id}`, from: prev, to: id });
    prev = id;
  }
  edges.push({ id: `e_${prev}_end`, from: prev, to: "end" });
  return {
    schemaVersion: 1,
    id: "main",
    name: "Main",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Inputs",
          params: [
            { name: "topic", type: "string", required: true },
            { name: "items", type: "string", required: false },
          ],
        },
        ...nodes,
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: mids[mids.length - 1] ?? "start",
        },
      ],
      edges,
    },
  };
}

function errorCodes(raw: Record<string, unknown>): string[] {
  return validateWorkflow(parseOk(raw)).errors.map((item) => item.code);
}

describe("foreach + workflow nodes", () => {
  it("accepts minimal foreach + workflow call and normalizes defaults", () => {
    const raw = baseWorkflow(foreachNode(), workflowCallNode({ id: "child2" }));
    const endNode = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "end",
    );
    if (endNode === undefined) throw new Error("missing end node");
    endNode.result = "child2";
    const graph = raw.graph as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    graph.edges = [
      { id: "e1", from: "start", to: "each" },
      { id: "e2", from: "each", to: "child2" },
      { id: "e3", from: "child2", to: "end" },
    ];
    const report = validateWorkflow(parseOk(raw));
    expect(report.errors.map((e) => e.code)).toEqual([]);
    const normalized = normalizeWorkflow(parseOk(raw));
    if (!normalized.ok) throw normalized.error;
    const each = normalized.value.graph.nodes.find((n) => n.id === "each") as unknown as {
      maxItems: number;
      onItemFailure: string;
      source: unknown;
    };
    expect(each.maxItems).toBe(1000);
    expect(each.onItemFailure).toBe("stop");
  });

  it("rejects maxItems outside 1..1000 and bad onItemFailure", () => {
    expect(errorCodes(baseWorkflow(foreachNode({ maxItems: 0 })))).toContain("E_FOREACH_MAX_ITEMS");
    expect(errorCodes(baseWorkflow(foreachNode({ maxItems: 1001 })))).toContain(
      "E_FOREACH_MAX_ITEMS",
    );
    // Structural enum rejects unknown values at parse (no silent default).
    expect(parseWorkflow(baseWorkflow(foreachNode({ onItemFailure: "skip" }))).ok).toBe(false);
    // Engine raw path surfaces the semantic code.
    const rawBad = validateForEachNode(foreachNode({ onItemFailure: "skip" }), {
      parentAllowed: ["start"],
    });
    expect(rawBad.filter((i) => i.severity === "error").map((i) => i.code)).toContain(
      "E_FOREACH_ON_ITEM_FAILURE",
    );
  });

  it("validates source expression scope vs csv template scope and path safety", () => {
    expect(errorCodes(baseWorkflow(foreachNode()))).not.toContain("E_EXPR_SCOPE");
    const badExpr = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    (
      (badExpr.graph as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "each",
      ) as Record<string, unknown>
    ).source = {
      kind: "expression",
      expression: "work.summary",
    };
    expect(errorCodes(badExpr)).toContain("E_EXPR_SCOPE");
    const badCsv = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    (
      (badCsv.graph as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "each",
      ) as Record<string, unknown>
    ).source = {
      kind: "csv",
      path: "../evil.csv",
    };
    expect(errorCodes(badCsv)).toContain("E_FOREACH_SOURCE");
    const csvOk = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    (
      (csvOk.graph as { nodes: Record<string, unknown>[] }).nodes.find(
        (n) => n.id === "each",
      ) as Record<string, unknown>
    ).source = {
      kind: "csv",
      path: "data/{{ start.topic }}.csv",
    };
    expect(errorCodes(csvOk)).not.toContain("E_FOREACH_SOURCE");
  });

  it("enforces body boundaries and reserved foreach id", () => {
    const reserved = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    const each = (reserved.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "each",
    ) as Record<string, unknown>;
    ((each.body as { nodes: Record<string, unknown>[] }).nodes as Record<string, unknown>[]).push({
      id: "foreach",
      type: "shell",
      name: "x",
      command: "true",
      workspace: { mode: "scratch" },
    });
    expect(errorCodes(reserved)).toContain("E_FOREACH_BODY_ID");

    const nested = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    const each2 = (nested.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "each",
    ) as Record<string, unknown>;
    (each2.body as { nodes: Record<string, unknown>[] }).nodes.push({
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
    expect(parseWorkflow(nested).ok).toBe(false);
  });

  it("allows workflow calls inside loop and foreach bodies, but no direct nesting", () => {
    const raw = clone(baseWorkflow(foreachNode())) as Record<string, unknown>;
    const each = (raw.graph as { nodes: Record<string, unknown>[] }).nodes.find(
      (n) => n.id === "each",
    ) as unknown as {
      body: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
    };
    each.body.nodes.push({
      id: "sub",
      type: "workflow",
      name: "Sub",
      workflowId: "summarize-topic",
      inputs: { topic: "start.topic" },
    } as unknown as Record<string, unknown>);
    each.body.edges.push({ id: "b3", from: "work", to: "sub" });
    each.body.edges.push({ id: "b4", from: "sub", to: "done" });
    each.body.edges = each.body.edges.filter((e) => (e as { id: string }).id !== "b2");
    // body end ancestors now include sub; result over end ancestors stays valid
    const report = validateWorkflow(parseOk(raw));
    expect(report.errors.map((e) => e.code)).not.toContain("E_NODE_TYPE");
  });

  it("validates workflow node ids and input expressions; keys checked only when resolved", () => {
    expect(
      validateChildWorkflowNode(
        { id: "c", type: "workflow", name: "C", workflowId: "Bad_ID", inputs: {} },
        { parentAllowed: ["start"] },
      ).map((i) => i.code),
    ).toContain("E_WORKFLOW_NODE_ID");
    // Unknown key without target params: no error (resolved later at run prep).
    expect(
      validateChildWorkflowNode(
        {
          id: "c",
          type: "workflow",
          name: "C",
          workflowId: "ok-id",
          inputs: { extra: "start.topic" },
        },
        { parentAllowed: ["start"] },
      ).map((i) => i.code),
    ).not.toContain("E_WORKFLOW_NODE_INPUTS");
    // Unknown key with target params: error.
    expect(
      validateChildWorkflowNode(
        {
          id: "c",
          type: "workflow",
          name: "C",
          workflowId: "ok-id",
          inputs: { extra: "start.topic" },
        },
        { parentAllowed: ["start"], targetParams: [{ name: "topic" }] },
      ).map((i) => i.code),
    ).toContain("E_WORKFLOW_NODE_INPUTS");
    // Bad scope root in inputs.
    const badScope = validateChildWorkflowNode(
      { id: "c", type: "workflow", name: "C", workflowId: "ok-id", inputs: { topic: "work.x" } },
      { parentAllowed: ["start"] },
    );
    expect(badScope.map((i) => i.code)).toContain("E_EXPR_SCOPE");
  });

  it("exposes strict envelopes and raw discovery fallback", () => {
    const perItem = { type: "object", properties: { s: { type: "string" } } } as never;
    expect(foreachEnvelopeSchema(perItem as never)).toMatchObject({
      required: ["total", "processed", "succeeded", "failed", "rejected", "resultsRef"],
    });
    expect(workflowEnvelopeSchema(perItem as never)).toMatchObject({
      required: ["childRunId", "status", "result"],
    });
    // Untyped workflow result -> whole unknown, no invented properties.
    const untyped = { id: "c", type: "workflow", name: "C", workflowId: "x", inputs: {} } as never;
    expect(declaredOutputSchema(untyped as never)).toBeNull();
    const typed = {
      id: "c",
      type: "workflow",
      name: "C",
      workflowId: "x",
      inputs: {},
      output: { type: "object", properties: { s: { type: "string" } } },
    } as never;
    expect(declaredOutputSchema(typed as never)).toMatchObject({ type: "object" });
  });

  it("traverses foreach bodies and resolves bracket index paths", () => {
    const file = parseOk(baseWorkflow(foreachNode()));
    const ids = allWorkflowNodes(file.graph).map((n) => n.id);
    expect(ids).toContain("work");
    expect(ids).toContain("done");
    expect([...workflowNodes(file.graph)].length).toBe(allWorkflowNodes(file.graph).length);
    expect(nodeAtPath(file.graph, "each")?.id).toBe("each");
    expect(nodeAtPath(file.graph, "each[0]/work")?.id).toBe("work");
    expect(nodeAtPath(file.graph, "each[2]/done")?.id).toBe("done");
  });

  it("discovery foreachId mirrors loopId: body scope, real parent paths, result infers body", () => {
    const parent = parseOk(baseWorkflow(foreachNode())).graph;
    const body = (
      parent.nodes.find((n) => n.id === "each") as unknown as {
        body: import("../src/types.js").Graph;
      }
    ).body;
    // Body field: bare foreach.item insertable, parent via foreach.parent real paths.
    const catalog = catalogForField({
      parentGraph: parent,
      draft: body,
      foreachId: "each",
      nodeId: "work",
      field: "prompt",
    });
    const ns = catalog.find((c) => c.nodeId === "foreach");
    expect(ns?.properties.some((p) => p.path.join(".") === "item")).toBe(true);
    const pickerRefs = catalog
      .find((c) => c.nodeId === "foreach.parent")
      ?.properties.map((p) => p.expressionRef);
    expect(pickerRefs?.some((r) => r.startsWith("foreach.parent."))).toBe(true);
    expect(pickerRefs?.some((r) => r === "start" || r.startsWith("start."))).toBe(false);
    // Top foreach result infers body context (foreach namespace in scope).
    const topResult = catalogForField({
      parentGraph: parent,
      foreachId: "each",
      nodeId: "each",
      field: "result",
    });
    expect(topResult.some((c) => c.nodeId === "foreach")).toBe(true);
    const topSource = catalogForField({
      parentGraph: parent,
      foreachId: "each",
      nodeId: "each",
      field: "source",
    });
    expect(topSource.some((c) => c.nodeId === "foreach")).toBe(false);
  });

  it("source .failed allowed for workflow only", () => {
    const raw = {
      schemaVersion: 1,
      id: "main",
      name: "Main",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", params: [] },
          { id: "child", type: "workflow", name: "C", workflowId: "other", inputs: {} },
          { id: "ok", type: "end", name: "Ok", status: "success", result: "child" },
          { id: "bad", type: "end", name: "Bad", status: "failed", result: "child" },
        ],
        edges: [
          { id: "e1", from: "start", to: "child" },
          { id: "e2", from: "child", to: "ok" },
          { id: "e3", from: "child.failed", to: "bad" },
        ],
      },
    };
    expect(validateWorkflow(parseOk(raw)).ok).toBe(true);
    const badHandle = clone(raw) as Record<string, unknown>;
    (
      (badHandle.graph as { edges: Record<string, unknown>[] }).edges.find(
        (e) => e.id === "e3",
      ) as Record<string, unknown>
    ).from = "child.cancelled";
    expect(validateWorkflow(parseOk(badHandle)).errors.map((e) => e.code)).toContain(
      "E_EDGE_HANDLE",
    );
  });

  it("exported ForEachNode type validates via validateForEachNode with pointer", () => {
    const issues = validateForEachNode(foreachNode({ maxItems: 0 }), { pointer: "/custom" });
    expect(
      issues.some((i) => i.code === "E_FOREACH_MAX_ITEMS" && i.pointer?.startsWith("/custom")),
    ).toBe(true);
  });
});
