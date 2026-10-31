import type { EventEnvelope } from "@devchestra/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReplayBar } from "../src/run/ReplayBar.js";

const events = [
  { id: 1, ts: "2026-10-31T09:34:00.000Z", type: "run.created" },
  { id: 2, ts: "2026-10-31T09:34:00.500Z", type: "node.state" },
  { id: 3, ts: "2026-10-31T09:34:01.000Z", type: "run.completed" },
] as unknown as EventEnvelope[];

describe("ReplayBar head label", () => {
  it("says Live at the head of a run that is still going", () => {
    render(
      <ReplayBar
        events={events}
        replayAt={null}
        headEventId={3}
        terminal={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByTestId("back-to-live")).toHaveTextContent("Back to live");
  });

  it("says Final at the head of a finished run, never Live", () => {
    render(
      <ReplayBar
        events={events}
        replayAt={null}
        headEventId={3}
        terminal={true}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByTestId("back-to-live")).toHaveTextContent("Back to final");
  });

  it("shows the event number while replaying a finished run, and returns to the final state", () => {
    const onChange = vi.fn();
    render(
      <ReplayBar
        events={events}
        replayAt={2}
        headEventId={3}
        terminal={true}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Event #2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("back-to-live"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
