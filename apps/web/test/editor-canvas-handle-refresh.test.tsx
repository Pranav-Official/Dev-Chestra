import type { WorkflowFile } from "@relay/schema";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

const mocks = vi.hoisted(() => ({ updateNodeInternals: vi.fn() }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, useUpdateNodeInternals: () => mocks.updateNodeInternals };
});

function file(gateBranch: string, joinInput: string): WorkflowFile {
  const gate = createDefaultNode("gate", [], { x: 0, y: 0 });
  const join = createDefaultNode("join", [gate], { x: 208, y: 0 });
  if (gate.type !== "gate" || join.type !== "join") throw new Error("routing nodes missing");
  return {
    schemaVersion: 1,
    id: "routing",
    name: "Routing",
    graph: {
      nodes: [
        {
          ...gate,
          branches: [
            { id: gateBranch, when: "true" },
            { id: "otherwise", otherwise: true },
          ],
        },
        { ...join, inputs: [joinInput] },
      ],
      edges: [],
    },
  };
}

function renderCanvas(value: WorkflowFile) {
  return render(
    <EditorCanvas
      file={value}
      selection={null}
      issues={[]}
      onSelectionChange={() => undefined}
      onChange={() => undefined}
      onConnectionRejected={() => undefined}
    />,
  );
}

describe("routing handle cache refresh", () => {
  it("remeasures after gate branch and join input handle ids change", async () => {
    const view = renderCanvas(file("branch", "input"));
    await waitFor(() => expect(mocks.updateNodeInternals).toHaveBeenCalled());
    mocks.updateNodeInternals.mockClear();

    view.rerender(
      <EditorCanvas
        file={file("renamed", "renamed_input")}
        selection={null}
        issues={[]}
        onSelectionChange={() => undefined}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(mocks.updateNodeInternals).toHaveBeenCalledWith("gate");
      expect(mocks.updateNodeInternals).toHaveBeenCalledWith("join");
    });
  });
});
