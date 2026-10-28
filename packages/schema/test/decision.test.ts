import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/graph.js";
import { normalizeWorkflow, parseWorkflow, validateWorkflow } from "../src/index.js";
import { clone, edges, nodes, parseOk } from "./helpers.js";

function chainWithDecision(
  overrides?: (raw: Record<string, unknown>) => void,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    schemaVersion: 1,
    id: "decision-test",
    name: "Decision Test",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: [{ name: "topic", type: "string", required: true }],
        },
        {
          id: "d1",
          type: "decision",
          name: "Decide",
          provider: "typesafe-jev",
          state: "{{ start.topic }}",
          instructions: "Is this urgent?",
          mode: { kind: "boolean" },
          onError: "fail",
        },
        {
          id: "yes",
          type: "agent",
          name: "Yes",
          cli: "fake",
          prompt: "Handle {{ start.topic }}.",
          output: { type: "object", additionalProperties: true },
          permissions: { network: false, write: ["workspace"] },
        },
        {
          id: "no",
          type: "agent",
          name: "No",
          cli: "fake",
          prompt: "Defer {{ start.topic }}.",
          output: { type: "object", additionalProperties: true },
          permissions: { network: false, write: ["workspace"] },
        },
        {
          id: "merge",
          type: "join",
          name: "Merge",
          mode: "first",
          inputs: ["yes", "no"],
          output: { type: "object", additionalProperties: true },
        },
        { id: "end", type: "end", name: "End", status: "success", result: "start.topic" },
      ],
      edges: [
        { id: "e1", from: "start", to: "d1" },
        { id: "e2", from: "d1.true", to: "yes" },
        { id: "e3", from: "d1.false", to: "no" },
        { id: "e4", from: "yes", to: "merge.yes" },
        { id: "e5", from: "no", to: "merge.no" },
        { id: "e6", from: "merge", to: "end" },
      ],
    },
  };
  if (overrides) overrides(raw);
  return raw;
}

function decisionOf(raw: Record<string, unknown>): Record<string, unknown> {
  const found = nodes(raw).find((n) => n.id === "d1");
  if (found === undefined) throw new Error("missing d1");
  return found;
}

describe("decision schema", () => {
  it("validates and normalizes a minimal boolean decision", () => {
    const raw = chainWithDecision();
    const file = parseOk(raw);
    const report = validateWorkflow(file);
    expect(report.ok).toBe(true);
    const norm = normalizeWorkflow(file);
    expect(norm.ok).toBe(true);
    if (!norm.ok) return;
    expect(norm.value.graph.nodes.find((n) => n.id === "d1")).toMatchObject({
      type: "decision",
      provider: "typesafe-jev",
      onError: "fail",
    });
  });

  it("defaults a missing onError to fail", () => {
    const raw = chainWithDecision((r) => {
      delete decisionOf(r).onError;
    });
    const file = parseOk(raw);
    expect(validateWorkflow(file).ok).toBe(true);
    const norm = normalizeWorkflow(file);
    expect(norm.ok).toBe(true);
    if (!norm.ok) return;
    expect(norm.value.graph.nodes.find((n) => n.id === "d1")).toMatchObject({
      type: "decision",
      onError: "fail",
    });
  });

  it("rejects an unknown provider", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).provider = "acme-brain";
    });
    expect(parseWorkflow(raw).ok).toBe(false);
  });

  it("rejects a bad model override pattern", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).model = "-bad";
    });
    const report = validateWorkflow(parseOk(raw));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "E_DECISION_MODEL")).toBe(true);
  });

  it("accepts a valid model override", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).model = "jev-latest";
    });
    expect(validateWorkflow(parseOk(raw)).ok).toBe(true);
  });

  it("rejects empty instructions and >4000 chars", () => {
    const empty = chainWithDecision((r) => {
      decisionOf(r).instructions = "";
    });
    expect(
      validateWorkflow(parseOk(empty)).errors.some((e) => e.code === "E_DECISION_INSTRUCTIONS"),
    ).toBe(true);
    const long = chainWithDecision((r) => {
      decisionOf(r).instructions = "x".repeat(4001);
    });
    expect(
      validateWorkflow(parseOk(long)).errors.some((e) => e.code === "E_DECISION_INSTRUCTIONS"),
    ).toBe(true);
  });

  it("rejects empty state", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).state = "";
    });
    expect(validateWorkflow(parseOk(raw)).errors.some((e) => e.code === "E_DECISION_STATE")).toBe(
      true,
    );
  });

  it("rejects falseAt above trueAt", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).mode = { kind: "boolean", trueAt: 0.3, falseAt: 0.7 };
    });
    expect(
      validateWorkflow(parseOk(raw)).errors.some((e) => e.code === "E_DECISION_THRESHOLD"),
    ).toBe(true);
  });

  it("rejects duplicate choice options and options outside exactly one branch", () => {
    const dup = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "choice",
        options: [{ value: "a" }, { value: "a" }],
        branches: [{ id: "x", values: ["a"] }],
      };
    });
    expect(validateWorkflow(parseOk(dup)).errors.some((e) => e.code === "E_DECISION_OPTIONS")).toBe(
      true,
    );
    const uncovered = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "choice",
        options: [{ value: "a" }, { value: "b" }],
        branches: [{ id: "x", values: ["a"] }],
      };
    });
    expect(
      validateWorkflow(parseOk(uncovered)).errors.some(
        (e) => e.code === "E_DECISION_BRANCH_VALUES",
      ),
    ).toBe(true);
    const doubled = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "choice",
        options: [{ value: "a" }],
        branches: [
          { id: "x", values: ["a"] },
          { id: "y", values: ["a"] },
        ],
      };
    });
    expect(
      validateWorkflow(parseOk(doubled)).errors.some((e) => e.code === "E_DECISION_BRANCH_VALUES"),
    ).toBe(true);
  });

  it("rejects reserved __proto__/constructor/prototype names", () => {
    // F9: these collide with Object.prototype members in plain-object maps.
    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      const option = chainWithDecision((r) => {
        decisionOf(r).mode = {
          kind: "choice",
          options: [{ value: "a" }, { value: reserved }],
          branches: [
            { id: "x", values: ["a"] },
            { id: "y", values: [reserved] },
          ],
        };
      });
      expect(
        validateWorkflow(parseOk(option)).errors.some((e) => e.code === "E_DECISION_OPTIONS"),
      ).toBe(true);
      const level = chainWithDecision((r) => {
        decisionOf(r).mode = {
          kind: "score",
          levels: [{ label: "low" }, { label: reserved }],
          bands: [
            { id: "top", atLeast: 1 },
            { id: "floor", atLeast: null },
          ],
        };
      });
      expect(
        validateWorkflow(parseOk(level)).errors.some((e) => e.code === "E_DECISION_LEVELS"),
      ).toBe(true);
      const branch = chainWithDecision((r) => {
        decisionOf(r).mode = {
          kind: "choice",
          options: [{ value: "a" }],
          branches: [{ id: reserved, values: ["a"] }],
        };
      });
      expect(
        validateWorkflow(parseOk(branch)).errors.some((e) => e.code === "E_DECISION_BRANCH_ID"),
      ).toBe(true);
      const band = chainWithDecision((r) => {
        decisionOf(r).mode = {
          kind: "score",
          levels: [{ label: "low" }, { label: "high" }],
          bands: [
            { id: reserved, atLeast: 1 },
            { id: "floor", atLeast: null },
          ],
        };
      });
      expect(
        validateWorkflow(parseOk(band)).errors.some((e) => e.code === "E_DECISION_BRANCH_ID"),
      ).toBe(true);
    }
  });

  it("rejects uncertain as a branch id", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "choice",
        options: [{ value: "a" }],
        branches: [{ id: "uncertain", values: ["a"] }],
      };
    });
    expect(
      validateWorkflow(parseOk(raw)).errors.some((e) => e.code === "E_DECISION_BRANCH_ID"),
    ).toBe(true);
  });

  it("rejects score bands that are not strictly decreasing with a null floor last", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "score",
        levels: [{ label: "low" }, { label: "high" }],
        bands: [
          { id: "top", atLeast: 1 },
          { id: "mid", atLeast: 1 },
          { id: "floor", atLeast: null },
        ],
      };
    });
    expect(validateWorkflow(parseOk(raw)).errors.some((e) => e.code === "E_DECISION_BANDS")).toBe(
      true,
    );
    const noFloor = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "score",
        levels: [{ label: "low" }, { label: "high" }],
        bands: [{ id: "top", atLeast: 1 }],
      };
    });
    expect(
      validateWorkflow(parseOk(noFloor)).errors.some((e) => e.code === "E_DECISION_BANDS"),
    ).toBe(true);
  });

  it("rejects out-of-range minConfidence", () => {
    const raw = chainWithDecision((r) => {
      decisionOf(r).mode = {
        kind: "choice",
        options: [{ value: "a" }],
        branches: [{ id: "x", values: ["a"] }],
        minConfidence: 2,
      };
    });
    expect(
      validateWorkflow(parseOk(raw)).errors.some((e) => e.code === "E_DECISION_CONFIDENCE"),
    ).toBe(true);
  });

  it("requires decision source edges to name a handle", () => {
    const raw = chainWithDecision((r) => {
      (edges(r)[1] as Record<string, unknown>).from = "d1";
    });
    const report = validateWorkflow(parseOk(clone(raw)));
    expect(report.errors.some((e) => e.code === "E_EDGE_HANDLE")).toBe(true);
  });

  it("rejects unknown decision handles", () => {
    const raw = chainWithDecision((r) => {
      (edges(r)[1] as Record<string, unknown>).from = "d1.bogus";
    });
    const report = validateWorkflow(parseOk(clone(raw)));
    expect(report.errors.some((e) => e.code === "E_EDGE_BRANCH")).toBe(true);
  });

  it("keeps handle errors on non-gate/approval/decision sources", () => {
    const raw = chainWithDecision((r) => {
      (edges(r)[3] as Record<string, unknown>).from = "yes.bogus";
    });
    const report = validateWorkflow(parseOk(clone(raw)));
    expect(report.errors.some((e) => e.code === "E_EDGE_HANDLE")).toBe(true);
  });

  it("analyzeGraph accepts decision handles including uncertain", () => {
    const raw = chainWithDecision((r) => {
      (edges(r)[1] as Record<string, unknown>).from = "d1.uncertain";
    });
    const { issues } = analyzeGraph(parseOk(raw).graph);
    expect(issues.filter((e) => e.code === "E_EDGE_BRANCH" || e.code === "E_EDGE_HANDLE")).toEqual(
      [],
    );
  });
});
