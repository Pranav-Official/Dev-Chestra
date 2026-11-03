import { type ExecView, emptyRunView, type Path, type RunView } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import {
  COMPACT_MAX_ACTIVE,
  type CompactActivity,
  compactRunStatus,
  kindOfPath,
  type NormalizedWorkflow,
  type RunDetailResponse,
  wakeReason,
} from "../src/index.js";

const NOW = 1_000_000;

function exec(path: string, patch: Partial<ExecView> = {}): ExecView {
  return {
    path: path as Path,
    nodeId: path.split("/").at(-1) ?? path,
    status: "pending",
    attempt: 1,
    generation: 1,
    kind: "agent",
    gateDecision: null,
    joinResolution: null,
    approvalRequest: null,
    approvalDecision: null,
    decision: null,
    loop: null,
    workflow: null,
    foreach: null,
    requiresAcceptedResult: false,
    acceptedResult: null,
    recordedOutput: null,
    processSpawned: null,
    processStopped: null,
    workspaceFinalized: null,
    validationAttempts: 0,
    crashAttempts: 0,
    mode: null,
    cli: null,
    sessionId: null,
    sessionCwd: null,
    model: null,
    resolvedConfigHash: null,
    inputsHash: null,
    startedAt: null,
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    attemptTokensIn: 0,
    attemptTokensOut: 0,
    attemptCostUsd: 0,
    workspaceDir: null,
    branch: null,
    workspaceCommitted: null,
    lastValidationErrors: [],
    lastTranscript: null,
    lastError: null,
    ...patch,
  };
}

function detail(
  view: Partial<RunView>,
  executions: ExecView[],
  maxIterations = 20,
): RunDetailResponse {
  const base = emptyRunView();
  const snapshot = {
    schemaVersion: 1,
    id: "find-influencers",
    name: "Find influencers",
    graph: {
      nodes: [{ id: "find", type: "loop", maxIterations }],
      edges: [],
    },
  } as unknown as NormalizedWorkflow;
  return {
    run: {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workflowId: "find-influencers",
      startedAt: NOW - 90_000,
      endedAt: null,
    },
    view: {
      ...base,
      status: "running",
      budget: { usd: 0.42, tokens: 12_000, activeMs: 0, supervisorUsd: 0 },
      ...view,
      executions: Object.fromEntries(executions.map((e) => [e.path, e])),
    },
    snapshot,
    watermark: 77,
    workspace: null,
  } as unknown as RunDetailResponse;
}

describe("compactRunStatus", () => {
  it("collapses finished nodes to counts and keeps loop progress", () => {
    const status = compactRunStatus(
      detail({}, [
        exec("start", { status: "succeeded", kind: "start" }),
        exec("setup", { status: "succeeded" }),
        exec("skipme", { status: "skipped" }),
        exec("find", {
          status: "running",
          kind: "loop",
          startedAt: NOW - 60_000,
          loop: {
            iteration: 3,
            parent: {},
            parentRef: null,
            state: { verified: 7 },
            rounds: [],
          },
        }),
        exec("find#3/discover", { status: "running", startedAt: NOW - 5_000, tokensIn: 100 }),
      ]),
      { now: NOW },
    );
    expect(status).toMatchObject({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workflow: "find-influencers",
      status: "running",
      elapsedMs: 90_000,
      costUsd: 0.42,
      tokens: 12_000,
      cursor: 77,
      nodes: { running: 2, skipped: 1, succeeded: 2 },
      needsAttention: [],
      lastError: null,
    });
    expect(status.active.map((a) => a.path)).toEqual(["find", "find#3/discover"]);
    expect(status.active[0]?.loop).toEqual({
      iteration: 3,
      maxIterations: 20,
      state: { verified: 7 },
      outcome: null,
    });
    expect(JSON.stringify(status).length).toBeLessThan(1024);
  });

  it("reports foreach progress and a finished loop's outcome", () => {
    const status = compactRunStatus(
      detail({}, [
        exec("find", {
          status: "succeeded",
          kind: "loop",
          loop: {
            iteration: 4,
            parent: {},
            parentRef: null,
            state: { verified: 20 },
            rounds: [
              {
                iteration: 4,
                result: {},
                done: true,
                nextState: null,
                outcome: "condition_met",
                eventId: 9,
              },
            ],
          },
        }),
        exec("each", {
          status: "running",
          kind: "foreach",
          foreach: {
            total: 10,
            processed: 4,
            succeeded: 3,
            failed: 1,
            rejected: 0,
            resultsRef: null,
            sourceId: null,
            eventId: 1,
          },
        }),
      ]),
      { now: NOW },
    );
    expect(status.completed).toEqual([
      {
        path: "find",
        kind: "loop",
        status: "succeeded",
        loop: {
          iteration: 4,
          maxIterations: 20,
          state: { verified: 20 },
          outcome: "condition_met",
        },
      },
    ]);
    expect(status.active[0]?.foreach).toEqual({
      total: 10,
      processed: 4,
      succeeded: 3,
      failed: 1,
      rejected: 0,
    });
  });

  it("surfaces approvals, failures and pauses, failures first", () => {
    const status = compactRunStatus(
      detail(
        {
          status: "paused",
          pauseReason: "quota",
          pauseDetail: "claude quota window",
          pausePath: "work" as Path,
          errors: [
            {
              eventId: 5,
              ts: "t",
              path: "broken" as Path,
              code: "E_CLI_CRASH",
              message: "boom",
              details: null,
            },
          ],
        },
        [
          exec("work", { status: "running", startedAt: NOW - 1000 }),
          exec("review", {
            status: "waiting_approval",
            kind: "approval",
            approvalRequest: {
              message: "Ship it?",
              irreversible: true,
              criteria: null,
              requestId: "req-1",
              attempt: 1,
              generation: 1,
              eventId: 3,
            },
          }),
          exec("broken", {
            status: "failed",
            attempt: 2,
            validationAttempts: 1,
            crashAttempts: 1,
            lastError: { code: "E_CLI_CRASH", message: "x".repeat(500) },
          }),
        ],
      ),
      { now: NOW },
    );
    expect(status.active.map((a) => a.path)).toEqual(["broken", "review", "work"]);
    expect(status.active[0]?.lastError?.message.length).toBeLessThanOrEqual(200);
    expect(status.needsAttention).toEqual([
      {
        type: "approval",
        path: "review",
        requestId: "req-1",
        message: "Ship it?",
        irreversible: true,
        attempt: 1,
        generation: 1,
      },
      { type: "paused", reason: "quota", detail: "claude quota window", path: "work" },
    ]);
    expect(status.nodes).toEqual({ failed: 1, running: 1, waiting: 1 });
    expect(status.lastError).toEqual({ path: "broken", code: "E_CLI_CRASH", message: "boom" });
  });

  it("bounds active entries, error text and large loop state", () => {
    const many = Array.from({ length: COMPACT_MAX_ACTIVE + 4 }, (_, i) =>
      exec(`n${i}`, { status: "running", startedAt: i }),
    );
    const big: Record<string, string | number | string[]> = { count: 5 };
    for (let i = 0; i < 40; i++) big[`k${i}`] = `value-${i}-${"y".repeat(30)}`;
    big.list = ["a", "b"];
    const status = compactRunStatus(
      detail({}, [
        ...many,
        exec("find", {
          status: "running",
          kind: "loop",
          loop: {
            iteration: 1,
            parent: {},
            parentRef: null,
            state: big,
            rounds: [],
          },
        }),
      ]),
      { now: NOW },
    );
    expect(status.active).toHaveLength(COMPACT_MAX_ACTIVE);
    expect(status.activeTruncated).toBe(5);
    const loop = status.active.find((a) => a.path === "find")?.loop;
    expect(loop).toBeDefined();
    expect(JSON.stringify(loop?.state).length).toBeLessThan(400);
    expect(loop?.state.count).toBe(5);
  });

  it("attaches caller-supplied activity to the matching running node", () => {
    const activity: CompactActivity = {
      updatedAt: "2026-01-01T00:00:00Z",
      idleSec: 12,
      lastTool: "Bash ls",
    };
    const status = compactRunStatus(detail({}, [exec("work", { status: "running" })]), {
      now: NOW,
      activity: { work: activity },
    });
    expect(status.active[0]?.activity).toEqual(activity);
  });
});

describe("wakeReason", () => {
  const kinds: Record<string, string> = { start: "start", gate: "gate", work: "agent" };
  const kindOf = (path: string) => kinds[path.split("/").at(-1) ?? path] ?? null;
  const event = (type: string, path: string, payload: Record<string, unknown> = {}) =>
    ({ type, path, payload }) as Parameters<typeof wakeReason>[0];

  it("wakes for non-trivial nodes finishing or failing", () => {
    expect(wakeReason(event("node.state", "work", { to: "succeeded" }), kindOf)).toEqual({
      category: "node-done",
      reason: "node work succeeded",
    });
    expect(wakeReason(event("node.state", "work", { to: "failed" }), kindOf)?.category).toBe(
      "node-done",
    );
    expect(wakeReason(event("node.state", "work", { to: "waiting_quota" }), kindOf)).not.toBeNull();
  });

  it("ignores instant nodes, running transitions and usage chatter", () => {
    expect(wakeReason(event("node.state", "start", { to: "succeeded" }), kindOf)).toBeNull();
    expect(wakeReason(event("node.state", "gate", { to: "succeeded" }), kindOf)).toBeNull();
    expect(wakeReason(event("node.state", "work", { to: "running" }), kindOf)).toBeNull();
    expect(wakeReason(event("node.usage", "work"), kindOf)).toBeNull();
    expect(wakeReason(event("node.output.recorded", "work"), kindOf)).toBeNull();
  });

  it("wakes for loop rounds, foreach items, child workflows, approvals and run state", () => {
    expect(
      wakeReason(event("loop.iteration.decided", "find", { iteration: 3 }), kindOf)?.reason,
    ).toBe("loop find round 3 decided");
    expect(
      wakeReason(event("foreach.item.decided", "each", { index: 2, status: "failed" }), kindOf)
        ?.reason,
    ).toBe("foreach each item 2 failed");
    expect(wakeReason(event("workflow.completed", "call", { status: "failed" }), kindOf)).not.toBe(
      null,
    );
    expect(wakeReason(event("approval.requested", "review"), kindOf)?.category).toBe("approval");
    expect(wakeReason(event("run.paused", ""), kindOf)?.category).toBe("status");
    expect(wakeReason(event("run.completed", ""), kindOf)?.category).toBe("terminal");
  });

  it("narrows by --until but always wakes for a finished run", () => {
    const approval = event("approval.requested", "review");
    const node = event("node.state", "work", { to: "succeeded" });
    expect(wakeReason(approval, kindOf, "approval")).not.toBeNull();
    expect(wakeReason(node, kindOf, "approval")).toBeNull();
    expect(wakeReason(approval, kindOf, "node-done")).toBeNull();
    expect(wakeReason(node, kindOf, "node-done")).not.toBeNull();
    expect(wakeReason(event("run.paused", ""), kindOf, "status")).not.toBeNull();
    expect(wakeReason(event("run.completed", ""), kindOf, "approval")?.category).toBe("terminal");
    expect(wakeReason(event("run.cancelled", ""), kindOf, "node-done")?.category).toBe("terminal");
  });
});

describe("kindOfPath", () => {
  const snapshot = {
    graph: {
      nodes: [
        { id: "start", type: "start" },
        {
          id: "find",
          type: "loop",
          body: {
            nodes: [
              { id: "discover", type: "agent" },
              { id: "check", type: "shell" },
            ],
          },
        },
        { id: "each", type: "foreach", body: { nodes: [{ id: "fetch", type: "workflow" }] } },
      ],
      edges: [],
    },
  } as unknown as NormalizedWorkflow;

  it("resolves top-level, loop-body and foreach-body nodes from the last path segment", () => {
    expect(kindOfPath(snapshot, "start")).toBe("start");
    expect(kindOfPath(snapshot, "find")).toBe("loop");
    expect(kindOfPath(snapshot, "find#2/discover")).toBe("agent");
    expect(kindOfPath(snapshot, "find#2/check")).toBe("shell");
    expect(kindOfPath(snapshot, "each[3]/fetch")).toBe("workflow");
    expect(kindOfPath(snapshot, "nope")).toBeNull();
  });
});
