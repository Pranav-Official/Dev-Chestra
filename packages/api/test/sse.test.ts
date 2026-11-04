import { emptyRunView } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import {
  ApiProtocolError,
  ApiTransportError,
  parseGlobalStreamEvent,
  parseRunStreamEvent,
  readSse,
  type SseEvent,
  SseParser,
} from "../src/index.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function event(patch: Partial<SseEvent> & Pick<SseEvent, "event" | "data">): SseEvent {
  return { id: null, retry: null, ...patch };
}

const envelope = {
  id: 42,
  runId: RUN_ID,
  ts: "2026-10-27T00:00:00.000Z",
  path: "",
  type: "run.started",
  actor: "engine",
  v: 1,
  payload: {},
};

describe("SseParser", () => {
  it("parses frames split across arbitrary chunks", () => {
    const parser = new SseParser();
    const first = parser.push("eve");
    const second = parser.push('nt: run\nid: 7\ndata: {"a":1}\n');
    const third = parser.push("\n");
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([{ id: "7", event: "run", data: '{"a":1}', retry: null }]);
  });

  it("ignores comment heartbeats", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\n\n")).toEqual([]);
  });

  it("joins multi-line data and strips one leading space", () => {
    const parser = new SseParser();
    const frames = parser.push("event: run\ndata: line one\ndata:  line two\n\n");
    expect(frames).toEqual([{ id: null, event: "run", data: "line one\n line two", retry: null }]);
  });

  it("handles CRLF and a trailing frame at end()", () => {
    const parser = new SseParser();
    expect(parser.push("id: 1\r\nevent: run\r\ndata: x\r\n")).toEqual([]);
    expect(parser.end()).toEqual([{ id: "1", event: "run", data: "x", retry: null }]);
  });

  it("classifies response body read failures as transport errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("disconnected"));
      },
    });
    await expect(readSse(body).next()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("reads a stream and preserves frame boundaries", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: run\n"));
        controller.enqueue(encoder.encode("id: 1\ndata: a\n\n: ping\n\n"));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of readSse(body)) frames.push(frame);
    expect(frames).toEqual([{ id: "1", event: "run", data: "a", retry: null }]);
  });
});

describe("parseRunStreamEvent", () => {
  it("parses a run frame with a numeric id and EventEnvelope data", () => {
    const message = parseRunStreamEvent(
      event({ event: "run", id: "42", data: JSON.stringify(envelope) }),
    );
    expect(message).toEqual({ event: "run", id: 42, data: envelope });
  });

  it("parses the bootstrap snapshot control message", () => {
    const message = parseRunStreamEvent(
      event({
        event: "snapshot",
        data: JSON.stringify({ runId: RUN_ID, view: emptyRunView(), watermark: 0 }),
      }),
    );
    expect(message).toMatchObject({ event: "snapshot", data: { runId: RUN_ID, watermark: 0 } });
  });

  it("parses overflow as a separate control message", () => {
    const message = parseRunStreamEvent(
      event({ event: "overflow", data: JSON.stringify({ lastEventId: 42 }) }),
    );
    expect(message).toEqual({ event: "overflow", data: { lastEventId: 42 } });
  });

  it("ignores unknown event names for forward compatibility", () => {
    expect(parseRunStreamEvent(event({ event: "future", data: "{}" }))).toBeNull();
  });

  it("rejects a run frame without a numeric id", () => {
    expect(() =>
      parseRunStreamEvent(event({ event: "run", id: null, data: JSON.stringify(envelope) })),
    ).toThrow(ApiProtocolError);
  });

  it("rejects malformed JSON and malformed envelopes", () => {
    expect(() => parseRunStreamEvent(event({ event: "run", id: "1", data: "{" }))).toThrow(
      ApiProtocolError,
    );
    expect(() =>
      parseRunStreamEvent(event({ event: "run", id: "1", data: JSON.stringify({ nope: true }) })),
    ).toThrow(ApiProtocolError);
  });
});

describe("parseGlobalStreamEvent", () => {
  const cases = {
    "run.status": {
      runId: RUN_ID,
      projectId: "project",
      workflowId: "workflow",
      status: "running",
      runNumber: 1,
    },
    inbox: {
      changed: true,
      counts: { approvals: 1, checkpoints: 0, quota: 0, recommendations: 0, failed: 0 },
    },
    provider: { name: "claude", status: "blocked", resumeAt: 1000, reason: "quota" },
    notification: { level: "info", message: "hello", runId: RUN_ID },
    config: { changed: true },
  } as const;

  it.each(Object.entries(cases))("parses %s hints", (name, data) => {
    const message = parseGlobalStreamEvent(event({ event: name, data: JSON.stringify(data) }));
    expect(message).toMatchObject({ event: name });
  });

  it("ignores unknown global event names", () => {
    expect(parseGlobalStreamEvent(event({ event: "nope", data: "{}" }))).toBeNull();
  });

  it("rejects malformed hint data", () => {
    expect(() => parseGlobalStreamEvent(event({ event: "inbox", data: "{}" }))).toThrow(
      ApiProtocolError,
    );
  });
});
