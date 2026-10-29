import {
  EVENT_TYPES,
  EXEC_STATUSES,
  emptyRunView,
  type KnownEventType,
  RUN_STATUSES,
} from "@devchestra/core";
import { describe, expect, it } from "vitest";
import type { MissingCoreErrorCode } from "../src/errors.js";
import {
  eventEnvelopeSchema,
  eventPayloadSchemas,
  execStatusSchema,
  normalizedWorkflowSchema,
  registerProjectRequestSchema,
  relinkProjectRequestSchema,
  runEventsQuerySchema,
  runStatusSchema,
  runViewSchema,
  startRunRequestSchema,
} from "../src/index.js";

// Compile-time: the API error-code list covers the whole core taxonomy.
const coreErrorCodesCovered: MissingCoreErrorCode extends never ? true : false = true;
void coreErrorCodesCovered;

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function normalizedSnapshot(
  agentWorkspace: Record<string, unknown> = { mode: "scratch" },
  shellWorkspace: Record<string, unknown> = { mode: "scratch" },
) {
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    description: "test",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          supervise: "default",
          env: [],
          params: [{ name: "topic", type: "string", required: false }],
        },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          supervise: "default",
          env: [],
          cli: "codex",
          model: "m",
          prompt: "do it",
          output: { type: "object" },
          permissions: { network: false, write: [] },
          workspace: agentWorkspace,
          limits: { timeoutMin: 30, validationRetries: 2, crashRetries: 1 },
          context: { project: "none", workflow: "none" },
        },
        {
          id: "shell",
          type: "shell",
          name: "Shell",
          supervise: "default",
          env: [],
          command: "echo hi",
          workspace: shellWorkspace,
          timeoutMin: 10,
          allowFailure: false,
        },
        {
          id: "end",
          type: "end",
          name: "End",
          supervise: "default",
          env: [],
          status: "success",
          result: "ok",
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "shell" },
        { id: "e3", from: "shell", to: "end" },
      ],
    },
  };
}

const samples = {
  "run.created": {
    workflowId: "wf",
    workflowHash: "hash",
    runNumber: 1,
    params: { topic: "devchestra" },
    budgets: {},
    baseSha: "sha",
    kind: "run",
  },
  "run.started": {},
  "run.paused": { reason: "quota", detail: "window", path: "agent" },
  "run.resumed": { reason: "user" },
  "run.cancelled": { by: "user" },
  "run.completed": {
    status: "success",
    endPath: "end",
    result: { ok: true },
    error: { code: "E_INTERNAL", message: "boom", details: { x: 1 } },
  },
  "run.override.added": { nodeId: "agent", kind: "param", value: 1, reason: "tune" },
  "node.state": {
    from: "pending",
    to: "ready",
    reason: "created",
    attempt: 1,
    generation: 1,
    init: { kind: "agent", requireSubmission: true },
  },
  "node.attempt.started": {
    attempt: 1,
    generation: 1,
    mode: "fresh",
    cli: "codex",
    model: "model",
    resolvedConfigHash: "hash",
    nodeKind: "agent",
    requireSubmission: true,
  },
  "node.session.captured": {
    attempt: 1,
    generation: 1,
    cli: "codex",
    sessionId: "session",
    cwd: "/tmp",
    model: "model",
  },
  "node.input.resolved": {
    attempt: 1,
    generation: 1,
    inputsHash: "hash",
    inputs: { topic: "devchestra" },
  },
  "node.output.rejected": {
    attempt: 1,
    generation: 1,
    validationAttempt: 1,
    errors: [{ path: "/a", message: "bad" }],
  },
  "node.output.validated": {
    attempt: 1,
    generation: 1,
    outputId: "out",
    outputHash: "hash",
    schemaHash: "schema",
  },
  "node.output.recorded": {
    attempt: 1,
    generation: 1,
    outputId: "out",
    outputHash: "hash",
  },
  "node.usage": {
    attempt: 1,
    generation: 1,
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.1,
    costSource: "reported",
  },
  "node.transcript.ref": { attempt: 1, generation: 1, file: "t.jsonl", bytes: 10 },
  "node.watchdog": { attempt: 1, generation: 1, kind: "timeout", detail: "slow" },
  "node.process.spawned": {
    attempt: 1,
    generation: 1,
    pid: 10,
    pidStart: "start",
    binary: "fake",
    cwd: "/tmp",
  },
  "node.process.stopped": {
    attempt: 1,
    generation: 1,
    reason: "exited",
    exitCode: null,
  },
  "node.workspace.finalized": {
    attempt: 1,
    generation: 1,
    dir: "/tmp",
    commitSha: "sha",
  },
  "gate.decided": {
    branch: "yes",
    evaluated: [{ branch: "yes", matched: true, error: "e" }],
  },
  "decision.requested": { provider: "p", model: "m", questionIds: ["q"] },
  "decision.answered": {
    answers: [
      {
        id: "q",
        kind: "text",
        value: "v",
        confidence: 0.9,
        probabilities: { a: 1 },
        refusal: "r",
      },
    ],
    latencyMs: 10,
    raw: { x: 1 },
  },
  "approval.requested": {
    message: "ok?",
    irreversible: true,
    autoApprove: false,
    minConfidence: 0.5,
  },
  "approval.resolved": { decision: "approve", by: "user", edited: true, note: "n" },
  "map.started": { itemCount: 1, concurrency: 1, labels: ["a"] },
  "map.item.state": { index: 0, status: "running", error: "e" },
  "map.completed": { done: 1, failed: 0, outputId: "out" },
  "loop.round.started": { round: 1, carryHash: "hash" },
  "loop.round.completed": { round: 1, exitMatched: true, stalled: false },
  "loop.exited": { reason: "condition", rounds: 1 },
  "loop.started": { iteration: 1, parent: {}, state: {} },
  "loop.iteration.decided": { iteration: 1, result: {}, done: true },
  "join.resolved": { mode: "all", active: ["a"], skipped: ["b"] },
  "quota.blocked": {
    provider: "p",
    kind: "window",
    resumeAt: 1_700_000_000_000,
    resumeAtSource: "parsed",
  },
  "quota.released": { provider: "p", by: "timer" },
  "budget.threshold": { budget: "usd", ratio: 0.5 },
  "budget.exceeded": { budget: "usd", limit: 1, value: 2 },
  "workspace.created": {
    attempt: 1,
    generation: 1,
    mode: "scratch",
    dir: "/tmp",
    branch: "b",
    baseSha: "sha",
  },
  "workspace.committed": {
    attempt: 1,
    generation: 1,
    sha: "sha",
    filesChanged: 1,
    insertions: 2,
    deletions: 3,
  },
  "workspace.removed": { dir: "/tmp" },
  "context.read": { scope: "project", watermark: 1 },
  "context.written": {
    scope: "workflow",
    entryId: "entry",
    topic: "topic",
    kind: "append",
    status: "active",
  },
  "pin.used": { nodeId: "agent", fromRunId: "run" },
  "supervisor.woke": { wakeId: "wake", reasons: ["r"], digestHash: "hash" },
  "supervisor.recommended": {
    recId: "rec",
    action: "retry",
    args: { x: 1 },
    confidence: 0.5,
    reasoning: "why",
  },
  "supervisor.applied": { recId: "rec", action: "retry", outcome: "ok" },
  "supervisor.dismissed": { recId: "rec" },
  "checkpoint.opened": { reason: "supervise_checkpoint" },
  "checkpoint.closed": { outcome: "proceed" },
  "error.logged": { code: "E_INTERNAL", message: "boom", details: { x: 1 } },
} satisfies Record<KnownEventType, unknown>;

function envelope(type: KnownEventType, payload: unknown, v = 1) {
  return {
    id: 1,
    runId: RUN_ID,
    ts: "2026-10-27T00:00:00.000Z",
    path: type.startsWith("node.") ? "agent" : "",
    type,
    actor: "engine",
    v,
    payload,
  };
}

describe("event schemas", () => {
  it("covers every catalog event type", () => {
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(samples).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)("parses a representative %s payload", (type) => {
    const parsed = eventEnvelopeSchema.safeParse(envelope(type, samples[type]));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("parses approval.requested/resolved with requestId/attempt/generation via eventPage and SSE", async () => {
    const requested = {
      message: "m",
      irreversible: false,
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV:approval:1:2",
      attempt: 1,
      generation: 2,
      criteria: ["c"],
    };
    const resolved = {
      decision: "approve" as const,
      by: "user",
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV:approval:1:2",
      attempt: 1,
      generation: 2,
      note: "ok",
    };
    // Direct envelope
    expect(eventEnvelopeSchema.safeParse(envelope("approval.requested", requested)).success).toBe(
      true,
    );
    expect(eventEnvelopeSchema.safeParse(envelope("approval.resolved", resolved)).success).toBe(
      true,
    );
    // Via EventPageResponse (GET /events)
    const { eventPageResponseSchema } = await import("../src/events.js");
    const page = {
      events: [envelope("approval.requested", requested), envelope("approval.resolved", resolved)],
      nextAfter: 2,
      hasMore: false,
      watermark: 2,
    };
    expect(
      eventPageResponseSchema.safeParse(page).success,
      JSON.stringify(eventPageResponseSchema.safeParse(page)),
    ).toBe(true);
    // Via SSE run stream (text/event-stream) - use exported runStreamRunMessageSchema
    const { runStreamRunMessageSchema } = await import("../src/sse.js");
    const runMsgRequested = {
      event: "run" as const,
      id: 1,
      data: envelope("approval.requested", requested),
    };
    const runMsgResolved = {
      event: "run" as const,
      id: 2,
      data: envelope("approval.resolved", resolved),
    };
    const parsedReq = runStreamRunMessageSchema.safeParse(runMsgRequested);
    const parsedRes = runStreamRunMessageSchema.safeParse(runMsgResolved);
    expect(
      parsedReq.success,
      JSON.stringify((parsedReq as unknown as { error?: { issues: unknown } }).error?.issues),
    ).toBe(true);
    expect(
      parsedRes.success,
      JSON.stringify((parsedRes as unknown as { error?: { issues: unknown } }).error?.issues),
    ).toBe(true);
    if (parsedReq.success)
      expect((parsedReq.data.data.payload as unknown as { requestId: string }).requestId).toBe(
        requested.requestId,
      );
    if (parsedRes.success)
      expect((parsedRes.data.data.payload as unknown as { requestId: string }).requestId).toBe(
        resolved.requestId,
      );
    // Ensure missing requestId still passes (legacy) but present also passes — removing fields must be caught by strict test above
    const legacyReq = { message: "m", irreversible: false };
    expect(eventEnvelopeSchema.safeParse(envelope("approval.requested", legacyReq)).success).toBe(
      true,
    );
  });

  it("accepts omitted optional fields", () => {
    const cases: [KnownEventType, unknown][] = [
      [
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
      ],
      ["run.paused", { reason: "user" }],
      ["run.completed", { status: "failed" }],
      ["node.usage", { attempt: 1, generation: 1, costSource: "none" }],
      ["node.process.stopped", { attempt: 1, generation: 1, reason: "killed" }],
      ["gate.decided", { branch: "a", evaluated: [{ branch: "a", matched: false }] }],
      ["decision.answered", { answers: [{ id: "q", kind: "text", value: null }], latencyMs: 0 }],
      ["approval.requested", { message: "m", irreversible: false, autoApprove: true }],
      ["quota.blocked", { provider: "p", kind: "auth", resumeAtSource: "unknown" }],
    ];
    for (const [type, payload] of cases) {
      const parsed = eventEnvelopeSchema.safeParse(envelope(type, payload));
      expect(parsed.success, `${type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("rejects a known type with a malformed payload", () => {
    const parsed = eventEnvelopeSchema.safeParse(
      envelope("node.usage", { attempt: 1, generation: 1 }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts an unknown future event type", () => {
    const parsed = eventEnvelopeSchema.safeParse({
      id: 2,
      runId: RUN_ID,
      ts: "2026-10-27T00:00:00.000Z",
      path: "",
      type: "future.event",
      actor: "system",
      v: 1,
      payload: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a known type at a newer payload version", () => {
    const parsed = eventEnvelopeSchema.safeParse(envelope("node.usage", { future: true }, 2));
    expect(parsed.success).toBe(true);
  });

  it("rejects a known type at v=1 using the future envelope fallback", () => {
    const parsed = eventEnvelopeSchema.safeParse(envelope("run.started", { not: "empty" }, 1));
    expect(parsed.success).toBe(false);
  });
});

describe("admin schemas", () => {
  it("covers every core run and execution status", () => {
    for (const status of RUN_STATUSES) {
      expect(runStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const status of EXEC_STATUSES) {
      expect(execStatusSchema.safeParse(status).success, status).toBe(true);
    }
  });

  it("accepts the core empty RunView", () => {
    const parsed = runViewSchema.safeParse(emptyRunView());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts a normalized workflow snapshot", () => {
    const parsed = normalizedWorkflowSchema.safeParse(normalizedSnapshot());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts the agent shell toggle and selected MCP servers in a snapshot", () => {
    const snapshot = normalizedSnapshot();
    const agent = snapshot.graph.nodes[1] as Record<string, unknown>;
    agent.permissions = { network: false, write: [], shell: false };
    agent.mcpServers = [
      { name: "docs", scope: "project" },
      { name: "Notion", scope: "connector" },
    ];
    const parsed = normalizedWorkflowSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    agent.mcpServers = [{ name: "x", scope: "elsewhere" }];
    expect(normalizedWorkflowSchema.safeParse(snapshot).success).toBe(false);
  });

  it("accepts explicit worktree workspaces for agent and shell nodes", () => {
    const snapshot = normalizedSnapshot({ mode: "worktree" }, { mode: "worktree" });
    const parsed = normalizedWorkflowSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent", workspace: { mode: "worktree" } }),
        expect.objectContaining({ id: "shell", workspace: { mode: "worktree" } }),
      ]),
    );
  });

  it("rejects unsupported or non-normalized workspace shapes", () => {
    const unsupported = [
      { mode: "project", access: "read" },
      { mode: "project", access: "write" },
      { mode: "worktree", base: "HEAD" },
      { mode: "worktree", setup: "pnpm install" },
      { mode: "worktree", from: "agent" },
      { mode: "scratch", extra: true },
    ];
    for (const workspace of unsupported) {
      const agent = normalizedWorkflowSchema.safeParse(normalizedSnapshot(workspace));
      expect(agent.success, `agent ${JSON.stringify(workspace)}`).toBe(false);
      const shell = normalizedWorkflowSchema.safeParse(normalizedSnapshot(undefined, workspace));
      expect(shell.success, `shell ${JSON.stringify(workspace)}`).toBe(false);
    }
  });
});

describe("request schemas", () => {
  it("rejects unknown start-run fields", () => {
    const parsed = startRunRequestSchema.safeParse({
      workflowFile: "workflows/demo.json",
      params: { topic: "devchestra" },
      script: "trusted-cli-only",
      provider: "claude-code",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects absolute and escaping workflowFile values", () => {
    for (const workflowFile of [
      "/tmp/wf.json",
      "../wf.json",
      "a/../../wf.json",
      "C:\\wf.json",
      "a//b.json",
      "./wf.json",
    ]) {
      expect(startRunRequestSchema.safeParse({ workflowFile }).success, workflowFile).toBe(false);
    }
    expect(startRunRequestSchema.safeParse({ workflowFile: "workflows/demo.json" }).success).toBe(
      true,
    );
  });

  it("rejects unknown project registration fields", () => {
    expect(registerProjectRequestSchema.safeParse({ path: "/tmp", kind: "git" }).success).toBe(
      false,
    );
    expect(relinkProjectRequestSchema.safeParse({ path: "/tmp", id: "x" }).success).toBe(false);
  });

  it("parses and normalizes event query strings strictly", () => {
    const parsed = runEventsQuerySchema.safeParse({
      after: "4",
      upTo: "9",
      limit: "25",
      types: "node.usage,run.started",
      pathPrefix: "evaluate[3]",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.after).toBe(4);
      expect(parsed.data.limit).toBe(25);
      expect(parsed.data.types).toEqual(["node.usage", "run.started"]);
    }
    expect(runEventsQuerySchema.safeParse({ after: "1", unexpected: "x" }).success).toBe(false);
    expect(runEventsQuerySchema.safeParse({ types: "not.an.event" }).success).toBe(false);
  });
});
