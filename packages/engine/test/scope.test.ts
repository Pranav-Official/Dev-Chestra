import { describe, expect, it } from "vitest";
import { buildScopeData, outputsBefore } from "../src/scope.js";

describe("ancestor-scoped data", () => {
  it("exposes start params and prior outputs only", () => {
    const scope = buildScopeData({ topic: "x" }, [
      { nodeId: "research", output: { summary: "ok" } },
    ]);
    expect(scope).toEqual({ start: { topic: "x" }, research: { summary: "ok" } });
  });

  it("adds body entry values without mutating inputs", () => {
    const params = { topic: "x" };
    const scope = buildScopeData(params, [], { item: 1, index: 0 });
    expect(scope.item).toBe(1);
    expect(params).toEqual({ topic: "x" });
  });

  it("selects only outputs before the requested node", () => {
    const outputs = { start: {}, research: { a: 1 }, report: { b: 2 } };
    expect(outputsBefore(["start", "research", "report", "end"], "report", outputs)).toEqual([
      { nodeId: "start", output: {} },
      { nodeId: "research", output: { a: 1 } },
    ]);
    expect(outputsBefore(["start", "research"], "start", outputs)).toEqual([]);
  });
});
