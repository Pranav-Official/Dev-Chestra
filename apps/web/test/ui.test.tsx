import type { EventEnvelope, RunId } from "@devchestra/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventsPanel } from "../src/run/EventsPanel.js";
import { ReplayBar } from "../src/run/ReplayBar.js";
import { JsonView } from "../src/ui/JsonView.js";
import { StatusPill } from "../src/ui/StatusPill.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

function event(id: number, type = "run.started", payload: unknown = {}): EventEnvelope {
  return {
    id,
    runId: RUN_ID,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    path: "agent" as EventEnvelope["path"],
    type,
    actor: "engine",
    v: 1,
    payload,
  } as EventEnvelope;
}

describe("StatusPill", () => {
  it("always shows an icon and human text, not color alone", () => {
    const { container } = render(<StatusPill status="waiting_quota" testId="status" />);
    expect(screen.getByTestId("status")).toHaveTextContent("Waiting for quota");
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("JsonView", () => {
  it("renders agent-authored HTML as literal text", () => {
    const { container } = render(
      <JsonView value={{ summary: '<img src=x onerror="alert(1)">' }} testId="json" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("json").textContent).toContain("<img src=x");
  });
});

describe("EventsPanel", () => {
  it("bounds the DOM window and pages through a large event history", () => {
    const events = Array.from({ length: 250 }, (_, index) => event(index + 1));
    render(
      <EventsPanel events={events} upTo={250} selectedEventId={null} onSelect={() => undefined} />,
    );
    expect(screen.getAllByTestId(/event-row-/)).toHaveLength(100);
    expect(screen.getByTestId("event-row-250")).toBeInTheDocument();
    expect(screen.queryByTestId("event-row-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(screen.queryByTestId("event-row-250")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(screen.getByTestId("event-row-1")).toBeInTheDocument();
  });

  it("escapes untrusted event text and filters error rows", () => {
    const events = [
      event(1, "error.logged", {
        code: "E_INTERNAL",
        message: '<img src=x onerror="alert(1)">',
      }),
      event(2, "run.started", {}),
    ];
    const onSelect = vi.fn();
    const { container } = render(
      <EventsPanel events={events} upTo={2} selectedEventId={null} onSelect={onSelect} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Errors" }));
    expect(screen.getByTestId("event-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("event-row-2")).toBeNull();
    fireEvent.click(screen.getByTestId("event-row-1"));
    expect(onSelect).toHaveBeenCalledWith(events[0]);
  });
});

describe("ReplayBar", () => {
  it("exposes an event-id slider and returns to live at the end", () => {
    const events = [event(10), event(20), event(30)];
    const onChange = vi.fn();
    render(
      <ReplayBar
        events={events}
        replayAt={20}
        headEventId={30}
        terminal={false}
        onChange={onChange}
      />,
    );
    const slider = screen.getByTestId("replay-scrubber");
    expect(slider).toHaveAttribute("aria-valuetext", expect.stringContaining("Event 20 of 30"));
    fireEvent.change(slider, { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledWith(10);
    fireEvent.change(slider, { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
