import type { Issue, StartNode } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
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

/** Keeps every raw patch, including explicit `undefined` values that a JSON log would drop. */
let patches: Array<Partial<StartNode>> = [];

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
    />
  );
}

function latest(): Partial<StartNode> | undefined {
  return patches.at(-1);
}

beforeEach(() => {
  patches = [];
});

describe("start node polling trigger", () => {
  it("writes polling defaults when Accept polling triggers is checked", async () => {
    render(<Harness initial={startNode()} />);

    const checkbox = screen.getByRole("checkbox", { name: "Accept polling triggers" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(latest()).toEqual({
        polling: {
          enabled: true,
          probe: { type: "shell", command: "" },
          dedupe: true,
          workspace: "project",
        },
      }),
    );
    expect(screen.getByRole("checkbox", { name: "Accept polling triggers" })).toBeChecked();
    expect(screen.getByTestId("inspector-polling-command")).toBeInTheDocument();
  });

  it("removes the polling block when the box is unchecked", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "shell", command: "x" } },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Accept polling triggers" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect("polling" in (latest() ?? {})).toBe(true);
    expect(latest()?.polling).toBeUndefined();
    expect(screen.queryByTestId("inspector-polling-command")).toBeNull();
  });

  it("switches the probe type in one patch and keeps the other fields", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "shell", command: "echo hi" } },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("inspector-polling-probe-agent"));
    await waitFor(() =>
      expect(latest()).toMatchObject({
        polling: { enabled: true, probe: { type: "agent", cli: "claude-code", prompt: "" } },
      }),
    );

    fireEvent.change(screen.getByTestId("inspector-polling-prompt"), { target: { value: "hi" } });
    await waitFor(() =>
      expect(latest()).toMatchObject({
        polling: { probe: { type: "agent", prompt: "hi" } },
      }),
    );

    fireEvent.click(screen.getByTestId("inspector-polling-probe-shell"));
    await waitFor(() =>
      expect(latest()).toMatchObject({
        polling: { probe: { type: "shell", command: "" } },
      }),
    );
  });

  it("writes the shell command and timeout in one patch per edit", async () => {
    render(
      <Harness
        initial={startNode({ polling: { enabled: true, probe: { type: "shell", command: "" } } })}
      />,
    );
    fireEvent.change(screen.getByTestId("inspector-polling-command"), {
      target: { value: "echo ok" },
    });
    await waitFor(() =>
      expect(latest()).toMatchObject({ polling: { probe: { type: "shell", command: "echo ok" } } }),
    );

    fireEvent.change(screen.getByTestId("inspector-polling-timeout"), { target: { value: "5" } });
    await waitFor(() => expect(latest()).toMatchObject({ polling: { probe: { timeoutMin: 5 } } }));
  });

  it("shows the agent provider chips and the token warning", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "agent", cli: "codex", prompt: "p" } },
        })}
      />,
    );
    expect(screen.getByRole("radio", { name: /Codex/u })).toBeInTheDocument();
    expect(screen.getByText("Each poll spends tokens.")).toBeVisible();
  });

  it("toggles Skip repeats and the workspace choice", async () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "shell", command: "x" } },
        })}
      />,
    );
    const dedupe = screen.getByRole("checkbox", { name: "Skip repeats" });
    // Default on, even when the saved file omits the key.
    expect(dedupe).toBeChecked();
    fireEvent.click(dedupe);
    await waitFor(() => expect(latest()).toMatchObject({ polling: { dedupe: false } }));

    expect(screen.getByText("Read-only, no checkout.")).toBeVisible();
    fireEvent.click(screen.getByTestId("inspector-polling-workspace-worktree"));
    await waitFor(() => expect(latest()).toMatchObject({ polling: { workspace: "worktree" } }));
    expect(screen.getByText("A fresh worktree per poll is slow.")).toBeVisible();
  });

  it("describes the output contract, including the single-parameter bare line", () => {
    render(
      <Harness
        initial={startNode({
          params: [{ name: "topic", type: "string", required: true }],
          polling: { enabled: true, probe: { type: "shell", command: "x" } },
        })}
      />,
    );
    expect(screen.getByText(/a single bare line of output is used/u)).toBeVisible();
    expect(screen.getByText("dedupeKey")).toBeInTheDocument();
  });

  it("shows E_POLL_PROBE and /polling/* issues next to their fields, not in the generic list", () => {
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
        code: "E_POLL_TIMEOUT",
        message: "Probe timeout must be shorter than the interval.",
        pointer: "/graph/nodes/0/polling/probe/timeoutMin",
        nodeId: NODE_ID,
      },
    ];
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "shell", command: "" } },
        })}
        issues={issues}
      />,
    );

    expect(screen.getByText("Probe command is empty.")).toBeVisible();
    expect(screen.getByText("Probe timeout must be shorter than the interval.")).toBeVisible();
    expect(screen.queryByTestId("inspector-issues")).toBeNull();
  });

  it("shows the polling On badge while the webhook badge stays Off", () => {
    render(
      <Harness
        initial={startNode({
          polling: { enabled: true, probe: { type: "shell", command: "x" } },
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
});
