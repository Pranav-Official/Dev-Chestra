import type { Issue, WorkflowFile } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { NodePalette } from "../src/editor/canvas/Palette.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import type { DocumentChange, EditorSelection } from "../src/editor/model/types.js";

function sample(): WorkflowFile {
  const start = createDefaultNode("start", [], { x: 0, y: 0 });
  const agent = createDefaultNode("agent", [start], { x: 208, y: 0 });
  const end = createDefaultNode("end", [start, agent], { x: 416, y: 0 });
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: {
      nodes: [start, agent, end],
      edges: [
        { id: "e1", from: start.id, to: agent.id },
        { id: "e2", from: agent.id, to: end.id },
      ],
    },
  };
}

function Harness({
  initial,
  issues = [],
  onSelection,
}: {
  initial: WorkflowFile;
  issues?: readonly Issue[];
  onSelection?: (selection: EditorSelection) => void;
}) {
  const [file, setFile] = useState(initial);
  const [selection, setSelection] = useState<EditorSelection>(null);
  return (
    <EditorCanvas
      file={file}
      selection={selection}
      issues={issues}
      onSelectionChange={(next) => {
        setSelection(next);
        onSelection?.(next);
      }}
      onChange={(next: WorkflowFile, _change: DocumentChange) => setFile(next)}
      onConnectionRejected={() => undefined}
    />
  );
}

describe("NodePalette", () => {
  it("hides Start while present but keeps End available for exclusive paths", () => {
    const onAdd = vi.fn();
    const file = sample();
    render(<NodePalette file={file} onAdd={onAdd} />);
    expect(screen.queryByTestId("palette-add-start")).toBeNull();
    expect(screen.getByTestId("palette-add-end")).toBeInTheDocument();
    expect(screen.getByTestId("palette-add-agent")).toBeInTheDocument();
    expect(screen.getByTestId("palette-add-shell")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("palette-add-agent"));
    expect(onAdd).toHaveBeenCalledWith("agent");
  });

  it("offers Start and End for a blank graph", () => {
    render(
      <NodePalette
        file={{
          schemaVersion: 1,
          id: "wf",
          name: "Blank",
          graph: { nodes: [], edges: [] },
        }}
        onAdd={() => undefined}
      />,
    );
    expect(screen.getByTestId("palette-add-start")).toBeInTheDocument();
    expect(screen.getByTestId("palette-add-end")).toBeInTheDocument();
  });
});

describe("EditorCanvas", () => {
  it("renders node badges from semantic issues without run status", async () => {
    const issue: Issue = {
      severity: "error",
      code: "E_TEST",
      message: "Agent prompt is missing.",
      nodeId: "agent",
    };
    render(<Harness initial={sample()} issues={[issue]} />);
    expect(await screen.findByTestId("ed-node-start")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("1 validation issue")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Running/)).toBeNull();
  });

  it("selects nodes with arrow keys and undo shortcuts use the page callbacks", async () => {
    const onSelection = vi.fn();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <EditorCanvas
        file={sample()}
        selection={null}
        issues={[]}
        onSelectionChange={onSelection}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );
    const canvas = screen.getByTestId("editor-canvas");
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(onSelection).toHaveBeenCalledWith({ kind: "node", nodeId: "start" });
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true, shiftKey: true });
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("removes the selected node and emits the full next file", async () => {
    const onChange = vi.fn();
    const onSelection = vi.fn();
    render(
      <EditorCanvas
        file={sample()}
        selection={{ kind: "node", nodeId: "agent" }}
        issues={[]}
        onSelectionChange={onSelection}
        onChange={onChange}
        onConnectionRejected={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("editor-canvas"), { key: "Delete" });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const next = onChange.mock.calls[0]?.[0] as WorkflowFile;
    const change = onChange.mock.calls[0]?.[1] as DocumentChange;
    expect(next.graph.nodes.map((node) => node.id)).toEqual(["start", "end"]);
    expect(next.graph.edges.map((edge) => edge.id)).toEqual([]);
    expect(change).toEqual({ layoutOnly: false, nodeId: "agent" });
    expect(onSelection).toHaveBeenCalledWith(null);
  });
});
