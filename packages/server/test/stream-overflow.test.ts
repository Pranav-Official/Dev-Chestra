import { afterEach, describe, expect, it } from "vitest";
import { closeAll, largeEvents, openHarness, waitFor } from "./stream-helpers.js";

afterEach(async () => {
  await closeAll();
});

describe("run SSE overflow over real HTTP", () => {
  it("emits overflow then closes for a slow TCP reader with a small queue", async () => {
    const harness = await openHarness({ queueLimit: 2 });
    largeEvents(harness.store, harness.runId, 120);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await fetch(
        `${harness.server.url}/api/runs/${harness.runId}/stream?after=0`,
        {
          signal: abort.signal,
        },
      );
      expect(response.status).toBe(200);

      await waitFor(
        () => harness.hub.runSubscriberCount(harness.runId) === 0,
        5_000,
        "overflow closed the run stream",
      );

      const text = await response.text();
      expect(text).toContain("event: overflow");
      expect(text).not.toContain("event: snapshot");
      const overflow = text.lastIndexOf("event: overflow");
      const dataStart = text.indexOf("data: ", overflow);
      const dataEnd = text.indexOf("\n\n", dataStart);
      const data = JSON.parse(text.slice(dataStart + 6, dataEnd)) as { lastEventId: number };
      expect(Number.isSafeInteger(data.lastEventId)).toBe(true);
      expect(data.lastEventId).toBeGreaterThanOrEqual(0);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }

    expect(harness.hub.counts()).toEqual({ runs: 0, global: 0 });
  });
});
