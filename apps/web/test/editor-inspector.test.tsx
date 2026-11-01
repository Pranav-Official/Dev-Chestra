import type {
  AgentNode,
  EndNode,
  Issue,
  ShellNode,
  StartNode,
  WorkflowNode,
} from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import type { BufferValidity } from "../src/editor/inspector/types.js";

interface PatchEntry {
  nodeId: string;
  patch: Record<string, unknown>;
}

function Harness({
  initial,
  alternate,
  issues = [],
}: {
  initial: WorkflowNode;
  alternate?: WorkflowNode;
  issues?: Issue[];
}) {
  const [node, setNode] = useState<WorkflowNode | null>(initial);
  const [patches, setPatches] = useState<PatchEntry[]>([]);
  const [validity, setValidity] = useState<BufferValidity[]>([]);

  return (
    <div>
      <Inspector
        node={node}
        issues={issues}
        onPatch={(nodeId, patch) => {
          setPatches((previous) => [
            ...previous,
            { nodeId, patch: patch as Record<string, unknown> },
          ]);
          setNode((previous) =>
            previous === null ? previous : ({ ...previous, ...patch } as WorkflowNode),
          );
        }}
        onBufferValidityChange={(state) => setValidity((previous) => [...previous, state])}
      />
      <button type="button" data-testid="switch-node" onClick={() => setNode(alternate ?? null)}>
        Switch
      </button>
      <pre data-testid="patch-log">{JSON.stringify(patches)}</pre>
      <pre data-testid="validity-log">{JSON.stringify(validity)}</pre>
    </div>
  );
}

function patches(): PatchEntry[] {
  return JSON.parse(screen.getByTestId("patch-log").textContent ?? "[]") as PatchEntry[];
}

function lastPatch(): PatchEntry | undefined {
  return patches().at(-1);
}

function validity(): BufferValidity[] {
  return JSON.parse(screen.getByTestId("validity-log").textContent ?? "[]") as BufferValidity[];
}

async function expectInvalid(): Promise<void> {
  await waitFor(() => expect(validity().at(-1)?.valid).toBe(false));
}

async function expectValid(): Promise<void> {
  await waitFor(() => expect(validity().at(-1)?.valid).toBe(true));
}

const start: StartNode = {
  id: "node-start",
  type: "start",
  name: "Start",
  params: [
    { name: "topic", type: "string", required: true },
    { name: "count", type: "number", default: 0, required: false },
    { name: "flag", type: "boolean", default: false, required: false },
    { name: "mode", type: "enum", default: "fast", options: ["fast", "slow"], required: false },
  ],
};

const agent: AgentNode = {
  id: "node-agent",
  type: "agent",
  name: "Research",
  cli: "codex",
  prompt: "Find the facts.",
  output: {
    type: "object",
    properties: {
      summary: { type: "string" },
      points: { type: "array", items: { type: "string" }, maxItems: 20 },
    },
    required: ["summary", "points"],
    additionalProperties: false,
  },
  permissions: { network: false, write: ["workspace"] },
  workspace: { mode: "scratch" },
  limits: { timeoutMin: 30, validationRetries: 2, crashRetries: 1 },
};

const shell: ShellNode = {
  id: "node-shell",
  type: "shell",
  name: "Build",
  command: "echo build",
  workspace: { mode: "scratch" },
  timeoutMin: 15,
  allowFailure: false,
};

const end: EndNode = {
  id: "node-end",
  type: "end",
  name: "Done",
  status: "success",
  result: "research.summary",
};

describe("Inspector identity and Start parameters", () => {
  it("edits the name but never rewrites the stable id", async () => {
    const user = userEvent.setup();
    render(<Harness initial={start} alternate={agent} />);

    const name = screen.getByTestId("inspector-node-name");
    expect(name).toHaveAccessibleName("Name");
    expect(screen.getByTestId("inspector-node-id")).toHaveAccessibleName("Node ID (read-only)");
    expect(screen.getByTestId("inspector-node-id")).toHaveValue("node-start");
    expect(screen.getByTestId("inspector-node-id")).toHaveAttribute("readonly");

    fireEvent.change(name, { target: { value: "" } });
    await expectInvalid();
    expect(lastPatch()).toBeUndefined();
    expect(screen.getByText("Name is required.")).toBeInTheDocument();

    fireEvent.change(name, { target: { value: "Kickoff" } });
    await waitFor(() => expect(lastPatch()?.patch.name).toBe("Kickoff"));
    await expectValid();
    expect(screen.getByTestId("inspector-node-id")).toHaveValue("node-start");

    await user.tab();
    expect(screen.getByTestId("inspector-node-name")).toHaveFocus();
  });

  it("round-trips zero, false, enum and required without dropping fields", async () => {
    render(<Harness initial={start} />);

    expect(screen.getByTestId("inspector-param-1-default")).toHaveValue("0");
    expect(screen.getByTestId("inspector-param-2-default")).toHaveValue("false");
    expect(screen.getByTestId("inspector-param-3-default")).toHaveValue("fast");
    expect(screen.getByTestId("inspector-param-0-required")).toBeChecked();

    fireEvent.change(screen.getByTestId("inspector-param-1-default"), {
      target: { value: "7.5" },
    });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[1]).toEqual({ name: "count", type: "number", default: 7.5, required: false });
      expect(params[2]).toEqual({ name: "flag", type: "boolean", default: false, required: false });
      expect(params[3]).toEqual({
        name: "mode",
        type: "enum",
        default: "fast",
        options: ["fast", "slow"],
        required: false,
      });
    });

    fireEvent.change(screen.getByTestId("inspector-param-2-default"), {
      target: { value: "true" },
    });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[2]?.default).toBe(true);
    });

    fireEvent.change(screen.getByTestId("inspector-param-2-default"), {
      target: { value: "" },
    });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[2]).not.toHaveProperty("default");
      expect(params[2]?.type).toBe("boolean");
    });

    fireEvent.click(screen.getByTestId("inspector-param-0-required"));
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[0]?.required).toBe(false);
    });
  });

  it("blocks partial numeric defaults and resets the buffer on node switch", async () => {
    const user = userEvent.setup();
    render(<Harness initial={start} alternate={agent} />);
    const numeric = screen.getByTestId("inspector-param-1-default");

    fireEvent.change(numeric, { target: { value: "not-a-number" } });
    await expectInvalid();
    expect(lastPatch()).toBeUndefined();

    fireEvent.change(numeric, { target: { value: "3" } });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[1]?.default).toBe(3);
    });
    await expectValid();

    fireEvent.change(numeric, { target: { value: "" } });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[1]).not.toHaveProperty("default");
    });
    await user.click(screen.getByTestId("switch-node"));
    expect(screen.getByTestId("inspector-node-name")).toHaveValue("Research");
    await expectValid();
  });

  it("adds, removes and surfaces parameter issues inline", async () => {
    const issue: Issue = {
      severity: "error",
      code: "E_PARAM_DUPLICATE",
      message: "Duplicate parameter name 'topic'.",
      pointer: "/graph/nodes/0/params/0/name",
      nodeId: "node-start",
    };
    render(<Harness initial={start} issues={[issue]} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Duplicate parameter name 'topic'.");

    fireEvent.click(screen.getByTestId("inspector-add-param"));
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params).toHaveLength(5);
      expect(params[4]?.name).toBe("param5");
      expect(params[0]).toEqual(start.params[0]);
    });

    fireEvent.change(screen.getByTestId("inspector-param-0-name"), {
      target: { value: "subject" },
    });
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params[0]?.name).toBe("subject");
      expect(params[3]?.options).toEqual(["fast", "slow"]);
    });

    fireEvent.change(screen.getByTestId("inspector-param-0-name"), {
      target: { value: "bad-name" },
    });
    await expectInvalid();
    expect(screen.getByTestId("inspector-param-0-name")).toHaveAccessibleDescription(
      /Use letters, numbers and underscores/,
    );
  });
});

describe("Agent fields", () => {
  it("offers only real CLIs and edits the model only through explicit picker actions", async () => {
    render(<Harness initial={agent} alternate={shell} />);
    expect(screen.getByText(/Permissions are advisory/)).toBeInTheDocument();
    expect(screen.getAllByText(/not an OS sandbox/i).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("inspector-agent-model")).toBeNull();
    expect(screen.getByTestId("inspector-agent-model-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-agent-model-picker")).toBeNull();
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "CLI default",
    );
    expect(screen.queryByLabelText(/context/i)).toBeNull();
    expect(screen.queryByLabelText(/environment/i)).toBeNull();
    expect(screen.queryByLabelText(/cli options/i)).toBeNull();
    expect(screen.queryByLabelText(/provider key/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /project workspace/i })).toBeNull();

    fireEvent.click(screen.getByTestId("inspector-agent-cli-claude-code"));
    await waitFor(() =>
      expect(lastPatch()).toEqual({
        nodeId: "node-agent",
        patch: { cli: "claude-code", model: undefined },
      }),
    );
    expect(screen.getByText(/Permissions are advisory/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("inspector-agent-model-trigger"));
    fireEvent.change(screen.getByTestId("inspector-agent-model-picker"), {
      target: { value: "gpt-test" },
    });
    expect(patches().at(-1)?.patch).not.toHaveProperty("model");
    fireEvent.click(screen.getByTestId("inspector-agent-model-custom-option"));
    await waitFor(() => expect(lastPatch()?.patch).toEqual({ model: "gpt-test" }));
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent("gpt-test");

    fireEvent.click(screen.getByTestId("inspector-agent-model-trigger"));
    const defaultOption = await screen.findByTestId("inspector-agent-model-default");
    fireEvent.mouseDown(defaultOption);
    fireEvent.click(defaultOption);
    await waitFor(() =>
      expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
        "CLI default",
      ),
    );
  });

  it("clears the old model in one explicit CLI change patch", () => {
    const onPatch = vi.fn();
    render(
      <Inspector node={{ ...agent, cli: "codex", model: "gpt-5" }} issues={[]} onPatch={onPatch} />,
    );
    fireEvent.click(screen.getByTestId("inspector-agent-cli-claude-code"));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("node-agent", {
      cli: "claude-code",
      model: undefined,
    });
  });

  it("edits inline prompts and never silently drops an external promptFile", () => {
    const { rerender } = render(<Inspector node={agent} issues={[]} onPatch={() => undefined} />);
    expect(screen.getByTestId("inspector-agent-prompt")).toHaveValue("Find the facts.");

    const { prompt: _inlinePrompt, ...withoutPrompt } = agent;
    const external: AgentNode = { ...withoutPrompt, promptFile: "work.prompts/research.md" };
    rerender(<Inspector node={external} issues={[]} onPatch={() => undefined} />);
    expect(screen.getByTestId("inspector-agent-prompt-file-note")).toHaveTextContent(
      "work.prompts/research.md",
    );
    expect(screen.queryByTestId("inspector-agent-prompt")).toBeNull();

    const both = { ...agent, promptFile: "work.prompts/research.md" };
    rerender(<Inspector node={both} issues={[]} onPatch={() => undefined} />);
    expect(screen.getByTestId("inspector-agent-remove-prompt-file")).toBeInTheDocument();
  });

  it("edits network and workspace write permissions without turning on project writes", async () => {
    render(<Harness initial={agent} />);
    fireEvent.click(screen.getByTestId("inspector-agent-network"));
    await waitFor(() => {
      expect(lastPatch()?.patch.permissions).toEqual({ network: true, write: ["workspace"] });
    });

    fireEvent.click(screen.getByTestId("inspector-agent-write-workspace"));
    await waitFor(() => {
      expect(lastPatch()?.patch.permissions).toEqual({ network: true, write: [] });
    });

    expect(screen.getByTestId("inspector-workspace-note")).toHaveTextContent(
      "Workspace is chosen when starting the workflow.",
    );
    expect(screen.queryByTestId("inspector-agent-write-project")).toBeNull();
    expect(screen.queryByTestId("inspector-agent-remove-project-write")).toBeNull();
  });

  it("does not expose a per-node workspace selector on agent or shell nodes", () => {
    render(<Harness initial={agent} alternate={shell} />);
    expect(screen.getByTestId("inspector-workspace-note")).toHaveTextContent(
      "Workspace is chosen when starting the workflow.",
    );
    expect(screen.queryByTestId("inspector-workspace-mode")).toBeNull();
    expect(screen.queryByLabelText(/^workspace$/i)).toBeNull();

    fireEvent.click(screen.getByTestId("switch-node"));
    expect(screen.getByTestId("inspector-workspace-note")).toHaveTextContent(
      "Workspace is chosen when starting the workflow.",
    );
    expect(screen.queryByTestId("inspector-workspace-mode")).toBeNull();
  });

  it("preserves a legacy project write and lets the user remove it explicitly", async () => {
    render(
      <Harness
        initial={{
          ...agent,
          permissions: {
            network: false,
            write: ["workspace", "project"] as ("workspace" | "project")[],
          },
        }}
      />,
    );
    expect(screen.getByTestId("inspector-agent-write-project")).toBeDisabled();
    expect(screen.getByTestId("inspector-agent-write-project")).toBeChecked();
    fireEvent.click(screen.getByTestId("inspector-agent-remove-project-write"));
    await waitFor(() => {
      expect(lastPatch()?.patch.permissions).toEqual({ network: false, write: ["workspace"] });
    });
  });

  it("enforces the exact engine limit ranges and preserves other limits", async () => {
    render(<Harness initial={agent} />);
    const timeout = screen.getByTestId("inspector-agent-timeout");
    fireEvent.change(timeout, { target: { value: "0" } });
    await expectInvalid();
    expect(patches().some((entry) => "limits" in entry.patch)).toBe(false);

    fireEvent.change(timeout, { target: { value: "45" } });
    await waitFor(() => {
      expect(lastPatch()?.patch.limits).toEqual({
        timeoutMin: 45,
        validationRetries: 2,
        crashRetries: 1,
      });
    });
    await expectValid();

    const retries = screen.getByTestId("inspector-agent-validation-retries");
    fireEvent.change(retries, { target: { value: "11" } });
    await expectInvalid();
    fireEvent.change(retries, { target: { value: "0" } });
    await waitFor(() => {
      expect(lastPatch()?.patch.limits).toEqual({
        timeoutMin: 45,
        validationRetries: 0,
        crashRetries: 1,
      });
    });
  });

  it("edits the prompt as real multi-line text", async () => {
    render(<Harness initial={agent} />);
    expect(
      screen.getByText(
        /Workflow parameters and connected earlier outputs are automatically included with every run/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Optional \{\{ … \}\} templates remain for custom formatting/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("inspector-agent-prompt"), {
      target: { value: "Line one\nLine two" },
    });
    await waitFor(() => expect(lastPatch()?.patch.prompt).toBe("Line one\nLine two"));
  });
});

describe("Shell and End fields", () => {
  it("edits multi-line shell text, limits and allowFailure without executing anything", async () => {
    render(<Harness initial={shell} />);
    const command = screen.getByTestId("inspector-shell-command");
    expect(command.tagName).toBe("TEXTAREA");
    fireEvent.change(command, { target: { value: 'echo "a"\necho "b"' } });
    await waitFor(() => expect(lastPatch()?.patch.command).toBe('echo "a"\necho "b"'));

    fireEvent.change(screen.getByTestId("inspector-shell-timeout"), {
      target: { value: "" },
    });
    await waitFor(() => expect(patches().at(-1)?.patch).not.toHaveProperty("timeoutMin"));

    fireEvent.click(screen.getByTestId("inspector-shell-allow-failure"));
    await waitFor(() => expect(lastPatch()?.patch.allowFailure).toBe(true));
    expect(screen.getByTestId("inspector-shell-effects-note")).toHaveTextContent(
      "real side effects",
    );
    expect(screen.getByTestId("inspector-workspace-note")).toHaveTextContent(
      "Workspace is chosen when starting the workflow.",
    );
    expect(screen.queryByTestId("inspector-workspace-mode")).toBeNull();
  });

  it("edits end status/result and shows the ancestor-only scope hint", async () => {
    const issue: Issue = {
      severity: "error",
      code: "E_EXPR_SCOPE",
      message: "Expression root 'other' is not in scope.",
      pointer: "/graph/nodes/2/result",
      nodeId: "node-end",
    };
    render(<Harness initial={end} issues={[issue]} />);

    fireEvent.change(screen.getByTestId("inspector-end-status"), {
      target: { value: "rejected" },
    });
    await waitFor(() => expect(lastPatch()?.patch.status).toBe("rejected"));

    fireEvent.change(screen.getByTestId("inspector-end-result"), {
      target: { value: "$sum(topic.nums)" },
    });
    await waitFor(() => expect(lastPatch()?.patch.result).toBe("$sum(topic.nums)"));

    expect(screen.getByTestId("inspector-end-scope-hint")).toHaveTextContent(
      "ancestor outputs only",
    );
    expect(screen.getByTestId("inspector-end-scope-hint")).toHaveTextContent("never evaluates");
    expect(screen.getByRole("alert")).toHaveTextContent("Expression root 'other' is not in scope.");
  });
});

describe("Accessibility and buffer lifecycle", () => {
  it("uses real labels, error text and keyboard-activatable buttons", async () => {
    const user = userEvent.setup();
    render(<Harness initial={start} />);
    expect(screen.getByTestId("inspector-node-name")).toHaveAccessibleName("Name");
    expect(screen.getByTestId("inspector-param-0-name")).toHaveAccessibleName("Name");

    fireEvent.change(screen.getByTestId("inspector-node-name"), { target: { value: "" } });
    const name = screen.getByTestId("inspector-node-name");
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription("Name is required.");
    expect(screen.getByRole("alert")).toHaveTextContent("Name is required.");

    const add = screen.getByTestId("inspector-add-param");
    add.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const params = lastPatch()?.patch.params as StartNode["params"];
      expect(params).toHaveLength(5);
    });
  });

  it("reports valid on unmount and clears invalid buffers when the node changes", async () => {
    const onValidity = vi.fn();
    const { unmount } = render(
      <Inspector
        node={agent}
        issues={[]}
        onPatch={() => undefined}
        onBufferValidityChange={onValidity}
      />,
    );
    onValidity.mockClear();
    unmount();
    expect(onValidity).toHaveBeenCalledWith({ valid: true });

    const user = userEvent.setup();
    render(<Harness initial={agent} alternate={start} />);
    fireEvent.click(screen.getByTestId("inspector-output-advanced-toggle"));
    fireEvent.change(screen.getByTestId("inspector-output-advanced-json"), {
      target: { value: "{" },
    });
    await expectInvalid();
    await user.click(screen.getByTestId("switch-node"));
    expect(screen.getByTestId("inspector-node-name")).toHaveValue("Start");
    await expectValid();
  });
});
