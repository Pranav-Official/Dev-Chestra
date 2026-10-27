import type { EventPageResponse } from "@relay/api";
import type { EventEnvelope, RunId } from "@relay/core";
import { describe, expect, it, vi } from "vitest";
import { collectHistory } from "../src/api/history.js";

function event(id: number): EventEnvelope {
  return {
    id,
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId,
    ts: "2026-01-01T00:00:00.000Z",
    path: "" as EventEnvelope["path"],
    type: "future.event",
    actor: "engine",
    v: 1,
    payload: {},
  } as EventEnvelope;
}

function page(events: EventEnvelope[], nextAfter: number, hasMore: boolean): EventPageResponse {
  return { events, nextAfter, hasMore, watermark: 100 };
}

describe("collectHistory", () => {
  it("pages until hasMore is false, including large gaps in ids", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(page([event(10), event(40)], 40, true))
      .mockResolvedValueOnce(page([event(90)], 90, false));
    const events = await collectHistory(load, 90);
    expect(events.map((item) => item.id)).toEqual([10, 40, 90]);
    expect(load).toHaveBeenNthCalledWith(2, 40);
  });

  it("throws rather than silently returning an incomplete prefix", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(page([event(10)], 10, true))
      .mockResolvedValueOnce(page([event(10)], 10, true));
    await expect(collectHistory(load, 100)).rejects.toMatchObject({
      name: "ApiProtocolError",
    });
  });

  it("throws when the bounded replay window is exceeded", async () => {
    const load = vi.fn(async (after: number) => page([event(after + 1)], after + 1, true));
    await expect(collectHistory(load, 10_000, 2)).rejects.toThrow(/bounded/);
  });

  it("returns no history for an empty watermark without calling the server", async () => {
    const load = vi.fn();
    await expect(collectHistory(load, 0)).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
