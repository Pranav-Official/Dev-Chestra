import type { StartNode, WorkflowFile } from "@devchestra/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildEdges, EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { openInspectorSection } from "../src/editor/inspector/Section.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import type { DocumentChange, EditorSelection } from "../src/editor/model/types.js";

function sample(polling?: StartNode["polling"]): WorkflowFile {
  const startBase = createDefaultNode("start", [], { x: 0, y: 160 });
  const start = { ...startBase, params: [] } as StartNode;
  if (polling !== undefined) start.polling = polling;
  const agent = createDefaultNode("agent", [start], { x: 208, y: 160 });
  const end = createDefaultNode("end", [start, agent], { x: 416, y: 160 });
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
  onSelection,
  onChange,
}: {
  initial: WorkflowFile;
  onSelection?: (selection: EditorSelection) => void;
  onChange?: (next: WorkflowFile, change: DocumentChange) => void;
}) {
  const [file, setFile] = useState(initial);
  const [selection, setSelection] = useState<EditorSelection>(null);
  return (
    <EditorCanvas
      file={file}
      selection={selection}
      issues={[]}
      onSelectionChange={(next) => {
        setSelection(next);
        onSelection?.(next);
      }}
      onChange={(next: WorkflowFile, change: DocumentChange) => {
        setFile(next);
        onChange?.(next, change);
      }}
      onConnectionRejected={() => undefined}
    />
  );
}

describe("polling probe canvas node", () => {
  it("renders no probe node or poll handle without polling", async () => {
    render(<Harness initial={sample()} />);
    expect(await screen.findByTestId("ed-node-start")).toBeInTheDocument();
    expect(screen.queryByTestId("ed-node-start::probe")).toBeNull();
    expect(screen.queryByTestId("ed-handle-start-poll")).toBeNull();
    expect(buildEdges(sample(), null)).toHaveLength(2);
  });

  it("renders no probe node when polling is disabled", async () => {
    render(
      <Harness
        initial={sample({ enabled: false, probe: { type: "shell", command: "echo hi" } })}
      />,
    );
    expect(await screen.findByTestId("ed-node-start")).toBeInTheDocument();
    expect(screen.queryByTestId("ed-node-start::probe")).toBeNull();
  });

  it("renders a derived shell probe above the start with the command as subtitle", async () => {
    render(
      <Harness initial={sample({ enabled: true, probe: { type: "shell", command: "echo hi" } })} />,
    );
    const probe = await screen.findByTestId("ed-node-start::probe");
    expect(probe).toHaveTextContent("Shell probe");
    expect(probe).toHaveTextContent("echo hi");
    expect(screen.getByTestId("ed-handle-start-poll")).toBeInTheDocument();
  });

  it("renders an agent probe with the prompt as subtitle", async () => {
    render(
      <Harness
        initial={sample({
          enabled: true,
          probe: { type: "agent", cli: "codex", prompt: "watch PRs" },
        })}
      />,
    );
    const probe = await screen.findByTestId("ed-node-start::probe");
    expect(probe).toHaveTextContent("Agent probe");
    expect(probe).toHaveTextContent("watch PRs");
  });

  it("connects the derived probe to the start top handle with a display edge", () => {
    const file = sample({ enabled: true, probe: { type: "shell", command: "echo hi" } });
    const edges = buildEdges(file, null);
    expect(edges).toHaveLength(3);
    const derived = edges.find((edge) => edge.source === "start::probe");
    expect(derived).toMatchObject({
      target: "start",
      sourceHandle: "out",
      targetHandle: "poll",
    });
  });

  it("clicking the probe selects the start node, never the probe id", async () => {
    const onSelection = vi.fn();
    render(
      <Harness
        initial={sample({ enabled: true, probe: { type: "shell", command: "echo hi" } })}
        onSelection={onSelection}
      />,
    );
    fireEvent.click(await screen.findByTestId("ed-node-start::probe"));
    expect(onSelection).toHaveBeenCalledWith({ kind: "node", nodeId: "start" });
  });

  it("never writes derived nodes into the saved graph on change", async () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={sample({ enabled: true, probe: { type: "shell", command: "echo hi" } })}
        onChange={onChange}
      />,
    );
    await screen.findByTestId("ed-node-start::probe");
    // Select the agent node with the keyboard, then delete it: the emitted
    // file must contain only saved nodes, with no derived probe ids.
    fireEvent.keyDown(screen.getByTestId("editor-canvas"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("editor-canvas"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("editor-canvas"), { key: "Delete" });
    const next = onChange.mock.calls[0]?.[0] as WorkflowFile;
    expect(next.graph.nodes.map((node) => node.id)).toEqual(["start", "end"]);
    expect(next.graph.nodes.every((node) => !node.id.includes("::probe"))).toBe(true);
    expect(next.graph.edges.every((edge) => !edge.id.includes("::probe"))).toBe(true);
  });

  it("opens the Polling inspector section when the probe is clicked", () => {
    openInspectorSection("start:polling");
    render(
      <Inspector
        node={
          sample({ enabled: true, probe: { type: "shell", command: "x" } }).graph.nodes[0] ?? null
        }
        issues={[]}
        onPatch={() => undefined}
      />,
    );
    const polling = screen.getByText("Polling trigger").closest("details");
    expect(polling?.hasAttribute("open")).toBe(true);
  });
});
