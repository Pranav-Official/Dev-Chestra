import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

describe("Loop body dialog", () => {
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
