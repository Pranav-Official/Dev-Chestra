import type { Issue, PollProbe, StartNode } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";

const NODE_ID = "node-start";

function startNode(overrides: Partial<StartNode> = {}): StartNode {
  return {
    id: NODE_ID,
    type: "start",
    name: "Start",
    params: [
      { name: "topic", type: "string", required: true },
      { name: "count", type: "number", default: 1, required: false },
    ],
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

function agentProbe(overrides: Partial<Extract<PollProbe, { type: "agent" }>> = {}): PollProbe {
  return {
    id: "probe",
    type: "agent",
    name: "Poll probe",
    cli: "claude-code",
    prompt: "watch",
    permissions: { network: true, write: [], shell: true },
    ...overrides,
  };
}

/** Keeps every raw patch, including explicit `undefined` values that a JSON log would drop. */
let patches: Array<Partial<StartNode>> = [];
let selectedProbe: string | null = null;

function Harness({ initial, issues = [] }: { initial: StartNode; issues?: Issue[] }) {
  const [node, setNode] = useState<StartNode>(initial);
  return (
    <Inspector
      node={node}
      issues={issues}
      onPatch={(_nodeId, patch) => {
        patches.push(patch as Partial<StartNode>);
        setNode((previous) => ({ ...previous, ...patch }) as StartNode);
      }}
      onSelectProbe={(probeId) => {
        selectedProbe = probeId;
      }}
    />
  );
}

function latest(): Partial<StartNode> | undefined {
  return patches.at(-1);
}

beforeEach(() => {
  patches = [];
  selectedProbe = null;
});

describe("start node polling trigger", () => {
  it("writes polling defaults with a full shell probe when Accept polling triggers is checked", async () => {
    render(<Harness initial={startNode()} />);

    const checkbox = screen.getByRole("checkbox", { name: "Accept polling triggers" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(latest()).toEqual({
        polling: {
          enabled: true,
          probe: { id: "probe", type: "shell", name: "Poll probe", command: "" },
          dedupe: true,
          workspace: "project",
        },
      }),
    );
    expect(screen.getByRole("checkbox", { name: "Accept polling triggers" })).toBeChecked();
    // The shrunk section has no duplicated probe fields.
    expect(screen.queryByTestId("inspector-polling-command")).toBeNull();
    expect(screen.queryByTestId("inspector-polling-prompt")).toBeNull();
    expect(screen.queryByTestId("inspector-polling-timeout")).toBeNull();
    expect(screen.getByTestId("inspector-polling-edit-probe")).toBeInTheDocument();
  });

  it("removes the polling block when the box is unchecked", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: shellProbe({ command: "x" }) },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Accept polling triggers" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect("polling" in (latest() ?? {})).toBe(true);
    expect(latest()?.polling).toBeUndefined();
    expect(screen.queryByTestId("inspector-polling-edit-probe")).toBeNull();
  });

  it("switches the probe kind with a fresh default in one patch", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: shellProbe({ command: "echo hi" }) },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("inspector-polling-probe-agent"));
    await waitFor(() =>
      expect(latest()).toMatchObject({
        polling: {
          enabled: true,
          probe: {
            id: "probe",
            type: "agent",
            name: "Poll probe",
            prompt: "",
            permissions: { network: true, write: [], shell: true },
          },
        },
      }),
    );
    const polling = latest()?.polling as { probe: PollProbe } | undefined;
    const agentProbePatch = polling?.probe;
    expect(agentProbePatch?.type).toBe("agent");
    if (agentProbePatch?.type === "agent") {
      expect(typeof agentProbePatch.cli).toBe("string");
    }

    fireEvent.click(screen.getByTestId("inspector-polling-probe-shell"));
    await waitFor(() =>
      expect(latest()).toMatchObject({
        polling: {
          probe: { id: "probe", type: "shell", name: "Poll probe", command: "" },
        },
      }),
    );
  });

  it("always warns that the probe runs unattended", () => {
    render(<Harness initial={startNode({ polling: { enabled: true, probe: shellProbe() } })} />);
    expect(screen.getByTestId("inspector-polling-unattended")).toHaveTextContent(
      /unattended on every tick/u,
    );
  });

  it("warns more strongly when the agent probe has write access or MCP servers", () => {
    const { unmount } = render(
      <Harness initial={startNode({ polling: { enabled: true, probe: agentProbe() } })} />,
    );
    expect(screen.queryByTestId("inspector-polling-write-warning")).toBeNull();
    unmount();

    render(
      <Harness
        initial={startNode({
          polling: {
            enabled: true,
            probe: agentProbe({
              permissions: { network: true, write: ["workspace"], shell: true },
            }),
          },
        })}
      />,
    );
    expect(screen.getByTestId("inspector-polling-write-warning")).toBeVisible();
    screen.getByTestId("inspector-polling-write-warning").closest("div");
  });

  it("warns when the agent probe selects MCP servers", () => {
    render(
      <Harness
        initial={startNode({
          polling: {
            enabled: true,
            probe: agentProbe({ mcpServers: [{ name: "gh", scope: "global" }] }),
          },
        })}
      />,
    );
    expect(screen.getByTestId("inspector-polling-write-warning")).toBeVisible();
  });

  it("warns strongly when the probe runs in a fresh worktree", async () => {
    render(<Harness initial={startNode({ polling: { enabled: true, probe: shellProbe() } })} />);
    expect(screen.getByText("Read-only, no checkout.")).toBeVisible();
    fireEvent.click(screen.getByTestId("inspector-polling-workspace-worktree"));
    await waitFor(() => expect(latest()).toMatchObject({ polling: { workspace: "worktree" } }));
    expect(screen.getByTestId("inspector-polling-worktree-warning")).toHaveTextContent(
      /fresh worktree per poll is slow/u,
    );
  });

  it("toggles Skip repeats and the workspace choice", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: shellProbe() },
        })}
      />,
    );
    const dedupe = screen.getByRole("checkbox", { name: "Skip repeats" });
    // Default on, even when the saved file omits the key.
    expect(dedupe).toBeChecked();
    fireEvent.click(dedupe);
    await waitFor(() => expect(latest()).toMatchObject({ polling: { dedupe: false } }));

    fireEvent.click(screen.getByTestId("inspector-polling-workspace-worktree"));
    await waitFor(() => expect(latest()).toMatchObject({ polling: { workspace: "worktree" } }));
  });

  it("describes the output contract, including the single-parameter bare line", () => {
    render(
      <Harness
        initial={startNode({
          params: [{ name: "topic", type: "string", required: true }],
          polling: { enabled: true, probe: shellProbe() },
        })}
      />,
    );
    expect(screen.getByText(/a single bare line of output is used/u)).toBeVisible();
    expect(screen.getByText("dedupeKey")).toBeInTheDocument();
  });

  it("selects the probe node when Edit probe is clicked", () => {
    render(<Harness initial={startNode({ polling: { enabled: true, probe: shellProbe() } })} />);
    fireEvent.click(screen.getByTestId("inspector-polling-edit-probe"));
    expect(selectedProbe).toBe(`${NODE_ID}::probe`);
  });

  it("keeps probe issues off the start section (they belong to the probe node)", () => {
    const issues: Issue[] = [
      {
        severity: "error",
        code: "E_POLL_PROBE",
        message: "Probe command is empty.",
        pointer: "/graph/nodes/0/polling/probe",
        nodeId: NODE_ID,
      },
      {
        severity: "error",
        code: "E_POLL_PROBE",
        message: "Probe timeout must be shorter than the interval.",
        pointer: "/graph/nodes/0/polling/probe/timeoutMin",
        nodeId: NODE_ID,
      },
    ];
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: shellProbe({ command: "" }) },
        })}
        issues={issues}
      />,
    );

    expect(screen.queryByText("Probe command is empty.")).toBeNull();
    expect(screen.queryByText("Probe timeout must be shorter than the interval.")).toBeNull();
    expect(screen.queryByTestId("inspector-issues")).toBeNull();
  });

  it("shows the polling On badge while the webhook badge stays Off", () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: shellProbe() },
        })}
      />,
    );
    const sections = screen.getAllByText("Polling trigger");
    expect(sections.length).toBeGreaterThan(0);
    const pollingSummary = screen.getByText("Polling trigger").closest("details");
    expect(within(pollingSummary as HTMLElement).getByText("On")).toBeInTheDocument();
    const webhookSummary = screen.getByText("Webhook trigger").closest("details");
    expect(within(webhookSummary as HTMLElement).getByText("Off")).toBeInTheDocument();
  });

  it("does not read the removed agent timeoutMin field", () => {
    const probe = agentProbe({ limits: { timeoutMin: 12 } });
    expect("timeoutMin" in probe).toBe(false);
    render(<Harness initial={startNode({ polling: { enabled: true, probe } })} />);
    expect(screen.getByTestId("inspector-polling-edit-probe")).toBeInTheDocument();
    expect(vi).toBeDefined();
  });
});
