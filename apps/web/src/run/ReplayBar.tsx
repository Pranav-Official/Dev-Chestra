import type { EventEnvelope } from "@devchestra/core";
import { ChevronLeft, ChevronRight, Radio } from "lucide-react";
import { formatEventTime } from "../ui/format.js";

export function ReplayBar({
  events,
  replayAt,
  headEventId,
  onChange,
}: {
  events: EventEnvelope[];
  replayAt: number | null;
  headEventId: number;
  onChange: (eventId: number | null) => void;
}) {
  const lastIndex = events.length - 1;
  const selectedIndex =
    replayAt === null ? lastIndex : events.findIndex((event) => event.id === replayAt);
  const value = selectedIndex < 0 ? lastIndex : selectedIndex;
  const selected = events[value];
  const atLive = replayAt === null || value === lastIndex;
  const canReplay = events.length > 0;

  const move = (delta: number): void => {
    if (!canReplay) return;
    const start = value < 0 ? 0 : value;
    const next = Math.max(0, Math.min(lastIndex, start + delta));
    if (next === lastIndex) onChange(null);
    else {
      const event = events[next];
      if (event !== undefined) onChange(event.id);
    }
  };

  return (
    <div className="replay-bar" data-testid="replay-bar">
      <button
        type="button"
        className="btn ghost icon sm"
        onClick={() => move(-1)}
        disabled={!canReplay || value <= 0}
        aria-label="Previous event"
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <div className="replay-track">
        <input
          type="range"
          min={0}
          max={Math.max(0, lastIndex)}
          step={1}
          value={value < 0 ? 0 : value}
          data-testid="replay-scrubber"
          aria-label="Replay position"
          aria-valuetext={
            selected === undefined
              ? "Live"
              : `Event ${selected.id} of ${headEventId}, ${selected.type}`
          }
          disabled={!canReplay}
          onChange={(change) => {
            const index = Number(change.target.value);
            if (index >= lastIndex) onChange(null);
            else {
              const event = events[index];
              if (event !== undefined) onChange(event.id);
            }
          }}
        />
        <button
          type="button"
          className="btn ghost icon sm"
          onClick={() => move(1)}
          disabled={!canReplay || value >= lastIndex}
          aria-label="Next event"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="back-to-live"
          disabled={atLive}
          onClick={() => onChange(null)}
        >
          <Radio size={12} aria-hidden="true" />
          Back to live
        </button>
      </div>
      <div className="replay-meta">
        <div className="v">{atLive ? "Live" : `Event #${replayAt}`}</div>
        <div className="t">
          {selected === undefined
            ? "No events yet"
            : `${formatEventTime(selected.ts)} · ${events.length} events`}
        </div>
      </div>
    </div>
  );
}
