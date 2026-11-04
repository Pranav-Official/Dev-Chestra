import {
  ApiTransportError,
  type EventEnvelope,
  type RunDetailResponse,
  type RunStreamMessage,
} from "@devchestra/api";
import { describe, expect, it } from "vitest";
import { WAIT_STILL_RUNNING, type WaitClient, waitExitCode, waitForRun } from "../src/run-wait.js";

type View = { status: string; executions: Record<string, unknown> };

function detail(view: Partial<View>, watermark = 10): RunDetailResponse {
  return {
    run: { id: "run-1", workflowId: "wf", startedAt: 1, endedAt: null },
    view: {
      status: "running",
      pauseReason: null,
      pauseDetail: null,
      pausePath: null,
      budget: { usd: 0, tokens: 0, activeMs: 0, supervisorUsd: 0 },
      errors: [],
      executions: {},
      ...view,
    },
    snapshot: {
      graph: {
        nodes: [
          { id: "start", type: "start" },
          { id: "work", type: "agent" },
          { id: "review", type: "approval" },
        ],
        edges: [],
      },
    },
    watermark,
    workspace: null,
  } as unknown as RunDetailResponse;
}

const event = (id: number, type: string, path: string, payload: Record<string, unknown> = {}) =>
  ({ event: "run", id, data: { id, type, path, payload } }) as unknown as RunStreamMessage;

interface FakeOptions {
  /** Detail returned by successive getRun calls; the last one repeats. */
  details: RunDetailResponse[];
  /** One entry per stream connection: events to emit, or an Error to throw. */
  streams?: (RunStreamMessage[] | Error)[];
  replay?: EventEnvelope[];
}

function fake(options: FakeOptions): WaitClient & { connections: number } {
  let reads = 0;
  const client = {
    connections: 0,
    getRun: async () => options.details[Math.min(reads++, options.details.length - 1)],
    getExecutionTranscript: async () => ({ updatedAt: null, lines: [] }),
    listRunEvents: async () => ({
      events: options.replay ?? [],
      nextAfter: 99,
      hasMore: false,
    }),
    async *streamRunEvents(_run: string, _query: unknown, request: { signal?: AbortSignal }) {
      const script = options.streams?.[client.connections++];
      if (script instanceof Error) throw script;
      for (const message of script ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield message;
      }
      // Stay open like a live stream until the waiter hangs up.
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  return client as unknown as WaitClient & { connections: number };
}

const running = detail({ status: "running" });
const approvalPending = detail({ status: "waiting_approval" });
const base = { timeoutMs: 2000, until: "any" as const, settleMs: 10 };

describe("waitExitCode", () => {
  it("separates finished, failed and still-running", () => {
    expect(waitExitCode("succeeded")).toBe(0);
    expect(waitExitCode("failed")).toBe(1);
    expect(waitExitCode("rejected")).toBe(2);
    expect(waitExitCode("cancelled")).toBe(3);
    expect(waitExitCode("paused")).toBe(5);
    expect(waitExitCode("waiting_approval")).toBe(5);
    expect(waitExitCode("running")).toBe(WAIT_STILL_RUNNING);
  });
});

describe("waitForRun", () => {
  it("returns immediately for a finished run", async () => {
    const result = await waitForRun(
      fake({ details: [detail({ status: "failed" })] }),
      "run-1",
      base,
    );
    expect(result).toMatchObject({ timedOut: false, exitCode: 1, reasons: ["run failed"] });
  });

  it("returns immediately when a person is needed and no cursor was given", async () => {
    const result = await waitForRun(fake({ details: [approvalPending] }), "run-1", base);
    expect(result).toMatchObject({ timedOut: false, exitCode: 5 });
  });

  it("keeps waiting on a pending approval when given the cursor, then times out", async () => {
    const result = await waitForRun(fake({ details: [approvalPending] }), "run-1", {
      ...base,
      after: 10,
      timeoutMs: 150,
    });
    expect(result).toMatchObject({ timedOut: true, reasons: [], exitCode: 5 });
    expect(result.status.status).toBe("waiting_approval");
  });

  it("times out on a running run with the still-running exit code", async () => {
    const result = await waitForRun(fake({ details: [running] }), "run-1", {
      ...base,
      timeoutMs: 120,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: WAIT_STILL_RUNNING });
  });

  it("wakes when a node finishes and returns a fresh status", async () => {
    const after = detail({
      status: "running",
      executions: { work: { path: "work", status: "succeeded", kind: "agent" } },
    });
    const result = await waitForRun(
      fake({
        details: [running, after],
        streams: [[event(11, "node.state", "work", { to: "succeeded" })]],
      }),
      "run-1",
      base,
    );
    expect(result.timedOut).toBe(false);
    expect(result.reasons).toEqual(["node work succeeded"]);
    expect(result.exitCode).toBe(WAIT_STILL_RUNNING);
    expect(result.status.nodes).toEqual({ succeeded: 1 });
  });

  it("ignores instant nodes and usage chatter", async () => {
    const result = await waitForRun(
      fake({
        details: [running],
        streams: [
          [
            event(11, "node.state", "start", { to: "succeeded" }),
            event(12, "node.usage", "work"),
            event(13, "node.state", "work", { to: "running" }),
          ],
        ],
      }),
      "run-1",
      { ...base, timeoutMs: 150 },
    );
    expect(result.timedOut).toBe(true);
  });

  it("coalesces a burst of events into one answer", async () => {
    const result = await waitForRun(
      fake({
        details: [running],
        streams: [
          [
            event(11, "node.state", "work", { to: "succeeded" }),
            event(12, "loop.iteration.decided", "work", { iteration: 2 }),
          ],
        ],
      }),
      "run-1",
      { ...base, settleMs: 40 },
    );
    expect(result.reasons).toEqual(["node work succeeded", "loop work round 2 decided"]);
  });

  it("honours --until", async () => {
    const result = await waitForRun(
      fake({
        details: [running],
        streams: [
          [
            event(11, "node.state", "work", { to: "succeeded" }),
            event(12, "approval.requested", "review"),
          ],
        ],
      }),
      "run-1",
      { ...base, until: "approval" },
    );
    expect(result.reasons).toEqual(["approval requested at review"]);
  });

  it("wakes from a replayed event after the given cursor without streaming", async () => {
    const client = fake({
      details: [running],
      replay: [
        { id: 11, type: "approval.requested", path: "review", payload: {} } as EventEnvelope,
      ],
    });
    const result = await waitForRun(client, "run-1", { ...base, after: 5 });
    expect(result.reasons).toEqual(["approval requested at review"]);
    expect(client.connections).toBe(0);
  });

  it("reconnects after the stream drops", async () => {
    const client = fake({
      details: [running],
      streams: [
        new ApiTransportError("connection reset"),
        [event(11, "node.state", "work", { to: "failed" })],
      ],
    });
    const result = await waitForRun(client, "run-1", base);
    expect(result.reasons).toEqual(["node work failed"]);
    expect(client.connections).toBe(2);
  });

  it("refreshes status when the stream overflows", async () => {
    const result = await waitForRun(
      fake({
        details: [running],
        streams: [[{ event: "overflow", data: { lastEventId: 11 } } as RunStreamMessage]],
      }),
      "run-1",
      base,
    );
    expect(result.timedOut).toBe(false);
    expect(result.reasons[0]).toContain("overflowed");
  });
});
