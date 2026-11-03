import type { RunDetailResponse, TranscriptPageResponse } from "@devchestra/api";
import { describe, expect, it } from "vitest";
import { fetchRunStatus, nodeActivity } from "../src/run-status.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function exec(path: string, patch: Record<string, unknown> = {}) {
  return {
    path,
    nodeId: path,
    status: "running",
    attempt: 1,
    generation: 1,
    kind: "agent",
    startedAt: NOW - 600_000,
    validationAttempts: 0,
    crashAttempts: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    approvalRequest: null,
    approvalDecision: null,
    loop: null,
    foreach: null,
    workflow: null,
    lastError: null,
    ...patch,
  };
}

function detail(executions: ReturnType<typeof exec>[]): RunDetailResponse {
  return {
    run: { id: "run-1", workflowId: "wf", startedAt: NOW - 700_000, endedAt: null },
    view: {
      status: "running",
      pauseReason: null,
      pauseDetail: null,
      pausePath: null,
      budget: { usd: 0, tokens: 0, activeMs: 0, supervisorUsd: 0 },
      errors: [],
      executions: Object.fromEntries(executions.map((e) => [e.path, e])),
    },
    snapshot: { graph: { nodes: [], edges: [] } },
    watermark: 5,
    workspace: null,
  } as unknown as RunDetailResponse;
}

function page(patch: Partial<TranscriptPageResponse>): TranscriptPageResponse {
  return {
    state: "available",
    lines: [],
    nextCursor: null,
    hasMore: false,
    attempt: 1,
    generation: 1,
    bytes: 0,
    endCursor: "0",
    updatedAt: null,
    ...patch,
  };
}

describe("nodeActivity", () => {
  it("reports idle time from the transcript write time and the last tool call", async () => {
    const calls: unknown[] = [];
    const client = {
      getExecutionTranscript: async (_run: string, path: string, query: unknown) => {
        calls.push([path, query]);
        return page({
          updatedAt: new Date(NOW - 42_000).toISOString(),
          lines: [
            { ts: null, kind: "tool", text: `Bash ${"x".repeat(200)}\nsecond line` },
            { ts: null, kind: "text", text: "thinking" },
          ],
        });
      },
    };
    const result = await nodeActivity(client, detail([exec("work")]), NOW);
    expect(calls).toEqual([["work", { tail: 8 }]]);
    expect(result.work?.idleSec).toBe(42);
    expect(result.work?.updatedAt).toBe(new Date(NOW - 42_000).toISOString());
    expect(result.work?.lastTool?.startsWith("Bash ")).toBe(true);
    expect(result.work?.lastTool?.length).toBeLessThanOrEqual(80);
    expect(result.work?.lastTool).not.toContain("\n");
  });

  it("measures from the start time when there is no transcript yet", async () => {
    const client = {
      getExecutionTranscript: async () => page({ state: "pending", endCursor: null }),
    };
    const result = await nodeActivity(client, detail([exec("work")]), NOW);
    expect(result.work).toEqual({ updatedAt: null, idleSec: 600, lastTool: null });
  });

  it("only samples running agent nodes, at most three, and survives lookup failures", async () => {
    const asked: string[] = [];
    const client = {
      getExecutionTranscript: async (_run: string, path: string) => {
        asked.push(path);
        if (path === "b") throw new Error("gone");
        return page({ updatedAt: new Date(NOW).toISOString() });
      },
    };
    const result = await nodeActivity(
      client,
      detail([
        exec("a", { startedAt: 1 }),
        exec("b", { startedAt: 2 }),
        exec("c", { startedAt: 3 }),
        exec("d", { startedAt: 4 }),
        exec("shell", { kind: "shell" }),
        exec("done", { status: "succeeded" }),
      ]),
      NOW,
    );
    expect(asked.sort()).toEqual(["a", "b", "c"]);
    expect(Object.keys(result).sort()).toEqual(["a", "c"]);
  });
});

describe("fetchRunStatus", () => {
  it("attaches activity to the matching active entry", async () => {
    const run = detail([exec("work")]);
    const client = {
      getRun: async () => run,
      getExecutionTranscript: async () => page({ updatedAt: new Date(Date.now()).toISOString() }),
    };
    const { status } = await fetchRunStatus(client, "run-1");
    expect(status.active[0]?.path).toBe("work");
    expect(status.active[0]?.activity?.idleSec).toBeLessThanOrEqual(1);
    expect(status.cursor).toBe(5);
  });
});
