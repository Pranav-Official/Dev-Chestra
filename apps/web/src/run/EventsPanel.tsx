import type { EventEnvelope } from "@relay/core";
import { useEffect, useMemo, useState } from "react";
import { formatEventTime } from "../ui/format.js";
import {
  describeEvent,
  type EventFilter,
  eventFilterMatch,
  eventTypeLabel,
} from "./describeEvent.js";

const PAGE_SIZE = 100;

const FILTERS: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "errors", label: "Errors" },
  { value: "supervisor", label: "Supervisor" },
  { value: "quota", label: "Quota" },
];

export function EventsPanel({
  events,
  upTo,
  selectedEventId,
  onSelect,
}: {
  events: EventEnvelope[];
  upTo: number;
  selectedEventId: number | null;
  onSelect: (event: EventEnvelope) => void;
}) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [page, setPage] = useState(0);

  const visible = useMemo(
    () =>
      events
        .filter((event) => event.id <= upTo && eventFilterMatch(event, filter))
        .slice()
        .reverse(),
    [events, upTo, filter],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the page window when the filter or cursor changes
  useEffect(() => {
    setPage(0);
  }, [filter, upTo]);

  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const rows = visible.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div data-testid="events-panel">
      <fieldset className="filters">
        <legend className="sr-only">Event filters</legend>
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`chip${filter === item.value ? " on" : ""}`}
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
        <span className="faint" style={{ marginLeft: "auto", alignSelf: "center" }}>
          {visible.length} events
        </span>
      </fieldset>
      <div className="event-list" data-testid="event-list">
        {rows.length === 0 ? (
          <p className="empty">No events match.</p>
        ) : (
          rows.map((event) => (
            <button
              type="button"
              key={event.id}
              className="event-row"
              data-testid={`event-row-${event.id}`}
              data-event-id={event.id}
              aria-pressed={selectedEventId === event.id}
              style={
                selectedEventId === event.id
                  ? { background: "var(--accent-soft)", margin: "0 -6px", padding: "7px 6px" }
                  : undefined
              }
              onClick={() => onSelect(event)}
            >
              <span className="time">{formatEventTime(event.ts)}</span>
              <span>
                <span className="row wrap" style={{ gap: 6 }}>
                  <span className="path">{event.path || "run"}</span>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {eventTypeLabel(event.type)}
                  </span>
                </span>
                <span className="msg">{describeEvent(event)}</span>
              </span>
            </button>
          ))
        )}
      </div>
      {pageCount > 1 ? (
        <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            disabled={page === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            Newer
          </button>
          <span className="faint">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
          >
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
