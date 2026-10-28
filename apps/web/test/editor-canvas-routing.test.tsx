import type { Edge, WorkflowFile, WorkflowNode } from "@devchestra/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { NodePalette } from "../src/editor/canvas/Palette.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

function routingFile(): WorkflowFile {
  const start = createDefaultNode("start", [], { x: 0, y: 0 });
  const gate = createDefaultNode("gate", [start], { x: 208, y: 0 });
  const join = createDefaultNode("join", [start, gate], { x: 416, y: 0 });
  const end = createDefaultNode("end", [start, gate, join], { x: 624, y: 0 });
  if (gate.type !== "gate" || join.type !== "join") throw new Error("missing routing nodes");
  const nodes: WorkflowNode[] = [start, gate, join, end];
  const edges: Edge[] = [
    { id: "e1", from: "start", to: "gate" },
    { id: "e2", from: "gate.branch", to: "join.input" },
    { id: "e3", from: "join", to: "end" },
  ];
  return { schemaVersion: 1, id: "routing", name: "Routing", graph: { nodes, edges } };
}

describe("routing canvas", () => {
  it("renders gate branch and join input handles from endpoint identities", () => {
    render(
      <EditorCanvas
        file={routingFile()}
        selection={null}
        issues={[]}
        onSelectionChange={() => undefined}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
      />,
    );
    expect(screen.getByTestId("ed-node-gate")).toBeInTheDocument();
    expect(screen.getByTestId("ed-gate-branches-gate")).toHaveTextContent("branch");
    expect(screen.getByTestId("ed-gate-branches-gate")).toHaveTextContent("otherwise");
    expect(screen.getByTestId("ed-handle-gate-out-branch")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-gate-out-otherwise")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-join-in-input")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-start-out")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-gate-in")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-join-out")).toBeInTheDocument();
    expect(screen.getByTestId("ed-join-inputs-join")).toHaveTextContent("input");
  });

  it("offers Gate and Join in the palette", () => {
    render(
      <NodePalette
        file={{ schemaVersion: 1, id: "blank", name: "Blank", graph: { nodes: [], edges: [] } }}
        onAdd={() => undefined}
      />,
    );
    expect(screen.getByTestId("palette-add-gate")).toHaveTextContent("Gate");
    expect(screen.getByTestId("palette-add-join")).toHaveTextContent("Join");
  });
});
