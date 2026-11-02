import type {
  AgentNode,
  Issue,
  PollProbe,
  ShellNode,
  StartNode,
  WorkflowFile,
} from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import { createEditorModel } from "../src/editor/model/index.js";

const START_ID = "start";

function agentProbe(overrides: Partial<Extract<PollProbe, { type: "agent" }>> = {}): PollProbe {
  return {
    id: "probe",
    type: "agent",
    name: "Poll probe",
    cli: "claude-code",
    prompt: "watch PRs",
    permissions: { network: true, write: [], shell: true },
    ...overrides,
  };
}

function shellProbe(overrides: Partial<Extract<PollProbe, { type: "shell" }>> = {}): PollProbe {
  return {
    id: "probe",
    type: "shell",
    name: "Poll probe",
    command: "echo hi",
    ...overrides,
  };
}

function agentNodeForProbe(probe: Extract<PollProbe, { type: "agent" }>): AgentNode {
  return { ...probe, output: { type: "object", additionalProperties: true } } as AgentNode;
}

function shellNodeForProbe(probe: Extract<PollProbe, { type: "shell" }>): ShellNode {
  return { ...probe } as ShellNode;
}

function probeIssues(nodeId: string, issues: Issue[]): Issue[] {
  return issues.map((issue) => ({ ...issue, nodeId }));
}

let agentPatches: Array<Record<string, unknown>> = [];
let shellPatches: Array<Record<string, unknown>> = [];

function AgentHarness({ probe, issues = [] }: { probe: PollProbe; issues?: Issue[] }) {
  const [node, setNode] = useState<AgentNode>(() =>
    agentNodeForProbe(probe as Extract<PollProbe, { type: "agent" }>),
  );
  return (
    <Inspector
      node={node}
      issues={probeIssues("probe", issues)}
      probeMode
      onPatch={(_nodeId, patch) => {
        agentPatches.push(patch as Record<string, unknown>);
        setNode((previous) => ({ ...previous, ...patch }) as AgentNode);
      }}
    />
  );
}

function ShellHarness({ probe, issues = [] }: { probe: PollProbe; issues?: Issue[] }) {
  const [node, setNode] = useState<ShellNode>(() =>
    shellNodeForProbe(probe as Extract<PollProbe, { type: "shell" }>),
  );
  return (
    <Inspector
      node={node}
      issues={probeIssues("probe", issues)}
      probeMode
      onPatch={(_nodeId, patch) => {
        shellPatches.push(patch as Record<string, unknown>);
        setNode((previous) => ({ ...previous, ...patch }) as ShellNode);
      }}
    />
  );
}

beforeEach(() => {
  agentPatches = [];
  shellPatches = [];
  vi.restoreAllMocks();
});

describe("poll probe inspector (full node forms)", () => {
  it("opens the real agent form with the MCP section for an agent probe", () => {
    render(<AgentHarness probe={agentProbe()} />);
    // Provider chips, model picker, tools (MCP), permissions and limits all render.
    expect(screen.getByTestId("inspector-agent-cli")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-tools")).toBeInTheDocument();
    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(screen.getByText("Limits")).toBeInTheDocument();
  });

  it("hides the output editor and shows the generated-format note", () => {
    render(<AgentHarness probe={agentProbe()} />);
    expect(screen.getByText("The poll result format is generated for you.")).toBeVisible();
    expect(screen.queryByTestId("inspector-output-mode")).toBeNull();
  });

  it("hides promptFile and workspace sections for a probe", () => {
    render(<AgentHarness probe={agentProbe()} />);
    expect(screen.queryByTestId("inspector-agent-prompt-file-note")).toBeNull();
    expect(screen.queryByTestId("inspector-agent-remove-prompt-file")).toBeNull();
    expect(screen.queryByTestId("inspector-workspace-note")).toBeNull();
  });

  it("explains the preamble and the missing {{ }} variables on the prompt", () => {
    render(<AgentHarness probe={agentProbe()} />);
    expect(screen.getByText(/contract preamble is prepended automatically/u)).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-agent-prompt-variables")).toBeNull();
  });

  it("shows the probe name with id fixed to probe", () => {
    render(<AgentHarness probe={agentProbe({ name: "Poll probe" })} />);
    expect(screen.getByTestId("inspector-node-name")).toHaveValue("Poll probe");
    const id = screen.getByTestId("inspector-node-id") as HTMLInputElement;
    expect(id.value).toBe("probe");
    expect(id.readOnly).toBe(true);
  });

  it("edits the agent prompt in one patch", async () => {
    render(<AgentHarness probe={agentProbe({ prompt: "" })} />);
    fireEvent.change(screen.getByTestId("inspector-agent-prompt"), {
      target: { value: "watch issues" },
    });
    await waitFor(() => expect(agentPatches).toHaveLength(1));
    expect(agentPatches[0]).toMatchObject({ prompt: "watch issues" });
  });

  it("edits agent limits.timeoutMin (not a removed top-level timeoutMin)", async () => {
    render(<AgentHarness probe={agentProbe()} />);
    fireEvent.change(screen.getByTestId("inspector-agent-timeout"), {
      target: { value: "12" },
    });
    await waitFor(() => expect(agentPatches).toHaveLength(1));
    expect(agentPatches[0]).toMatchObject({ limits: { timeoutMin: 12 } });
  });

  it("renders the shell probe without allowFailure, workspace or variables", () => {
    render(<ShellHarness probe={shellProbe()} />);
    expect(screen.getByTestId("inspector-shell-command")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-shell-timeout")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-shell-allow-failure")).toBeNull();
    expect(screen.queryByTestId("inspector-workspace-note")).toBeNull();
    expect(screen.queryByTestId("inspector-shell-command-variables")).toBeNull();
  });

  it("edits the shell command in one patch", async () => {
    render(<ShellHarness probe={shellProbe({ command: "" })} />);
    fireEvent.change(screen.getByTestId("inspector-shell-command"), {
      target: { value: "echo ok" },
    });
    await waitFor(() => expect(shellPatches).toHaveLength(1));
    expect(shellPatches[0]).toMatchObject({ command: "echo ok" });
  });

  it("shows probe issues next to their fields and E_POLL_PROBE at the top", () => {
    const issues: Issue[] = [
      {
        severity: "error",
        code: "E_POLL_PROBE",
        message: "Poll agent probe prompt must be a non-empty string.",
        pointer: "/graph/nodes/0/polling/probe",
        nodeId: "start",
      },
      {
        severity: "error",
        code: "E_POLL_PROBE",
        message: "Prompt is empty.",
        pointer: "/graph/nodes/0/polling/probe/prompt",
        nodeId: "start",
      },
    ];
    render(<AgentHarness probe={agentProbe({ prompt: "" })} issues={issues} />);
    expect(screen.getByTestId("inspector-probe-error")).toBeVisible();
    expect(screen.getByText("Prompt is empty.")).toBeVisible();
    expect(screen.queryByTestId("inspector-issues")).toBeNull();
  });

  it("patches start.polling.probe in one undo step and never saves the probe as a node", () => {
    const startBase = createDefaultNode("start", [], { x: 0, y: 160 }) as StartNode;
    const start: StartNode = {
      ...startBase,
      params: [],
      polling: { enabled: true, probe: shellProbe({ command: "" }) },
    };
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "Workflow",
      graph: { nodes: [start], edges: [] },
    };
    const model = createEditorModel(file);
    const before = model.getState().past.length;

    // What WorkflowEditor does for a probe edit: one updateNode on the start.
    const current = (model.getFile().graph.nodes[0] as StartNode).polling?.probe;
    expect(current?.type).toBe("shell");
    const nextProbe = { ...(current as PollProbe), command: "echo ok" } as PollProbe;
    const outcome = model.updateNode(START_ID, {
      polling: { enabled: true, probe: nextProbe },
    } as Partial<StartNode> as never);
    expect(outcome.ok).toBe(true);
    expect(model.getState().past.length).toBe(before + 1);

    const updated = model.getFile().graph.nodes[0] as StartNode;
    expect(updated.polling?.probe).toMatchObject({ id: "probe", command: "echo ok" });
    expect(model.getFile().graph.nodes.map((node) => node.id)).toEqual([START_ID]);
    expect(model.getFile().graph.edges).toEqual([]);

    model.undo();
    const reverted = model.getFile().graph.nodes[0] as StartNode;
    expect(reverted.polling?.probe).toMatchObject({ command: "" });
  });
});
