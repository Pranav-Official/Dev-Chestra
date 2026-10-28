import { EVENT_TYPES, type EventEnvelope, type RunId } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import { describeEvent, eventFilterMatch } from "../src/run/describeEvent.js";

function event(type: string): EventEnvelope {
  return {
    id: 1,
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId,
    ts: "2026-01-01T00:00:00.000Z",
    path: "agent" as EventEnvelope["path"],
    type,
    actor: "engine",
    v: 1,
    payload: {},
  } as EventEnvelope;
}

describe("describeEvent", () => {
  it("has a human sentence for every known event type", () => {
    for (const type of EVENT_TYPES) {
      const text = describeEvent(event(type));
      expect(text.length).toBeGreaterThan(3);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("[object Object]");
    }
  });

  it("does not echo arbitrary payload text for an unknown type", () => {
    const injected = describeEvent({
      ...event("future.event"),
      payload: { message: "<img src=x onerror=alert(1)>" },
    });
    expect(injected).not.toContain("<img");
    expect(injected).toContain("future event");
  });

  it("filters errors, supervisor and quota events", () => {
    expect(eventFilterMatch(event("node.output.rejected"), "errors")).toBe(true);
    expect(eventFilterMatch(event("error.logged"), "errors")).toBe(true);
    expect(eventFilterMatch(event("run.started"), "errors")).toBe(false);
    expect(eventFilterMatch(event("supervisor.woke"), "supervisor")).toBe(true);
    expect(eventFilterMatch(event("checkpoint.closed"), "supervisor")).toBe(true);
    expect(eventFilterMatch(event("quota.blocked"), "quota")).toBe(true);
    expect(eventFilterMatch(event("node.usage"), "quota")).toBe(false);
    expect(eventFilterMatch(event("run.started"), "all")).toBe(true);
  });
});
