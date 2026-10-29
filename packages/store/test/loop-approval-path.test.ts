import type { Path } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import { hasRejectedEdge } from "../src/approval-helpers.js";

describe("loop approval rejection routing", () => {
  it("looks at the round's body rather than an outer node with the same id", () => {
    const bodyEdges: Array<{ from: string; to: string }> = [];
    const snapshot = {
      graph: {
        nodes: [{ id: "refine", type: "loop", body: { nodes: [], edges: bodyEdges } }],
        edges: [{ from: "review.rejected", to: "end" }],
      },
    };
    expect(hasRejectedEdge(snapshot, "refine#2/review" as Path)).toBe(false);
    bodyEdges.push({ from: "review.rejected", to: "done" });
    snapshot.graph.edges = [];
    expect(hasRejectedEdge(snapshot, "refine#2/review" as Path)).toBe(true);
  });

  it("rejects an unknown controller rather than reading the enclosing graph", () => {
    expect(() =>
      hasRejectedEdge(
        { graph: { nodes: [], edges: [{ from: "review.rejected" }] } },
        "missing#1/review" as Path,
      ),
    ).toThrow("controller or body is missing");
  });
});
