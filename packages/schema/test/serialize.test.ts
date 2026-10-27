import { describe, expect, it } from "vitest";
import {
  hashWorkflow,
  MAX_WORKFLOW_FILE_BYTES,
  normalizeWorkflow,
  parseWorkflowDraft,
  parseWorkflowDraftJson,
  parseWorkflowJson,
  serializeWorkflow,
  validateWorkflow,
} from "../src/index.js";
import { chainRaw, clone, edges, node, nodes, parseOk } from "./helpers.js";

function serialize(raw: Record<string, unknown>): string {
  const result = serializeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  return result.value;
}

function normalized(raw: Record<string, unknown>) {
  const result = normalizeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  return result.value;
}

describe("canonical workflow serializer", () => {
  it("is deterministic, parse-stable and preserves ui and array order", () => {
    const raw = chainRaw();
    const start = node(raw, "start");
    const startParams = start.params as Record<string, unknown>[];
    startParams.reverse();
    node(raw, "agent").ui = { y: 240, x: 40, selected: true, nested: { b: 2, a: 1 } };
    edges(raw).reverse();
    nodes(raw).reverse();

    const text = serialize(raw);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.includes("\n  ")).toBe(true);
    const reparsed = parseWorkflowJson(text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw reparsed.error;
    expect(serializeWorkflow(reparsed.value)).toEqual({ ok: true, value: text });

    const round = reparsed.value;
    expect(round.graph.nodes.map((item) => item.id)).toEqual(
      nodes(raw).map((item) => item.id as string),
    );
    expect(round.graph.edges.map((item) => item.id)).toEqual(
      edges(raw).map((item) => item.id as string),
    );
    const roundStart = round.graph.nodes.find((item) => item.id === "start");
    expect(roundStart?.type === "start" ? roundStart.params.map((item) => item.name) : []).toEqual(
      startParams.map((item) => item.name as string),
    );
    const agent = round.graph.nodes.find((item) => item.id === "agent");
    expect(agent?.ui).toEqual({ y: 240, x: 40, selected: true, nested: { b: 2, a: 1 } });
  });

  it("puts id, type and name first and sorts remaining keys", () => {
    const text = serialize(chainRaw());
    expect(text.indexOf('"id": "chain"')).toBeLessThan(text.indexOf('"name": "Chain"'));
    expect(text.indexOf('"name": "Chain"')).toBeLessThan(text.indexOf('"graph"'));
    expect(text.indexOf('"graph"')).toBeLessThan(text.indexOf('"schemaVersion"'));
    expect(text).toMatch(/\{\n {8}"id": "agent",\n {8}"type": "agent",\n {8}"name": "Agent",/u);
  });

  it("keeps layout-only edits out of the execution hash", async () => {
    const first = normalized(chainRaw());
    const moved = clone(chainRaw());
    node(moved, "agent").ui = { x: 999, y: 111 };
    node(moved, "shell").ui = { x: -4, y: 2 };
    edges(moved)[0] = { ...edges(moved)[0], ui: { route: [[1, 2]] } };
    const second = normalized(moved);
    expect(await hashWorkflow(second)).toBe(await hashWorkflow(first));
  });

  it("rejects non-JSON values and oversized files", () => {
    const nonFinite = chainRaw();
    node(nonFinite, "agent").ui = { x: Number.POSITIVE_INFINITY };
    const nonFiniteResult = serializeWorkflow(parseOk(nonFinite));
    expect(nonFiniteResult.ok).toBe(false);
    if (!nonFiniteResult.ok) expect(nonFiniteResult.error.code).toBe("E_WORKFLOW_INVALID");

    const undefinedValue = chainRaw();
    node(undefinedValue, "agent").ui = { x: undefined };
    const undefinedResult = serializeWorkflow(parseOk(undefinedValue));
    expect(undefinedResult.ok).toBe(false);

    const huge = chainRaw();
    node(huge, "agent").prompt = "x".repeat(MAX_WORKFLOW_FILE_BYTES + 1);
    const hugeResult = serializeWorkflow(parseOk(huge));
    expect(hugeResult.ok).toBe(false);
    if (!hugeResult.ok) {
      expect(hugeResult.error.details).toMatchObject({
        maxBytes: MAX_WORKFLOW_FILE_BYTES,
      });
    }
    const oversizedText = `"${"x".repeat(MAX_WORKFLOW_FILE_BYTES)}"`;
    const oversizedParse = parseWorkflowJson(oversizedText);
    expect(oversizedParse.ok).toBe(false);
    if (!oversizedParse.ok) expect(oversizedParse.error.message).toContain("byte limit");
  });

  it("preserves own __proto__ ui keys without prototype mutation", () => {
    const raw = chainRaw();
    const ui = JSON.parse('{"__proto__":{"polluted":true},"x":1}') as Record<string, unknown>;
    node(raw, "agent").ui = ui;
    const text = serialize(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(text).toContain('"__proto__"');
    expect(text).toContain('"x": 1');

    const reparsed = parseWorkflowJson(text);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(serializeWorkflow(reparsed.value)).toEqual({ ok: true, value: text });
    }
  });
});

describe("draft parse vs execution validation", () => {
  it("parses an incomplete draft but refuses to normalize it", () => {
    const draft = chainRaw();
    draft.graph = { nodes: nodes(draft).slice(0, 1), edges: [] };
    const parsed = parseWorkflowDraft(draft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;

    const report = validateWorkflow(parsed.value);
    expect(report.ok).toBe(false);
    expect(report.errors.map((item) => item.code)).toContain("E_END_COUNT");
    expect(normalizeWorkflow(parsed.value).ok).toBe(false);

    const text = serialize(draft);
    expect(parseWorkflowDraftJson(text).ok).toBe(true);
  });

  it("still rejects unknown fields at the structural boundary", () => {
    const raw = chainRaw();
    node(raw, "agent").script = "run me";
    expect(parseWorkflowDraft(raw).ok).toBe(false);
    expect(parseWorkflowJson(JSON.stringify(raw)).ok).toBe(false);
  });

  it("parses and validates without eval (strict CSP)", () => {
    const original = globalThis.Function;
    globalThis.Function = function blocked(): never {
      throw new Error("new Function is blocked by CSP");
    } as unknown as FunctionConstructor;
    try {
      const parsed = parseWorkflowDraft(chainRaw());
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(validateWorkflow(parsed.value).ok).toBe(true);
    } finally {
      globalThis.Function = original;
    }
  });

  it("enforces the managed workflow id pattern", () => {
    const upper = chainRaw();
    upper.id = "Chain";
    expect(serializeWorkflow(parseOk(upper)).ok).toBe(false);
    expect(validateWorkflow(parseOk(upper)).errors.map((item) => item.code)).toContain(
      "E_WORKFLOW_ID",
    );
  });
});
