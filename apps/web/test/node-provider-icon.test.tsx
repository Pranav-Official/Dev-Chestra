import { emptyRunView } from "@devchestra/core";
import type { AgentNode, StartNode, WorkflowFile } from "@devchestra/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { shortModel } from "../src/editor/canvas/nodes.js";
import { RunCanvas, type WorkflowSnapshot } from "../src/run/RunCanvas.js";
import { ProviderStateProvider } from "../src/ui/providerState.js";

function agentNode(model?: string): AgentNode {
  return {
    id: "agent",
    type: "agent",
    name: "Agent",
    cli: "codex",
    ...(model === undefined ? {} : { model }),
    output: { type: "object" },
    permissions: { network: false, write: [] },
  };
}

function startNode(): StartNode {
  return { id: "start", type: "start", name: "Start", params: [] };
}

function fileWith(...nodes: WorkflowFile["graph"]["nodes"]): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: { nodes, edges: [] },
  };
}

function canvasProps(file: WorkflowFile) {
  return {
    file,
    selection: null,
    issues: [],
    onSelectionChange: vi.fn(),
    onChange: vi.fn(),
    onConnectionRejected: vi.fn(),
  };
}

describe("shortModel", () => {
  it("shows 'default' when no model is set", () => {
    expect(shortModel(undefined)).toBe("default");
    expect(shortModel("")).toBe("default");
  });

  it("keeps a plain model name", () => {
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });

  it("strips one provider prefix", () => {
    expect(shortModel("opencode-go/muse-spark-1.3")).toBe("muse-spark-1.3");
    expect(shortModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("cuts long names to 22 characters with an ellipsis", () => {
    const long = shortModel("a-very-long-model-name-that-keeps-going");
    expect(long).toBe("a-very-long-model-nam…");
    expect(long).toHaveLength(22);
  });
});

describe("provider icon on editor nodes", () => {
  it("shows the provider icon on an agent node", async () => {
    const { container } = render(<EditorCanvas {...canvasProps(fileWith(agentNode("gpt-5")))} />);
    expect(await screen.findByTestId("ed-node-agent")).toBeInTheDocument();
    expect(container.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
  });

  it("shows no dot without a provider context", async () => {
    const { container } = render(<EditorCanvas {...canvasProps(fileWith(agentNode()))} />);
    await screen.findByTestId("ed-node-agent");
    expect(container.querySelector(".ed-node-provider-dot")).toBeNull();
    expect(container.querySelector(".ed-node-provider.is-off")).toBeNull();
  });

  it("dims the node and shows a dot when the provider is turned off", async () => {
    const { container } = render(
      <ProviderStateProvider value={{ isDisabled: (cli) => cli === "codex" }}>
        <EditorCanvas {...canvasProps(fileWith(agentNode()))} />
      </ProviderStateProvider>,
    );
    await screen.findByTestId("ed-node-agent");
    expect(container.querySelector(".ed-node-provider.is-off")).not.toBeNull();
    expect(container.querySelector(".ed-node-provider-dot")).not.toBeNull();
    const meta = container.querySelector(".ed-node-provider");
    expect(meta?.getAttribute("title")).toBe("codex · turned off in Settings");
  });

  it("renders no provider icon on a non-agent node", async () => {
    const { container } = render(<EditorCanvas {...canvasProps(fileWith(startNode()))} />);
    await screen.findByTestId("ed-node-start");
    expect(container.querySelector("[data-provider-icon]")).toBeNull();
  });
});

describe("provider icon in the run viewer", () => {
  it("shows the provider icon and short model on an agent snapshot node", () => {
    const snapshot: WorkflowSnapshot = {
      name: "Run",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Start" },
          { id: "agent", type: "agent", name: "Agent", cli: "codex", model: "gpt-5" },
        ],
        edges: [{ id: "e1", from: "start", to: "agent" }],
      },
    };
    render(
      <RunCanvas
        snapshot={snapshot}
        view={{ ...emptyRunView(), status: "running" }}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    const node = screen.getByTestId("run-node-agent");
    expect(node.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(node).toHaveTextContent("gpt-5");
    expect(node.querySelector(".flow-node-provider")).toHaveAttribute("title", "codex · gpt-5");
  });
});
