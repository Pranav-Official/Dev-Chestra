import type { Graph } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

describe("Loop body dialog", () => {
  it.each(["loop", "foreach"])(
    "preserves the %s body when an expanded agent prompt is applied and closed",
    (type) => {
      const node = createDefaultNode(type, []);
      if (node.type !== "loop" && node.type !== "foreach") throw new Error("Expected controller");
      const agent = createDefaultNode("agent", node.body.nodes);
      if (agent.type !== "agent") throw new Error("Expected agent");
      agent.prompt = "Original prompt";
      node.body.nodes.push(agent);
      node.body.edges = [
        { id: "to-agent", from: "start", to: agent.id },
        { id: "to-end", from: agent.id, to: "done" },
      ];
      const onPatch = vi.fn();
      render(<Inspector node={node} issues={[]} onPatch={onPatch} />);
      fireEvent.click(screen.getByTestId(`${type}-body-open`));
      const bodyDialog = screen.getByTestId(`${type}-body-dialog`);
      fireEvent.click(screen.getByTestId(`ed-node-${agent.id}`));
      fireEvent.click(screen.getByTestId("inspector-agent-prompt-expand"));
      const promptDialog = screen.getByTestId("inspector-agent-prompt-expanded-dialog");
      fireEvent.change(screen.getByTestId("inspector-agent-prompt-expanded"), {
        target: { value: "Updated prompt\nSecond line" },
      });
      fireEvent.click(screen.getByTestId("inspector-agent-prompt-expanded-apply"));
      // jsdom's dialog fallback does not emit the native event after closing.
      fireEvent(promptDialog, new Event("close", { bubbles: false }));
      expect(promptDialog).not.toHaveAttribute("open");
      expect(bodyDialog).toHaveAttribute("open");
      expect(screen.getByTestId("inspector-agent-prompt")).toHaveValue(
        "Updated prompt\nSecond line",
      );
      expect(onPatch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId(`${type}-body-apply`));
      expect(onPatch).toHaveBeenCalledOnce();
      const patch = onPatch.mock.calls[0]?.[1] as { body: Graph };
      expect(patch.body.nodes.find((entry) => entry.id === agent.id)).toMatchObject({
        prompt: "Updated prompt\nSecond line",
      });
      expect(bodyDialog).not.toHaveAttribute("open");
    },
  );

  it("consumes open requests, discards cancelled edits, and opens again", async () => {
    const node = createDefaultNode("loop", []);
    const onPatch = vi.fn();
    const onLoopBodyOpenHandled = vi.fn();
    const props = { node, issues: [], onPatch, onLoopBodyOpenHandled };
    const { rerender } = render(<Inspector {...props} loopBodyOpenRequested />);
    const dialog = screen.getByTestId("loop-body-dialog");
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
    expect(dialog).toHaveClass("workspace");
    expect(onLoopBodyOpenHandled).toHaveBeenCalledTimes(1);
    rerender(<Inspector {...props} loopBodyOpenRequested={false} />);
    fireEvent.click(screen.getByTestId("palette-toggle"));
    expect(screen.queryByTestId("palette-add-loop")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-add-shell"));
    expect(screen.getByTestId("loop-body-dirty")).toHaveTextContent("Unapplied changes");
    expect(screen.getByTestId("loop-body-inspector")).toHaveTextContent("Shell");
    fireEvent.click(screen.getByTestId("loop-body-cancel"));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(onPatch).not.toHaveBeenCalled();
    rerender(<Inspector {...props} loopBodyOpenRequested />);
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
    expect(screen.getByTestId("loop-body-dirty")).toHaveTextContent("Body in sync");
    expect(onLoopBodyOpenHandled).toHaveBeenCalledTimes(2);
  });
});
