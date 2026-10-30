import type { ForEachNode, WorkflowFile, WorkflowNode } from "@devchestra/schema";
import { catalogForField } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import { buildEdges, connectionEndpoints } from "../src/editor/canvas/EditorCanvas.js";
import { handleSignature, subtitle } from "../src/editor/canvas/nodes.js";
import { NodePalette } from "../src/editor/canvas/Palette.js";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import { checkConnection } from "../src/editor/model/routing.js";

const call = () =>
  ({ ...createDefaultNode("workflow", []), workflowId: "resume" }) as Extract<
    WorkflowNode,
    { type: "workflow" }
  >;
function file(): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "batch",
    name: "Batch",
    graph: {
      nodes: [createDefaultNode("start", []), call(), createDefaultNode("end", [])],
      edges: [
        { id: "a", from: "start", to: "workflow" },
        { id: "b", from: "workflow", to: "end" },
      ],
    },
  };
}
afterEach(() => vi.restoreAllMocks());
function Harness({ initial }: { initial: WorkflowNode }) {
  const [node, setNode] = useState(initial);
  return (
    <>
      <Inspector
        node={node}
        graph={file().graph}
        issues={[]}
        onPatch={(_, patch) => setNode((previous) => ({ ...previous, ...patch }) as WorkflowNode)}
      />
      <pre data-testid="saved-node">{JSON.stringify(node)}</pre>
    </>
  );
}

describe("collection and workflow editor nodes", () => {
  it("offers both nodes in Add node and creates useful defaults", () => {
    const add = vi.fn();
    render(<NodePalette file={file()} onAdd={add} />);
    fireEvent.click(screen.getByTestId("palette-toggle"));
    expect(screen.getByTestId("palette-add-foreach")).toHaveTextContent("For each");
    fireEvent.click(screen.getByTestId("palette-add-workflow"));
    expect(add).toHaveBeenCalledWith("workflow");
    const each = createDefaultNode("foreach", []) as ForEachNode;
    expect(each.source).toEqual({ kind: "expression", expression: "[]" });
    expect(each.body.nodes.map((node) => node.type)).toEqual(["start", "end"]);
    expect(subtitle(each)).toContain("sequential");
    expect(handleSignature(call())).toBe("workflow:workflow");
  });
  it("round-trips success/failed connections and rejects arbitrary handles", () => {
    const document = file();
    document.graph.nodes.push({ ...createDefaultNode("end", document.graph.nodes), id: "failed" });
    document.graph.edges.push({ id: "c", from: "workflow.failed", to: "failed" });
    expect(buildEdges(document, null).find((edge) => edge.id === "c")?.sourceHandle).toBe(
      "out:failed",
    );
    expect(
      connectionEndpoints(document, {
        source: "workflow",
        sourceHandle: "out:failed",
        target: "failed",
        targetHandle: "in",
      }),
    ).toEqual({ source: "workflow.failed", target: "failed" });
    const unwired = {
      ...document,
      graph: { ...document.graph, edges: document.graph.edges.filter((edge) => edge.id !== "c") },
    };
    expect(checkConnection(unwired, { source: "workflow.failed", target: "failed" }).ok).toBe(true);
    expect(checkConnection(unwired, { source: "workflow.random", target: "failed" }).ok).toBe(
      false,
    );
  });
  it("edits collection source and failure policy without starting a run", () => {
    render(<Harness initial={createDefaultNode("foreach", [])} />);
    fireEvent.change(screen.getByLabelText("Items source"), { target: { value: "csv" } });
    fireEvent.change(screen.getByTestId("inspector-foreach-source"), {
      target: { value: "jobs.csv" },
    });
    fireEvent.change(screen.getByLabelText("If an item fails"), { target: { value: "continue" } });
    expect(JSON.parse(screen.getByTestId("saved-node").textContent ?? "{}")).toMatchObject({
      source: { kind: "csv", path: "jobs.csv" },
      onItemFailure: "continue",
    });
  });
  it("keeps for-each body edits local and hides unsupported direct nesting", async () => {
    const patch = vi.fn();
    render(
      <Inspector
        node={createDefaultNode("foreach", [])}
        graph={file().graph}
        issues={[]}
        onPatch={patch}
      />,
    );
    fireEvent.click(screen.getByTestId("foreach-body-open"));
    await waitFor(() => expect(screen.getByTestId("foreach-body-dialog")).toHaveAttribute("open"));
    fireEvent.click(screen.getByTestId("palette-toggle"));
    expect(screen.queryByTestId("palette-add-loop")).toBeNull();
    expect(screen.queryByTestId("palette-add-foreach")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-add-workflow"));
    expect(screen.getByTestId("foreach-body-dirty")).toHaveTextContent("Unapplied");
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("foreach-body-cancel"));
    expect(patch).not.toHaveBeenCalled();
  });
  it("edits workflow input mappings as expressions", () => {
    render(<Harness initial={{ ...call(), inputs: { job_description: "start.topic" } }} />);
    const field = screen.getByTestId("inspector-workflow-input-job_description");
    fireEvent.change(field, { target: { value: "foreach.item.job_description" } });
    expect(
      JSON.parse(screen.getByTestId("saved-node").textContent ?? "{}").inputs.job_description,
    ).toBe("foreach.item.job_description");
  });
  it("loads target workflow parameters and offers required mappings", async () => {
    vi.spyOn(workflowApi, "list").mockResolvedValue({
      items: [
        {
          id: "resume",
          name: "Resume",
          description: null,
          relativeFile: ".devchestra/workflows/resume.json",
          etag: "a".repeat(64),
          updatedAt: 0,
        },
      ],
      nextCursor: null,
    });
    const target = {
      ...file(),
      graph: {
        nodes: [
          {
            ...createDefaultNode("start", []),
            params: [{ name: "job_description", type: "string", required: true }],
          },
        ],
        edges: [],
      },
    } as WorkflowFile;
    vi.spyOn(workflowApi, "get").mockResolvedValue({
      workflow: target,
      text: "{}",
      etag: "a".repeat(64),
      relativeFile: ".devchestra/workflows/resume.json",
      validation: {} as never,
    });
    render(<Inspector node={call()} projectId="project" issues={[]} onPatch={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByTestId("inspector-workflow-input-job_description")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("inspector-workflow-id").tagName).toBe("SELECT");
  });
  it("discovers the current item and mapped child results", () => {
    const each = createDefaultNode("foreach", []) as ForEachNode;
    each.body.nodes.splice(1, 0, call());
    each.body.edges = [
      { id: "a", from: "start", to: "workflow" },
      { id: "b", from: "workflow", to: "done" },
    ];
    const parent = {
      nodes: [createDefaultNode("start", []), each],
      edges: [{ id: "p", from: "start", to: each.id }],
    };
    const catalog = catalogForField({
      parentGraph: parent,
      draft: each.body,
      foreachId: each.id,
      nodeId: "workflow",
      field: "inputs.job_description",
    });
    const refs = catalog.flatMap((entry) => [
      entry.wholeRef.expressionRef,
      ...entry.properties.map((prop) => prop.expressionRef),
    ]);
    expect(refs).toEqual(
      expect.arrayContaining(["foreach.item", "foreach.index", "foreach.number", "foreach.total"]),
    );
    expect(refs).not.toContain("foreach.index0based");
    expect(refs).not.toContain("foreach.number1based");
  });
});
