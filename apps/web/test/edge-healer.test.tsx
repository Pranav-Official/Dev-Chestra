import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
let nodeLookup = new Map<string, { hidden?: boolean; internals: { handleBounds?: unknown } }>();

vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => update,
  useStore: (selector: (state: { nodeLookup: typeof nodeLookup }) => unknown) =>
    selector({ nodeLookup }),
}));

import { EdgeHealer } from "../src/ui/EdgeHealer.js";

function lookup(entries: Record<string, { measured: boolean; hidden?: boolean }>) {
  return new Map(
    Object.entries(entries).map(([id, entry]) => [
      id,
      {
        ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
        internals: entry.measured ? { handleBounds: { source: [], target: [] } } : {},
      },
    ]),
  );
}

describe("EdgeHealer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    update.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing while every visible node has handle positions", () => {
    nodeLookup = lookup({ a: { measured: true }, b: { measured: true } });
    render(<EdgeHealer />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(update).not.toHaveBeenCalled();
  });

  it("asks React Flow to re-measure exactly the nodes that lost their handle positions", () => {
    nodeLookup = lookup({ a: { measured: true }, b: { measured: false }, c: { measured: false } });
    render(<EdgeHealer />);
    act(() => void vi.advanceTimersByTime(100));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(["b", "c"]);
  });

  it("ignores hidden nodes", () => {
    nodeLookup = lookup({ a: { measured: false, hidden: true } });
    render(<EdgeHealer />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(update).not.toHaveBeenCalled();
  });

  it("retries a few times with backoff, then gives up instead of spinning", () => {
    nodeLookup = lookup({ a: { measured: false } });
    render(<EdgeHealer />);
    // each retry is scheduled by a state update, so let React flush between steps
    for (let step = 0; step < 40; step += 1) act(() => void vi.advanceTimersByTime(2000));
    expect(update.mock.calls.length).toBeGreaterThan(1);
    expect(update.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("stops asking once the nodes are measured", () => {
    nodeLookup = lookup({ a: { measured: false } });
    const view = render(<EdgeHealer />);
    act(() => void vi.advanceTimersByTime(50));
    expect(update).toHaveBeenCalledTimes(1);
    nodeLookup = lookup({ a: { measured: true } });
    view.rerender(<EdgeHealer />);
    update.mockClear();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(update).not.toHaveBeenCalled();
  });
});
