import { validateWorkflow, type WorkflowFile } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { subtitle } from "../src/editor/canvas/nodes.js";
import { createDefaultNode, isSupportedNodeType } from "../src/editor/model/graph.js";

function loopFile(): WorkflowFile {
  const start = createDefaultNode("start", []);
  const loop = createDefaultNode("loop", [start]);
  const end = createDefaultNode("end", [start, loop]);
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: {
      nodes: [start, loop, end],
      edges: [
        { id: "e1", from: "start", to: loop.id },
        { id: "e2", from: loop.id, to: "end" },
      ],
    },
  };
}

describe("loop editor defaults", () => {
  it("supports loop nodes with a valid default body", () => {
    expect(isSupportedNodeType("loop")).toBe(true);
    const node = createDefaultNode("loop", []);
    expect(node.type).toBe("loop");
    if (node.type !== "loop") throw new Error("expected loop");
    expect(node.mode).toBe("repeatUntil");
    expect(node.maxIterations).toBe(5);
    expect(node.body.nodes.map((n) => n.id)).toEqual(["start", "done"]);
    const start = node.body.nodes.find((n) => n.id === "start");
    const end = node.body.nodes.find((n) => n.id === "done");
    expect(start?.type).toBe("start");
    expect((start as { params?: unknown[] }).params).toEqual([]);
    expect(end?.type).toBe("end");
    expect((end as { status?: string }).status).toBe("success");
    expect(subtitle(node)).toContain("repeat");
  });

  it("validates a default loop workflow", () => {
    const report = validateWorkflow(loopFile());
    const loopErrors = report.errors.filter(
      (e) => e.nodeId === "loop" || (e.pointer ?? "").includes("/loop"),
    );
    expect(loopErrors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects nested loops in the body", () => {
    const outer = createDefaultNode("loop", []);
    if (outer.type !== "loop") throw new Error("expected loop");
    const nested = createDefaultNode("loop", outer.body.nodes);
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "Workflow",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Start", params: [] },
          { ...outer, id: "refine", body: { nodes: [nested], edges: [] } },
          { id: "end", type: "end", name: "End", status: "success", result: "{}" },
        ],
        edges: [
          { id: "e1", from: "start", to: "refine" },
          { id: "e2", from: "refine", to: "end" },
        ],
      },
    };
    const report = validateWorkflow(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "E_LOOP_NESTED")).toBe(true);
  });
});
