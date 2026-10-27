import type { EventEnvelope, Path, RunId } from "@relay/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreStreamPort, type StreamStorePort } from "../src/stream/index.js";
import {
  appendMany,
  closeAll,
  closeSse,
  type Harness,
  openHarness,
  openSse,
  parseData,
  type SseFrame,
  waitFor,
} from "./stream-helpers.js";

afterEach(async () => {
  await closeAll();
});

function createRun(harness: Harness, workflowId: string): RunId {
  return harness.store.runs.create({
    projectId: "project-1",
    workflowId,
    workflowHash: `hash-${workflowId}`,
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
  }).runId;
}

function runIds(events: readonly EventEnvelope[]): number[] {
  return events.map((event) => event.id);
}

function frameIds(frames: readonly SseFrame[]): number[] {
  return frames.map((frame) => Number(frame.id));
}

describe("run SSE replay and handoff", () => {
  it("pages a >500 event backlog after=0 without a snapshot frame", async () => {
    const harness = await openHarness();
    appendMany(harness.store, harness.runId, 620);

    const expected = runIds(harness.store.events.list(harness.runId));
    expect(expected.length).toBeGreaterThan(500);

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`);
    try {
      const frames = await sse.client.collect(expected.length);
      expect(frames.every((frame) => frame.event === "run")).toBe(true);
      expect(frameIds(frames)).toEqual(expected);
      expect(frames.some((frame) => frame.event === "snapshot")).toBe(false);
    } finally {
      await closeSse(sse);
    }
  });

  it("bootstraps a snapshot with an exact watermark, then live events", async () => {
    const harness = await openHarness();
    appendMany(harness.store, harness.runId, 12);
    const before = harness.store.events.list(harness.runId);
    const watermark = before.at(-1)?.id ?? 0;

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream`);
    try {
      const snapshotFrame = await sse.client.nextMeaningful();
      expect(snapshotFrame.event).toBe("snapshot");
      expect(snapshotFrame.id).toBeNull();
      const snapshot = parseData<{
        runId: string;
        view: { lastEventId: number };
        watermark: number;
      }>(snapshotFrame);
      expect(snapshot.runId).toBe(harness.runId);
      expect(snapshot.watermark).toBe(watermark);
      expect(snapshot.view.lastEventId).toBe(watermark);

      appendMany(harness.store, harness.runId, 1, { prefix: "after-snapshot" });
      const live = await sse.client.nextMeaningful();
      expect(live.event).toBe("run");
      expect(Number(live.id)).toBeGreaterThan(watermark);
    } finally {
      await closeSse(sse);
    }
  });

  it("captures an event committed between subscription and snapshot read", async () => {
    let pausedId = 0;
    let resumedId = 0;
    const harness = await openHarness({
      port: (store) => {
        const base = createStoreStreamPort(store);
        const port: StreamStorePort = {
          ...base,
          snapshot(runId) {
            const paused = store.events.append(runId as RunId, [
              {
                runId: runId as RunId,
                path: "" as Path,
                type: "run.paused",
                actor: "user",
                payload: { reason: "user" },
              },
            ])[0];
            pausedId = paused?.id ?? 0;
            const snapshot = base.snapshot(runId);
            const resumed = store.events.append(runId as RunId, [
              {
                runId: runId as RunId,
                path: "" as Path,
                type: "run.resumed",
                actor: "user",
                payload: { reason: "handoff" },
              },
            ])[0];
            resumedId = resumed?.id ?? 0;
            return snapshot;
          },
        };
        return port;
      },
    });

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream`);
    try {
      const snapshotFrame = await sse.client.nextMeaningful();
      expect(snapshotFrame.event).toBe("snapshot");
      const snapshot = parseData<{
        watermark: number;
        view: { status: string };
      }>(snapshotFrame);
      expect(snapshot.watermark).toBe(pausedId);
      expect(snapshot.view.status).toBe("paused");

      const live = await sse.client.nextMeaningful();
      expect(live.event).toBe("run");
      expect(Number(live.id)).toBe(resumedId);
      expect(resumedId).toBeGreaterThan(pausedId);
    } finally {
      await closeSse(sse);
    }
  });

  it("replays a cursor stream across an event committed during the handoff", async () => {
    const harness = await openHarness({
      port: (store) => {
        const base = createStoreStreamPort(store);
        return {
          ...base,
          snapshot(runId) {
            store.events.append(runId as RunId, [
              {
                runId: runId as RunId,
                path: "" as Path,
                type: "run.paused",
                actor: "user",
                payload: { reason: "handoff" },
              },
            ]);
            const snapshot = base.snapshot(runId);
            store.events.append(runId as RunId, [
              {
                runId: runId as RunId,
                path: "" as Path,
                type: "run.resumed",
                actor: "user",
                payload: { reason: "handoff" },
              },
            ]);
            return snapshot;
          },
        };
      },
    });

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`);
    try {
      const frames = await sse.client.collect(4);
      expect(frames.every((frame) => frame.event === "run")).toBe(true);
      expect(frameIds(frames)).toEqual(runIds(harness.store.events.list(harness.runId)));
      const last = frames.at(-1);
      expect(last).toBeDefined();
      const envelope = parseData<{ type: string }>(last as SseFrame);
      expect(envelope.type).toBe("run.resumed");
    } finally {
      await closeSse(sse);
    }
  });

  it("delivers consecutive node.usage events without coalescing", async () => {
    const harness = await openHarness();
    for (let index = 0; index < 2; index += 1) {
      harness.store.events.append(harness.runId, [
        {
          runId: harness.runId,
          path: "" as Path,
          type: "node.usage",
          actor: "engine",
          payload: {
            attempt: 1,
            generation: 1,
            tokensIn: index + 1,
            tokensOut: index + 1,
            costSource: "reported",
          },
        },
      ]);
    }

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`);
    try {
      const frames = await sse.client.collect(4);
      const usage = frames
        .map((frame) => parseData<{ type: string; payload: { tokensIn: number } }>(frame))
        .filter((event) => event.type === "node.usage");
      expect(usage).toHaveLength(2);
      expect(usage.map((event) => event.payload.tokensIn)).toEqual([1, 2]);
      expect(new Set(frameIds(frames)).size).toBe(4);
    } finally {
      await closeSse(sse);
    }
  });

  it("sends heartbeat comments with no id", async () => {
    const harness = await openHarness({ heartbeatMs: 10 });
    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream`);
    try {
      expect((await sse.client.nextMeaningful()).event).toBe("snapshot");
      let heartbeat: SseFrame | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const frame = await sse.client.next(1_000);
        if (frame?.heartbeat === true) {
          heartbeat = frame;
          break;
        }
      }
      expect(heartbeat?.raw.trim()).toBe(": heartbeat");
      expect(heartbeat?.id).toBeNull();
    } finally {
      await closeSse(sse);
    }
  });

  it("gives Last-Event-ID precedence over ?after and rejects malformed headers", async () => {
    const harness = await openHarness();
    appendMany(harness.store, harness.runId, 20);
    const all = harness.store.events.list(harness.runId);
    const cursor = all[10]?.id ?? 0;
    const expected = all.filter((event) => event.id > cursor).map((event) => event.id);

    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`, {
      "last-event-id": String(cursor),
    });
    try {
      const frames = await sse.client.collect(expected.length);
      expect(frameIds(frames)).toEqual(expected);
      expect(frames.every((frame) => Number(frame.id) > cursor)).toBe(true);
    } finally {
      await closeSse(sse);
    }

    const bad = await fetch(`${harness.server.url}/api/runs/${harness.runId}/stream?after=0`, {
      headers: { "last-event-id": "not-a-number" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "E_VALIDATION" } });
  });

  it("replays exactly from the last applied id across a disconnect", async () => {
    const harness = await openHarness();
    appendMany(harness.store, harness.runId, 25);

    const first = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`);
    let lastId = 0;
    const applied: number[] = [];
    try {
      const frames = await first.client.collect(6);
      applied.push(...frameIds(frames));
      lastId = applied.at(-1) ?? 0;
    } finally {
      await closeSse(first);
    }

    appendMany(harness.store, harness.runId, 3, { prefix: "while-offline" });
    const all = harness.store.events.list(harness.runId);
    const expected = all.filter((event) => event.id > lastId).map((event) => event.id);

    const second = await openSse(harness, `/api/runs/${harness.runId}/stream`, {
      "last-event-id": String(lastId),
    });
    try {
      const frames = await second.client.collect(expected.length);
      const resumed = frameIds(frames);
      expect(resumed).toEqual(expected);
      expect(new Set([...applied, ...resumed]).size).toBe(all.length);
      expect([...applied, ...resumed].sort((a, b) => a - b)).toEqual(runIds(all));
    } finally {
      await closeSse(second);
    }
  });
});

describe("run cursor validation across global id gaps", () => {
  it("handles first-event and post-gap cursors and rejects a foreign run cursor", async () => {
    const harness = await openHarness();
    const runB = createRun(harness, "workflow-2");
    appendMany(harness.store, harness.runId, 2, { prefix: "a1" });
    appendMany(harness.store, runB, 2, { prefix: "b1" });
    appendMany(harness.store, harness.runId, 2, { prefix: "a2" });
    appendMany(harness.store, runB, 2, { prefix: "b2" });
    appendMany(harness.store, harness.runId, 2, { prefix: "a3" });

    const aEvents = harness.store.events.list(harness.runId);
    const bEvents = harness.store.events.list(runB);
    const aIds = runIds(aEvents);
    const bIds = runIds(bEvents);
    expect(aIds).toHaveLength(8);
    expect(bIds).toHaveLength(6);
    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
    expect(aIds).toEqual([...aIds].sort((left, right) => left - right));
    expect(bIds).toEqual([...bIds].sort((left, right) => left - right));

    const first = await openSse(harness, `/api/runs/${harness.runId}/stream?after=0`);
    try {
      expect(frameIds(await first.client.collect(aIds.length))).toEqual(aIds);
    } finally {
      await closeSse(first);
    }

    const firstEventCursor = aIds[0] ?? 0;
    const firstEvent = await openSse(
      harness,
      `/api/runs/${harness.runId}/stream?after=${firstEventCursor}`,
    );
    try {
      expect(frameIds(await firstEvent.client.collect(aIds.length - 1))).toEqual(
        aIds.filter((id) => id > firstEventCursor),
      );
    } finally {
      await closeSse(firstEvent);
    }

    const postGapCursor = aIds[2] ?? 0;
    const postGap = await openSse(
      harness,
      `/api/runs/${harness.runId}/stream?after=${postGapCursor}`,
    );
    try {
      expect(frameIds(await postGap.client.collect(aIds.length - 3))).toEqual(
        aIds.filter((id) => id > postGapCursor),
      );
    } finally {
      await closeSse(postGap);
    }

    for (const foreign of [bIds[0] ?? 0, bIds[2] ?? 0]) {
      const res = await fetch(
        `${harness.server.url}/api/runs/${harness.runId}/stream?after=${foreign}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "E_VALIDATION" } });
    }

    const ahead = await fetch(
      `${harness.server.url}/api/runs/${harness.runId}/stream?after=${(aIds.at(-1) ?? 0) + 999}`,
    );
    expect(ahead.status).toBe(400);

    const missing = await fetch(`${harness.server.url}/api/runs/does-not-exist/stream?after=0`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "E_NOT_FOUND" } });
  });
});

describe("hub lifecycle and global hints", () => {
  it("keeps one bus subscription, cleans connections, and closes the subscription", async () => {
    let listeners = 0;
    const harness = await openHarness({
      port: (store) => {
        const base = createStoreStreamPort(store);
        return {
          ...base,
          subscribe(listener) {
            listeners += 1;
            const unsubscribe = base.subscribe(listener);
            return () => {
              listeners -= 1;
              unsubscribe();
            };
          },
        };
      },
    });
    expect(listeners).toBe(1);

    const runSse = await openSse(harness, `/api/runs/${harness.runId}/stream`);
    const globalSse = await openSse(harness, "/api/stream");
    try {
      expect((await runSse.client.nextMeaningful()).event).toBe("snapshot");
      await waitFor(
        () => harness.hub.counts().runs === 1 && harness.hub.counts().global === 1,
        2_000,
        "connections registered",
      );
      expect(harness.hub.runSubscriberCount(harness.runId)).toBe(1);
      expect(listeners).toBe(1);
    } finally {
      await closeSse(runSse);
      await closeSse(globalSse);
    }

    await waitFor(
      () => harness.hub.counts().runs === 0 && harness.hub.counts().global === 0,
      2_000,
      "connections cleaned up",
    );
    expect(listeners).toBe(1);

    harness.hub.close();
    expect(listeners).toBe(0);
  });

  it("ends active streams on shutdown and leaves no subscribers", async () => {
    const harness = await openHarness();
    const sse = await openSse(harness, `/api/runs/${harness.runId}/stream`);
    try {
      expect((await sse.client.nextMeaningful()).event).toBe("snapshot");
      harness.hub.close();
      expect(await sse.client.next(2_000)).toBeNull();
      expect(harness.hub.counts()).toEqual({ runs: 0, global: 0 });
    } finally {
      await closeSse(sse);
    }
  });

  it("sends typed invalidation hints only on the global stream", async () => {
    const harness = await openHarness();
    const sse = await openSse(harness, "/api/stream");
    try {
      harness.store.events.append(harness.runId, [
        {
          runId: harness.runId,
          path: "" as Path,
          type: "run.paused",
          actor: "user",
          payload: { reason: "user" },
        },
      ]);

      const statusFrame = await sse.client.nextMeaningful();
      expect(statusFrame.event).toBe("run.status");
      expect(statusFrame.id).toBeNull();
      const status = parseData<{
        runId: string;
        projectId: string;
        workflowId: string;
        status: string;
        runNumber: number;
      }>(statusFrame);
      expect(status).toMatchObject({
        runId: harness.runId,
        projectId: "project-1",
        workflowId: "workflow-1",
        status: "paused",
        runNumber: 1,
      });

      harness.store.events.append(harness.runId, [
        {
          runId: harness.runId,
          path: "" as Path,
          type: "approval.requested",
          actor: "engine",
          payload: { message: "Review", irreversible: false, autoApprove: false },
        },
      ]);

      const inbox = await sse.client.nextMeaningful();
      expect(inbox.event).toBe("inbox");
      expect(inbox.id).toBeNull();
      expect(parseData<{ changed: boolean }>(inbox)).toEqual({ changed: true });

      const notification = await sse.client.nextMeaningful();
      expect(notification.event).toBe("notification");
      expect(notification.id).toBeNull();
      expect(parseData<{ message: string }>(notification).message).toBe("Approval requested");
    } finally {
      await closeSse(sse);
    }
  });
});
