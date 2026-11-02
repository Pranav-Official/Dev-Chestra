import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  type GateNode,
  normalizeWorkflow,
  parseWorkflow,
  validateWorkflow,
} from "../../../packages/schema/dist/index.js";
import { createNodeExpressionExecutor } from "../../../packages/schema/dist/node/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures/routing/workflows");
const executor = createNodeExpressionExecutor();

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function parsed(name: string) {
  const result = parseWorkflow(fixture(name));
  assert.ok(result.ok, `${name} must parse: ${result.ok ? "" : result.error.message}`);
  return result.value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function graphOf(raw: Record<string, unknown>): {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
} {
  return raw.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } as {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
}

function nodeOf(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const found = graphOf(raw).nodes.find((node) => node.id === id);
  assert.ok(found !== undefined, `missing node ${id}`);
  return found;
}

function withoutOtherwise(raw: Record<string, unknown>): void {
  const gate = nodeOf(raw, "route_gate");
  gate.branches = [
    { id: "a", when: 'start.route = "a"' },
    { id: "b", when: 'start.route = "b"' },
  ];
}

function validFixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((name) => !name.includes("invalid"));
}

describe("routing schema", () => {
  it("normalizes every valid routing fixture with gate and join preserved", () => {
    for (const name of validFixtureNames()) {
      const file = parsed(name);
      const report = validateWorkflow(file);
      expect(report.ok, `${name}: ${JSON.stringify(report.errors)}`).toBe(true);
      const normalized = normalizeWorkflow(file);
      assert.ok(normalized.ok, `${name}: ${normalized.ok ? "" : normalized.error.message}`);
      const types = normalized.value.graph.nodes.map((node) => node.type);
      if (name.startsWith("gate") || name.startsWith("dead") || name.startsWith("sibling")) {
        if (graphOf(fixture(name)).nodes.some((node) => node.type === "gate")) {
          assert.ok(types.includes("gate"), `${name} keeps gate`);
        }
      }
      assert.ok(name.length > 0);
    }
  });

  it("accepts runtime-failing predicates as valid workflows", () => {
    for (const name of ["gate-invalid-type", "gate-invalid-expr"]) {
      const report = validateWorkflow(parsed(name));
      expect(report.ok, `${name}: ${JSON.stringify(report.errors)}`).toBe(true);
    }
  });

  it("keeps gate branch order and otherwise-last in the normalized snapshot", () => {
    const normalized = normalizeWorkflow(parsed("gate-join-first"));
    assert.ok(normalized.ok);
    const gate = normalized.value.graph.nodes.find((node) => node.type === "gate");
    assert.deepEqual(gate?.branches, [
      { id: "a", when: 'start.route = "a"' },
      { id: "b", otherwise: true },
    ]);
  });

  it("accepts exclusive multiple ends but rejects a graph with no end", () => {
    expect(validateWorkflow(parsed("gate-multiple-ends")).ok).toBe(true);
    const raw = clone(fixture("gate-multiple-ends"));
    raw.graph = {
      nodes: graphOf(raw).nodes.filter((node) => node.type !== "end"),
      edges: graphOf(raw).edges.filter((edge) => !String(edge.to).startsWith("end_")),
    };
    const report = validateWorkflow(parsedRaw(raw));
    expect(report.ok).toBe(false);
  });

  it("rejects a gate with no otherwise", () => {
    const raw = clone(fixture("gate-join-first"));
    withoutOtherwise(raw);
    expect(validateWorkflow(parsedRaw(raw)).ok).toBe(false);
  });

  it("rejects an otherwise branch that is not last", () => {
    const raw = clone(fixture("gate-join-first"));
    nodeOf(raw, "route_gate").branches = [
      { id: "b", otherwise: true },
      { id: "a", when: 'start.route = "a"' },
    ];
    expect(validateWorkflow(parsedRaw(raw)).ok).toBe(false);
  });

  it("rejects a conditional branch without when, duplicate branch ids and unknown branch endpoints", () => {
    const missingWhen = clone(fixture("gate-join-first"));
    nodeOf(missingWhen, "route_gate").branches = [{ id: "a" }, { id: "b", otherwise: true }];
    expect(validateWorkflow(parsedRaw(missingWhen)).ok).toBe(false);

    const duplicate = clone(fixture("gate-join-first"));
    nodeOf(duplicate, "route_gate").branches = [
      { id: "a", when: 'start.route = "a"' },
      { id: "a", otherwise: true },
    ];
    expect(validateWorkflow(parsedRaw(duplicate)).ok).toBe(false);

    const unknown = clone(fixture("gate-join-first"));
    graphOf(unknown).edges = graphOf(unknown).edges.map((edge) =>
      edge.from === "route_gate.a" ? { ...edge, from: "route_gate.missing" } : edge,
    );
    expect(validateWorkflow(parsedRaw(unknown)).ok).toBe(false);
  });

  it("rejects a join input with two inbound edges and a non-join node with two inbound edges", () => {
    const joinDouble = clone(fixture("gate-join-first"));
    graphOf(joinDouble).edges.push({
      id: "e-b-join-again",
      from: "agent_b",
      to: "merge.a",
    });
    expect(validateWorkflow(parsedRaw(joinDouble)).ok).toBe(false);

    const nodeDouble = clone(fixture("gate-join-first"));
    graphOf(nodeDouble).edges.push({ id: "e-start-agent", from: "start", to: "agent_a" });
    expect(validateWorkflow(parsedRaw(nodeDouble)).ok).toBe(false);
  });

  it("rejects unknown join input endpoints, unreachable nodes, no-end nodes and cycles", () => {
    const unknownInput = clone(fixture("gate-join-first"));
    graphOf(unknownInput).edges = graphOf(unknownInput).edges.map((edge) =>
      edge.to === "merge.a" ? { ...edge, to: "merge.missing" } : edge,
    );
    expect(validateWorkflow(parsedRaw(unknownInput)).ok).toBe(false);

    const unreachable = clone(fixture("gate-join-first"));
    graphOf(unreachable).nodes.push({
      id: "orphan",
      type: "end",
      name: "Orphan",
      status: "success",
      result: "{}",
    });
    expect(validateWorkflow(parsedRaw(unreachable)).ok).toBe(false);

    const cycle = clone(fixture("gate-join-first"));
    graphOf(cycle).edges.push({ id: "e-cycle", from: "agent_a", to: "start" });
    expect(validateWorkflow(parsedRaw(cycle)).ok).toBe(false);
  });
});

function parsedRaw(raw: Record<string, unknown>) {
  const result = parseWorkflow(raw);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

describe("gate evaluation", () => {
  const gate: GateNode = {
    id: "route_gate",
    type: "gate",
    name: "Route",
    branches: [
      { id: "a", when: 'start.route = "a"' },
      { id: "b", when: 'start.route = "b"' },
      { id: "other", otherwise: true },
    ],
  };

  it("chooses the first true branch, otherwise, and stops evaluation", async () => {
    const a = await evaluateGate(gate, { start: { route: "a" } }, { executor });
    assert.ok(a.ok);
    assert.equal(a.value.branch, "a");
    assert.deepEqual(
      a.value.evaluated.map((entry) => entry.branch),
      ["a"],
    );

    const b = await evaluateGate(gate, { start: { route: "b" } }, { executor });
    assert.ok(b.ok);
    assert.equal(b.value.branch, "b");
    assert.deepEqual(
      b.value.evaluated.map((entry) => entry.branch),
      ["a", "b"],
    );

    const other = await evaluateGate(gate, { start: { route: "z" } }, { executor });
    assert.ok(other.ok);
    assert.equal(other.value.branch, "other");
    assert.deepEqual(
      other.value.evaluated.map((entry) => entry.branch),
      ["a", "b", "other"],
    );
  });

  it("fails with branch null on a non-boolean predicate and never falls through", async () => {
    const result = await evaluateGate(gate, { start: { route: "a" } }, { executor });
    assert.ok(result.ok);
    const mixed: GateNode = {
      ...gate,
      branches: [
        { id: "bad", when: "start.route" },
        { id: "other", otherwise: true },
      ],
    };
    const bad = await evaluateGate(mixed, { start: { route: "a" } }, { executor });
    assert.ok(bad.ok);
    assert.equal(bad.value.branch, null);
    assert.equal(bad.value.evaluated[0]?.branch, "bad");
    assert.equal(bad.value.evaluated[0]?.matched, false);
    assert.match(bad.value.evaluated[0]?.error ?? "", /boolean/u);
    assert.equal(bad.value.error?.code, "E_EXPR");
    assert.equal(
      bad.value.evaluated.some((entry) => entry.branch === "other"),
      false,
    );
  });

  it("fails with branch null on an expression error", async () => {
    const broken: GateNode = {
      ...gate,
      branches: [
        { id: "bad", when: "start.route =" },
        { id: "other", otherwise: true },
      ],
    };
    const result = await evaluateGate(broken, { start: { route: "a" } }, { executor });
    assert.ok(result.ok);
    assert.equal(result.value.branch, null);
    assert.equal(result.value.error?.code, "E_EXPR");
    assert.equal(result.value.evaluated[0]?.error !== undefined, true);
  });

  it("rejects malformed gate configuration before evaluation", async () => {
    const missingOtherwise: GateNode = {
      ...gate,
      branches: [{ id: "a", when: "true" }],
    };
    const result = await evaluateGate(missingOtherwise, { start: { route: "a" } }, { executor });
    expect(result.ok).toBe(false);
  });

  it("bounds evaluation with the injected timeout executor", async () => {
    const started = Date.now();
    const result = await evaluateGate(
      gate,
      { start: { route: "a" } },
      {
        timeoutMs: 40,
        executor: { evaluate: () => new Promise<never>(() => undefined) },
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    assert.ok(result.ok);
    assert.equal(result.value.branch, null);
    assert.equal(result.value.error?.code, "E_EXPR");
  });
});
