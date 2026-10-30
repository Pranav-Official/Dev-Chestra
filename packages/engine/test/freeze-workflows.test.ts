import { DevChestraError, err, ok } from "@devchestra/core";
import { describe, expect, it, vi } from "vitest";
import { freezeWorkflowBundle } from "../src/freeze.js";

function workflow(id: string, calls: string[] = []) {
  const nodes = [
    { id: "start", type: "start", name: "Start", params: [] },
    ...calls.map((workflowId, index) => ({
      id: `call${index}`,
      type: "workflow",
      name: "Call",
      workflowId,
      inputs: {},
    })),
    { id: "end", type: "end", name: "End", status: "success", result: "{}" },
  ];
  return {
    schemaVersion: 1,
    id,
    name: id,
    graph: {
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        id: `e${index}`,
        from: nodes[index]?.id ?? "start",
        to: node.id,
      })),
    },
  };
}
function resolver(definitions: Record<string, unknown>) {
  return {
    resolve: vi.fn(async (_projectId: string, id: string) =>
      Object.hasOwn(definitions, id)
        ? ok({
            id,
            normalized: definitions[id],
            hash: "hash",
            text: JSON.stringify(definitions[id]),
          })
        : err(new DevChestraError("E_NOT_FOUND", `Missing ${id}`)),
    ),
  };
}

describe("workflow bundle preflight", () => {
  it("allows shared DAGs and reads each definition once", async () => {
    const reader = resolver({ a: workflow("a", ["c"]), b: workflow("b", ["a"]), c: workflow("c") });
    const result = await freezeWorkflowBundle({
      projectId: "p",
      rootWorkflowId: "root",
      rootSnapshot: workflow("root", ["a", "b"]),
      resolver: reader,
    });
    expect(Object.keys(result.bundle).sort()).toEqual(["a", "b", "c"]);
    expect(reader.resolve).toHaveBeenCalledTimes(3);
  });
  it("rejects cycles before execution", async () => {
    const reader = resolver({ a: workflow("a", ["b"]), b: workflow("b", ["a"]) });
    await expect(
      freezeWorkflowBundle({
        projectId: "p",
        rootWorkflowId: "root",
        rootSnapshot: workflow("root", ["a"]),
        resolver: reader,
      }),
    ).rejects.toThrow(/cycle/);
  });
  it("checks depth along reused paths, not just the first visitation", async () => {
    const definitions: Record<string, unknown> = { long: workflow("long", ["n0"]) };
    for (let i = 0; i < 8; i++)
      definitions[`n${i}`] = workflow(`n${i}`, i < 7 ? [`n${i + 1}`] : []);
    await expect(
      freezeWorkflowBundle({
        projectId: "p",
        rootWorkflowId: "root",
        rootSnapshot: workflow("root", ["n0", "long"]),
        resolver: resolver(definitions),
      }),
    ).rejects.toThrow(/depth/);
  });
  it("handles valid workflow IDs that match Object prototype names", async () => {
    const reader = resolver({ constructor: workflow("constructor") });
    const result = await freezeWorkflowBundle({
      projectId: "p",
      rootWorkflowId: "root",
      rootSnapshot: workflow("root", ["constructor"]),
      resolver: reader,
    });
    expect(Object.hasOwn(result.bundle, "constructor")).toBe(true);
    expect(reader.resolve).toHaveBeenCalledTimes(1);
  });
});
