import { describe, expect, it } from "vitest";
import {
  availabilityFor,
  catalogForField,
  catalogWorkflow,
  declaredOutputSchema,
  isInsertableForMode,
  toExpressionRef,
  toExpressionRefFromParts,
  toTemplateRef,
} from "../src/discovery.js";
import { compileExpression, evaluate } from "../src/expression.js";
import { createNodeExpressionExecutor } from "../src/node/index.js";
import type { Graph } from "../src/types.js";

const executor = createNodeExpressionExecutor();

function graph(): Graph {
  return {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [{ name: "topic", type: "string", required: true }] },
      { id: "fetch", type: "agent", name: "Fetch", cli: "pi", prompt: "hi", output: { type: "object", properties: { title: { type: "string" }, meta: { type: "object", properties: { count: { type: "integer" } } } }, required: ["title"] }, permissions: { network: false, write: [] } },
      { id: "weird", type: "agent", name: "Weird", cli: "pi", prompt: "hi", output: { type: "object", properties: { "a.b": { type: "string" }, "x}}y": { type: "string" }, true: { type: "string" } } }, permissions: { network: false, write: [] } },
      { id: "gate", type: "gate", name: "Gate", branches: [{ id: "a", when: "true" }, { id: "b", otherwise: true }] },
      { id: "joiner", type: "join", name: "Join", mode: "all", inputs: ["a", "b"] },
      { id: "loop1", type: "loop", name: "Loop", mode: "repeatUntil", maxIterations: 3, until: "true", result: "loop.state", output: { type: "object" }, body: { nodes: [{ id: "start", type: "start", name: "Start", params: [] }, { id: "done", type: "end", name: "Done", status: "success", result: "{}" }], edges: [{ id: "e0", from: "start", to: "done" }] } },
      { id: "end", type: "end", name: "End", status: "success", result: "fetch" },
    ],
    edges: [
      { id: "e1", from: "start", to: "gate" },
      { id: "e2", from: "gate.a", to: "fetch" },
      { id: "e3", from: "gate.b", to: "weird" },
      { id: "e4", from: "fetch", to: "joiner.a" },
      { id: "e5", from: "weird", to: "joiner.b" },
      { id: "e6", from: "joiner", to: "loop1" },
      { id: "e7", from: "loop1", to: "end" },
    ],
  } as unknown as Graph;
}

function bodyGraph(): Graph {
  return {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "step", type: "agent", name: "Step", cli: "pi", prompt: "hi", output: { type: "object", properties: { v: { type: "string" } } }, permissions: { network: false, write: [] } },
      { id: "later", type: "agent", name: "Later", cli: "pi", prompt: "hi", output: { type: "object", properties: { w: { type: "string" } } }, permissions: { network: false, write: [] } },
      { id: "side", type: "agent", name: "Side", cli: "pi", prompt: "hi", output: { type: "object", properties: { s: { type: "string" } } }, permissions: { network: false, write: [] } },
      { id: "done", type: "end", name: "Done", status: "success", result: "later" },
    ],
    edges: [
      { id: "e0", from: "start", to: "step" },
      { id: "e1", from: "step", to: "later" },
      { id: "e2", from: "later", to: "done" },
    ],
  } as unknown as Graph;
}

describe("discovery catalogue", () => {
  it("exposes start params, agent properties, nested objects, and whole outputs", () => {
    const catalog = catalogWorkflow(graph(), { nodeId: "end", field: "result" });
    const start = catalog.find((c) => c.nodeId === "start");
    expect(start?.properties.some((p) => p.path.join(".") === "topic")).toBe(true);
    const fetch = catalog.find((c) => c.nodeId === "fetch");
    expect(fetch?.properties.some((p) => p.path.join(".") === "title")).toBe(true);
    expect(fetch?.properties.some((p) => p.path.join(".") === "meta.count")).toBe(true);
    expect(fetch?.wholeRef.expressionRef).toBe("fetch");
  });

  it("serializes unusual keys safely and disables }} template insertion", () => {
    expect(toExpressionRef("weird", ["a.b"])).toBe('weird."a.b"');
    expect(toExpressionRef("my-node", [])).toBe('"my-node"');
    expect(toTemplateRef("weird", ["x}}y"])).toBeNull();
  });

  it("quotes reserved literals so references stay valid paths", () => {
    expect(toExpressionRef("agent", ["true"])).toBe('agent."true"');
    expect(toExpressionRef("agent", ["false"])).toBe('agent."false"');
    expect(toExpressionRef("agent", ["null"])).toBe('agent."null"');
    for (const expr of ['agent."true"', 'agent."false"', 'agent."null"', 'weird."a.b"', '"my-node"."x y"']) {
      const compiled = compileExpression(expr);
      expect(compiled.ok).toBe(true);
      if (compiled.ok) expect(compiled.value.roots).toEqual([(expr.split(".")[0] ?? "").replace(/"/g, "")]);
    }
  });

  it("generated references compile and evaluate against fixture data", async () => {
    const catalog = catalogWorkflow(graph(), { nodeId: "end", field: "result" });
    const fetch = catalog.find((c) => c.nodeId === "fetch");
    const title = fetch?.properties.find((p) => p.path.join(".") === "title");
    expect(title).toBeDefined();
    const compiled = compileExpression(title!.expressionRef);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const result = await evaluate(compiled.value, { fetch: { title: "hello", meta: { count: 2 } } }, { executor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
    // Reserved-token property evaluates too.
    const weird = catalog.find((c) => c.nodeId === "weird");
    const reserved = weird?.properties.find((p) => p.path[0] === "true");
    expect(reserved).toBeDefined();
    const compiledReserved = compileExpression(reserved!.expressionRef);
    expect(compiledReserved.ok).toBe(true);
    if (!compiledReserved.ok) return;
    const out = await evaluate(compiledReserved.value, { weird: { true: "yes" } }, { executor });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBe("yes");
  });

  it("keeps template and expression safety separate", () => {
    const catalog = catalogWorkflow(graph(), { nodeId: "end", field: "result" });
    const weird = catalog.find((c) => c.nodeId === "weird");
    const hazardous = weird?.properties.find((p) => p.path[0] === "x}}y");
    expect(hazardous?.templateUnsafe).toBe(true);
    expect(hazardous?.expressionRef).toBe('weird."x}}y"');
    expect(isInsertableForMode(hazardous!, "expression")).toBe(true);
    expect(isInsertableForMode(hazardous!, "template")).toBe(false);
  });

  it("marks join shapes conditional and loop envelope with result/iterations", () => {
    const catalog = catalogWorkflow(graph(), { nodeId: "end", field: "result" });
    const joiner = catalog.find((c) => c.nodeId === "joiner");
    expect(joiner?.wholeRef.availability).toBe("conditional");
    const loop = catalog.find((c) => c.nodeId === "loop1");
    expect(loop?.properties.some((p) => p.path[0] === "result")).toBe(true);
    expect(loop?.properties.some((p) => p.path[0] === "iterations")).toBe(true);
  });

  it("marks gate-conditional ancestors conditional, not just joins", () => {
    const g = graph();
    // fetch/weird sit behind gate branches feeding the join: conditional at end scope.
    expect(availabilityFor(g, { nodeId: "end", field: "result" }, "fetch").availability).toBe("conditional");
  });

  it("classifies availability without inventing latest-round refs", () => {
    const g = graph();
    expect(availabilityFor(g, { nodeId: "fetch", field: "prompt" }, "weird").availability).toBe("needs-dependency");
    expect(availabilityFor(g, { nodeId: "fetch", field: "prompt" }, "fetch").availability).toBe("unavailable");
    // Descendant references are cycles, not dependencies.
    expect(availabilityFor(g, { nodeId: "fetch", field: "prompt" }, "end").availability).toBe("unavailable");
  });

  it("centralized eligibility blocks needs-dependency/unavailable for every mode", () => {
    expect(isInsertableForMode({ availability: "needs-dependency", templateUnsafe: false, insertable: true }, "template")).toBe(false);
    expect(isInsertableForMode({ availability: "needs-dependency", templateUnsafe: false, insertable: true }, "expression")).toBe(false);
    expect(isInsertableForMode({ availability: "unavailable", templateUnsafe: false, insertable: true }, "expression")).toBe(false);
    expect(isInsertableForMode({ availability: "available", templateUnsafe: false, insertable: true }, "expression")).toBe(true);
    expect(isInsertableForMode({ availability: "conditional", templateUnsafe: false, insertable: true }, "template")).toBe(true);
    expect(isInsertableForMode({ availability: "loop-scoped", templateUnsafe: false, insertable: true }, "expression")).toBe(true);
  });

  it("uses declared schemas, not runtime values", () => {
    expect(declaredOutputSchema({ id: "s", type: "shell", name: "S", command: "echo", workspace: { mode: "scratch" }, timeoutMin: 1, allowFailure: false } as never)).toMatchObject({ type: "object" });
  });

  it("exposes loop namespaces for controller fields", () => {
    const g = graph();
    const resultCatalog = catalogForField({ parentGraph: g, loopId: "loop1", nodeId: "loop1", field: "result" });
    expect(resultCatalog.some((c) => c.nodeId === "loop")).toBe(true);
    const untilCatalog = catalogForField({ parentGraph: g, loopId: "loop1", nodeId: "loop1", field: "until" });
    expect(untilCatalog.some((c) => c.nodeId === "result")).toBe(true);
    const initialCatalog = catalogForField({ parentGraph: g, loopId: "loop1", nodeId: "loop1", field: "initialState" });
    expect(initialCatalog.some((c) => c.nodeId === "result")).toBe(false);
    expect(initialCatalog.some((c) => c.nodeId === "fetch")).toBe(true);
  });

  it("body scope exposes body outputs and loop namespaces, never bare parent refs", () => {
    const g = graph();
    const draft = bodyGraph();
    const catalog = catalogForField({ parentGraph: g, draft, loopId: "loop1", nodeId: "later", field: "prompt" });
    // Body-local output is a bare insertable ref.
    const step = catalog.find((c) => c.nodeId === "step");
    expect(step?.wholeRef.availability).toBe("available");
    expect(isInsertableForMode(step!.wholeRef, "expression")).toBe(true);
    // Parent node listed but never bare-insertable.
    const fetch = catalog.find((c) => c.nodeId === "fetch");
    expect(fetch).toBeDefined();
    expect(isInsertableForMode(fetch!.wholeRef, "template")).toBe(false);
    expect(fetch!.wholeRef.insertable).toBe(false);
    // Parent arrives via loop.parent.* instead.
    const parent = catalog.find((c) => c.nodeId === "loop.parent");
    expect(parent?.properties.some((p) => p.path[0] === "fetch")).toBe(true);
    // Loop round context without the unfinished controller result.
    const loop = catalog.find((c) => c.nodeId === "loop");
    expect(loop?.properties.some((p) => p.path[0] === "iteration")).toBe(true);
    expect(loop?.properties.some((p) => p.path[0] === "maxIterations")).toBe(true);
    expect(loop?.properties.some((p) => p.path[0] === "state")).toBe(true);
    expect(loop?.properties.some((p) => p.path[0] === "result")).toBe(false);
    expect(catalog.some((c) => c.nodeId === "result")).toBe(false);
    // Downstream body nodes would create a cycle, so they stay blocked.
    const upstreamView = catalogForField({ parentGraph: g, draft, loopId: "loop1", nodeId: "step", field: "prompt" });
    const laterDownstream = upstreamView.find((c) => c.nodeId === "later");
    expect(laterDownstream).toBeDefined();
    expect(laterDownstream!.wholeRef.availability).toBe("unavailable");
    expect(isInsertableForMode(laterDownstream!.wholeRef, "expression")).toBe(false);
    // Disconnected body nodes are visible but cannot be inserted.
    const side = upstreamView.find((c) => c.nodeId === "side");
    expect(side).toBeDefined();
    expect(side!.wholeRef.availability).toBe("needs-dependency");
    expect(isInsertableForMode(side!.wholeRef, "template")).toBe(false);
    expect(isInsertableForMode(side!.wholeRef, "expression")).toBe(false);
  });

  it("multi-part roots serialize safely", () => {
    expect(toExpressionRefFromParts(["loop", "parent", "my-node", "a.b"])).toBe('loop.parent."my-node"."a.b"');
  });
});
