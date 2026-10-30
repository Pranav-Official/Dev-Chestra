import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentNode, Graph, ShellNode, WorkflowNode } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

const agent: AgentNode = {
  id: "node-agent",
  type: "agent",
  name: "Research",
  cli: "codex",
  prompt: "Find the facts.",
  output: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
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

const approval = {
  id: "node-approval",
  type: "approval",
  name: "Review",
  message: "Please review.",
  irreversible: false,
} as unknown as WorkflowNode;

const graph = {
  nodes: [
    {
      id: "start",
      type: "start",
      name: "Start",
      params: [{ name: "topic", type: "string", required: true }],
    },
    {
      id: "node-agent",
      type: "agent",
      name: "Research",
      cli: "codex",
      prompt: "Find the facts.",
      output: { type: "object", properties: { summary: { type: "string" } } },
      permissions: { network: false, write: [] },
    },
  ],
  edges: [{ id: "e1", from: "start", to: "node-agent" }],
} as unknown as Graph;

function Harness({ initial }: { initial: WorkflowNode }) {
  const [node, setNode] = useState<WorkflowNode>(initial);
  const [patches, setPatches] = useState<unknown[]>([]);
  return (
    <div>
      <Inspector
        node={node}
        graph={graph as never}
        issues={[]}
        onPatch={(_nodeId, patch) => {
          setPatches((previous) => [...previous, patch]);
          setNode((previous) => ({ ...previous, ...patch }) as WorkflowNode);
        }}
      />
      <pre data-testid="patch-log">{JSON.stringify(patches)}</pre>
    </div>
  );
}

function patches(): unknown[] {
  return JSON.parse(screen.getByTestId("patch-log").textContent ?? "[]") as unknown[];
}

function openExpanded(textareaTestId: string): void {
  fireEvent.click(screen.getByTestId(`${textareaTestId}-expand`));
  expect(screen.getByTestId(`${textareaTestId}-expanded`)).toBeInTheDocument();
  expect(screen.getByTestId(`${textareaTestId}-expanded-dialog`)).toHaveAttribute("open");
}

describe("expandable textareas", () => {
  it("opens with the full text, applies the complete multiline draft, and leaves the field untouched until Apply", () => {
    const onPatch = vi.fn();
    render(<Inspector node={agent} issues={[]} onPatch={onPatch} />);
    openExpanded("inspector-agent-prompt");
    const expanded = screen.getByTestId("inspector-agent-prompt-expanded") as HTMLTextAreaElement;
    expect(expanded.value).toBe("Find the facts.");
    const next = "Line one.\nLine two with {{ detail }}.\nLine three.";
    fireEvent.change(expanded, { target: { value: next } });
    // Inline field is untouched while the draft is open.
    expect((screen.getByTestId("inspector-agent-prompt") as HTMLTextAreaElement).value).toBe(
      "Find the facts.",
    );
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inspector-agent-prompt-expanded-apply"));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch.mock.calls[0]?.[1]).toMatchObject({ prompt: next });
    expect(screen.queryByTestId("inspector-agent-prompt-expanded")).toBeNull();
  });

  it("discards edits on Cancel, X and Escape and returns focus to the expand button", async () => {
    render(<Inspector node={shell} issues={[]} onPatch={() => {}} />);
    for (const close of ["button", "escape"] as const) {
      openExpanded("inspector-shell-command");
      const expanded = screen.getByTestId(
        "inspector-shell-command-expanded",
      ) as HTMLTextAreaElement;
      fireEvent.change(expanded, { target: { value: "echo changed" } });
      if (close === "button") {
        fireEvent.click(screen.getByTestId("inspector-shell-command-expanded-cancel"));
      } else {
        fireEvent.keyDown(expanded, { key: "Escape" });
      }
      expect(screen.queryByTestId("inspector-shell-command-expanded")).toBeNull();
      expect((screen.getByTestId("inspector-shell-command") as HTMLTextAreaElement).value).toBe(
        "echo build",
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("inspector-shell-command-expand")),
      );
    }
  });

  it("blocks Apply for invalid buffered edits without touching the committed value", () => {
    render(<Harness initial={approval} />);
    openExpanded("inspector-approval-message");
    const expanded = screen.getByTestId(
      "inspector-approval-message-expanded",
    ) as HTMLTextAreaElement;
    fireEvent.change(expanded, { target: { value: "   " } });
    expect(screen.getByText("Message is required.")).toBeInTheDocument();
    const apply = screen.getByTestId(
      "inspector-approval-message-expanded-apply",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(patches()).toEqual([]);
    // A valid draft applies through the original buffered handler.
    fireEvent.change(expanded, { target: { value: "Updated review text" } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(patches()).toEqual([{ message: "Updated review text" }]);
  });

  it("keeps the variable picker inside the expanded dialog and inserts into the draft only", () => {
    const onPatch = vi.fn();
    render(<Inspector node={agent} graph={graph as never} issues={[]} onPatch={onPatch} />);
    openExpanded("inspector-agent-prompt");
    fireEvent.click(screen.getByTestId("inspector-agent-prompt-variables-expanded"));
    const dialog = screen.getByTestId("inspector-agent-prompt-expanded-dialog");
    const popover = screen.getByTestId("inspector-agent-prompt-variables-expanded-popover");
    expect(dialog.contains(popover)).toBe(true);
    fireEvent.click(within(popover as HTMLElement).getByTitle("{{ start.topic }}"));
    expect(
      (screen.getByTestId("inspector-agent-prompt-expanded") as HTMLTextAreaElement).value,
    ).toBe("Find the facts.{{ start.topic }}");
    expect((screen.getByTestId("inspector-agent-prompt") as HTMLTextAreaElement).value).toBe(
      "Find the facts.",
    );
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inspector-agent-prompt-expanded-apply"));
    expect(onPatch.mock.calls[0]?.[1]).toMatchObject({
      prompt: "Find the facts.{{ start.topic }}",
    });
  });

  it("closes the picker first on Escape without closing the expanded dialog", () => {
    render(<Inspector node={agent} graph={graph as never} issues={[]} onPatch={() => {}} />);
    openExpanded("inspector-agent-prompt");
    fireEvent.click(screen.getByTestId("inspector-agent-prompt-variables-expanded"));
    const search = screen.getByPlaceholderText("Search variables…");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Search variables…")).toBeNull();
    // The expanded editor is still open with the draft intact.
    expect(screen.getByTestId("inspector-agent-prompt-expanded")).toBeInTheDocument();
    expect(
      (screen.getByTestId("inspector-agent-prompt-expanded") as HTMLTextAreaElement).value,
    ).toBe("Find the facts.");
  });

  it("nests inside the loop body dialog: Apply updates the draft, outer save stays gated", async () => {
    const loop = createDefaultNode("loop", []) as unknown as WorkflowNode;
    const bodyGraph = {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        loop,
        { id: "end", type: "end", name: "End", status: "success", result: "done" },
      ],
      edges: [
        { id: "e1", from: "start", to: (loop as { id: string }).id },
        { id: "e2", from: (loop as { id: string }).id, to: "end" },
      ],
    } as unknown as Graph;
    const onPatch = vi.fn();
    render(<Inspector node={loop} graph={bodyGraph as never} issues={[]} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId("loop-body-open"));
    const bodyDialog = screen.getByTestId("loop-body-dialog");
    await waitFor(() => expect(bodyDialog).toHaveAttribute("open"));
    fireEvent.click(screen.getByTestId("ed-node-done"));
    const inspector = screen.getByTestId("loop-body-inspector");
    fireEvent.click(within(inspector).getByTestId("inspector-end-result-expand"));
    const expanded = screen.getByTestId("inspector-end-result-expanded") as HTMLTextAreaElement;
    fireEvent.change(expanded, { target: { value: "loop.state" } });
    fireEvent.click(screen.getByTestId("inspector-end-result-expanded-apply"));
    // The body draft is dirty but nothing reached the workflow yet.
    expect(screen.getByTestId("loop-body-dirty")).toHaveTextContent("Unapplied changes");
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("loop-body-cancel"));
    await waitFor(() => expect(bodyDialog).not.toHaveAttribute("open"));
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("stacks expand above the variable picker in one narrow action column", () => {
    render(<Harness initial={agent} />);
    const expand = screen.getByTestId("inspector-agent-prompt-expand");
    const actions = expand.parentElement;
    expect(actions).toHaveClass("inspector-textarea-actions");
    expect(actions?.firstElementChild).toBe(expand);
    expect(
      within(actions as HTMLElement).getByRole("button", { name: "Insert variable" }),
    ).toBeInTheDocument();
    const css = readFileSync(resolve(process.cwd(), "src/styles/editor-inspector.css"), "utf8");
    expect(css).toMatch(/\.inspector-textarea-actions\s*{[^}]*flex-direction:\s*column/);
  });

  it("leaves small single-line inputs without an expand affordance", () => {
    render(<Inspector node={shell} issues={[]} onPatch={() => {}} />);
    expect(screen.queryByTestId("inspector-shell-timeout-expand")).toBeNull();
  });

  it("keeps the variable picker overlay CSS so portaled popovers stay above the canvas", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/editor-inspector.css"), "utf8");
    // Input-wrap layout the expanded and picker buttons rely on.
    expect(css).toMatch(/\.inspector-input-wrap\s*{/);
    // Portaled overlay tokens: fixed positioning above canvas stacking.
    expect(css).toMatch(/\.variable-picker-pop\s*{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.variable-picker-pop\s*{[^}]*z-index:\s*1000/);
    expect(css).toMatch(/\.variable-picker-pop\s*{[^}]*--ins-field/);
    // Picker list/item styles the popover renders into.
    expect(css).toMatch(/\.variable-picker-list\s*{/);
    expect(css).toMatch(/\.variable-picker-item\s*{/);
    expect(css).toMatch(/\.variable-picker-btn\s*{/);
    // Expand affordance and editor sizing.
    expect(css).toMatch(/\.inspector-expand-btn\s*{/);
    expect(css).toMatch(/\.expand-editor-textarea\s*{/);
  });
});
