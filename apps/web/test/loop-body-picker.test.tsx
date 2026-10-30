import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Graph } from "@devchestra/schema";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import { createDefaultNode } from "../src/editor/model/graph.js";

function workflow(): { graph: Graph; loopId: string } {
  const loop = createDefaultNode("loop", []) as unknown as {
    id: string;
    type: "loop";
    name: string;
    body: Graph;
  };
  const graph = {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "fetch", type: "agent", name: "Fetch", cli: "pi", prompt: "hi", output: { type: "object", properties: { title: { type: "string" } } }, permissions: { network: false, write: [] } },
      loop,
      { id: "end", type: "end", name: "End", status: "success", result: "refine" },
    ],
    edges: [
      { id: "e1", from: "start", to: "fetch" },
      { id: "e2", from: "fetch", to: loop.id },
      { id: "e3", from: loop.id, to: "end" },
    ],
  } as unknown as Graph;
  return { graph, loopId: loop.id };
}

async function openBody() {
  fireEvent.click(screen.getByTestId("loop-body-open"));
  const dialog = screen.getByTestId("loop-body-dialog");
  await waitFor(() => expect(dialog).toHaveAttribute("open"));
  return dialog;
}

describe("loop body picker scope", () => {
  it("uses the local draft and exposes parents only via loop.parent", async () => {
    const { graph, loopId } = workflow();
    const loop = graph.nodes.find((n) => n.id === loopId)!;
    const onPatch = vi.fn();
    render(<Inspector node={loop as never} graph={graph as never} issues={[]} onPatch={onPatch} loopBodyOpenRequested onLoopBodyOpenHandled={() => {}} />);
    await openBody();
    // Select the draft end node; its result picker sees the draft scope.
    fireEvent.click(screen.getByTestId("ed-node-done"));
    const inspector = screen.getByTestId("loop-body-inspector");
    const result = within(inspector).getByTestId("inspector-end-result");
    expect(result).toBeInTheDocument();
    fireEvent.click(within(inspector).getByTestId("inspector-end-result-variables"));
    const pop = document.querySelector(".variable-picker-pop")!;
    expect(pop.textContent).toContain("Loop parent");
    // Bare parent references are discoverable but disabled in the body.
    const fetchId = Array.from((pop as HTMLElement).querySelectorAll(".variable-picker-node-id")).find((el) => el.textContent === "fetch")!;
    const fetchGroup = fetchId.closest(".variable-picker-group")!;
    for (const b of within(fetchGroup as HTMLElement).getAllByRole("button").filter((bb) => (bb as HTMLElement).classList.contains("variable-picker-item"))) {
      expect(b.hasAttribute("disabled")).toBe(true);
    }
    // Parent values are insertable through loop.parent instead (expression field).
    expect(within(pop as HTMLElement).getByTitle("loop.parent.fetch.title")).toBeInTheDocument();
    // Draft catalogue tracks selection: switch to start, whose picker differs.
    fireEvent.click(screen.getByTestId("ed-node-start"));
    expect(screen.getByTestId("loop-body-inspector").textContent).toContain("Start");
    // Cancel discards draft edits; nothing persists.
    fireEvent.click(screen.getByTestId("loop-body-cancel"));
    const dialog = screen.getByTestId("loop-body-dialog");
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("applies draft edits and keeps outer undo intact", async () => {
    const { graph, loopId } = workflow();
    const loop = graph.nodes.find((n) => n.id === loopId)!;
    const onPatch = vi.fn();
    render(<Inspector node={loop as never} graph={graph as never} issues={[]} onPatch={onPatch} loopBodyOpenRequested onLoopBodyOpenHandled={() => {}} />);
    await openBody();
    fireEvent.click(screen.getByTestId("ed-node-done"));
    const inspector = screen.getByTestId("loop-body-inspector");
    const result = within(inspector).getByTestId("inspector-end-result") as HTMLTextAreaElement;
    fireEvent.change(result, { target: { value: "loop.iteration" } });
    expect(screen.getByTestId("loop-body-dirty")).toHaveTextContent("Unapplied changes");
    fireEvent.click(screen.getByTestId("loop-body-apply"));
    expect(onPatch).toHaveBeenCalledTimes(1);
    const patch = (onPatch.mock.calls[0] as unknown[])[1] as { body: Graph };
    expect(patch.body.nodes.find((n) => n.id === "done")).toMatchObject({ result: "loop.iteration" });
    // The committed body still validates: no draft errors block apply.
    expect(screen.queryByTestId("loop-body-errors")).toBeNull();
  });
});
