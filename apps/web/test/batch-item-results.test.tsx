import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { BatchItemResults } from "../src/run/BatchItemResults.js";

afterEach(() => vi.restoreAllMocks());
const page = {
  source: { sourceId: "source", kind: "csv" as const, path: "each", total: 2 },
  items: [{ index: 0, status: "succeeded" as const, path: "each[0]", outputId: "output" }],
  nextCursor: "next",
};

describe("batch item results", () => {
  it("loads bounded metadata first and only retrieves a chosen result", async () => {
    const list = vi.spyOn(api, "listForeachItems").mockResolvedValue(page);
    const preview = vi.spyOn(api, "getRunOutput").mockResolvedValue({
      id: "output",
      hash: "hash",
      bytes: 15,
      truncated: false,
      data: { company: "A" },
      contentType: "json",
    });
    render(<BatchItemResults runId="run" sourceId="source" processed={1} isReplay={false} />);
    await waitFor(() => expect(screen.getByText("Item 1 · succeeded")).toBeInTheDocument());
    expect(list).toHaveBeenCalledWith("run", "source", { limit: 20 }, expect.any(Object));
    expect(preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View result" }));
    await waitFor(() =>
      expect(screen.getByTestId("batch-item-result-preview")).toHaveTextContent("A"),
    );
    expect(preview).toHaveBeenCalledWith("run", "output", expect.any(Object));
  });
  it("paginates and refreshes metadata when item progress changes", async () => {
    const list = vi.spyOn(api, "listForeachItems").mockResolvedValue(page);
    const { rerender } = render(
      <BatchItemResults runId="run" sourceId="source" processed={1} isReplay={false} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next items" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next items" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        "run",
        "source",
        { limit: 20, cursor: "next" },
        expect.any(Object),
      ),
    );
    const before = list.mock.calls.length;
    rerender(<BatchItemResults runId="run" sourceId="source" processed={2} isReplay={false} />);
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });
  it("does not leak future live results into replay", () => {
    const list = vi.spyOn(api, "listForeachItems");
    render(<BatchItemResults runId="run" sourceId="source" processed={0} isReplay />);
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByText(/available in the live view/)).toBeInTheDocument();
  });
});
