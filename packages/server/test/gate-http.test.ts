import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunDetailResponse } from "@relay/api";
import { type EventEnvelope, project, type RunId } from "@relay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BrowserQueryPort,
  BrowserRunControllerPort,
  ProjectView,
  StartRunCommand,
  StartRunResponse,
} from "../src/index.js";
import { type RunningBrowserServer, startBrowserServer } from "../src/index.js";

const TOKEN = "c".repeat(43);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
const NOW = 1_700_000_000_000;

let root: string;
let dataDir: string;
let projectPath: string;
let server: RunningBrowserServer;
let cookie: string;
let started: StartRunCommand[];

function projectView(): ProjectView {
  return {
    id: "proj-1",
    name: "Project",
    path: projectPath,
    kind: "folder",
    missing: false,
    addedAt: NOW,
  };
}

function event(
  id: number,
  type: EventEnvelope["type"],
  path: string,
  payload: unknown,
): EventEnvelope {
  return {
    id,
    runId: RUN_ID,
    ts: new Date(NOW + id).toISOString(),
    path: path as EventEnvelope["path"],
    actor: "engine",
    type,
    v: 1,
    payload,
  } as EventEnvelope;
}

function routingView(): RunDetailResponse["view"] {
  const base = { attempt: 1, generation: 1 };
  const init = { kind: "gate" as const, requireSubmission: false };
  return project([
    event(1, "node.state", "gate", {
      from: "pending",
      to: "ready",
      ...base,
      init,
    }),
    event(2, "node.state", "gate", { from: "ready", to: "running", ...base }),
    event(3, "gate.decided", "gate", {
      branch: "yes",
      evaluated: [{ branch: "yes", matched: true }],
      ...base,
    }),
    event(4, "node.state", "join", {
      from: "pending",
      to: "ready",
      ...base,
      init: { kind: "join", requireSubmission: false },
    }),
    event(5, "node.state", "join", { from: "ready", to: "running", ...base }),
    event(6, "join.resolved", "join", {
      mode: "all",
      active: ["yes"],
      skipped: ["no"],
      ...base,
    }),
  ]);
}

function snapshot() {
  return {
    schemaVersion: 1 as const,
    id: "six-types",
    name: "Six types",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start" as const,
          name: "Start",
          supervise: "default" as const,
          env: [],
          params: [],
        },
        {
          id: "gate",
          type: "gate" as const,
          name: "Gate",
          supervise: "default" as const,
          env: [],
          branches: [
            { id: "yes", when: "start.go" },
            { id: "no", otherwise: true as const },
          ],
        },
        {
          id: "join",
          type: "join" as const,
          name: "Join",
          supervise: "default" as const,
          env: [],
          mode: "all" as const,
          inputs: ["yes", "no"],
        },
        {
          id: "shell",
          type: "shell" as const,
          name: "Shell",
          supervise: "default" as const,
          env: [],
          command: "true",
          workspace: { mode: "scratch" as const },
          timeoutMin: 1,
          allowFailure: false,
        },
        {
          id: "agent",
          type: "agent" as const,
          name: "Agent",
          supervise: "default" as const,
          env: [],
          cli: "codex" as const,
          prompt: "do it",
          output: { type: "object", properties: {}, required: [], additionalProperties: false },
          permissions: { network: false, write: [] },
          workspace: { mode: "scratch" as const },
          limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
          context: { project: "none" as const, workflow: "none" as const },
        },
        {
          id: "end",
          type: "end" as const,
          name: "End",
          supervise: "default" as const,
          env: [],
          status: "success" as const,
          result: "{}",
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "gate" },
        { id: "e2", from: "gate.yes", to: "join.yes" },
        { id: "e3", from: "gate.no", to: "join.no" },
        { id: "e4", from: "join", to: "shell" },
        { id: "e5", from: "shell", to: "agent" },
        { id: "e6", from: "agent", to: "end" },
      ],
    },
  };
}

function detail(): RunDetailResponse {
  return {
    run: {
      id: RUN_ID,
      projectId: "proj-1",
      projectName: "Project",
      workflowId: "six-types",
      workflowName: "Six types",
      runNumber: 1,
      kind: "run",
      status: "running",
      createdAt: NOW,
      startedAt: NOW,
      endedAt: null,
      pauseReason: null,
      costUsd: 0,
      tokens: 0,
      activeMs: 0,
    },
    view: routingView(),
    snapshot: snapshot(),
    watermark: 6,
    workspace: null,
  };
}

function store(): BrowserQueryPort {
  const project = projectView();
  return {
    listProjects: () => [project],
    getProject: (id) => (id === project.id ? project : null),
    registerProject: () => project,
    relinkProject: () => project,
    listRuns: () => ({ items: [], nextCursor: null }),
    getRun: () => null,
    runDetail: (id) => (id === RUN_ID ? detail() : null),
    eventsPage: () => ({ events: [], nextAfter: 0, hasMore: false, watermark: 0 }),
    getExecution: () => null,
    executionHistory: () => ({
      runId: RUN_ID,
      path: "" as never,
      attempts: [],
      transcripts: [],
      latestTranscript: null,
    }),
    getOutput: () => null,
    counts: () => ({ runs: 0, activeRuns: 0, inbox: 0 }),
    listApprovals: () => ({ items: [], nextCursor: null }),
    getApproval: () => null,
  } as BrowserQueryPort;
}

function controller(): BrowserRunControllerPort {
  const response = (): StartRunResponse => ({ runId: RUN_ID, duplicate: false, status: "queued" });
  return {
    startRun: (input) => {
      started.push(input);
      return response();
    },
    cancelRun: () => ({ runId: RUN_ID, status: "cancelled" }),
    resumeRun: () => ({ runId: RUN_ID, status: "running" }),
    resolveApproval: () => ({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      path: "approval" as never,
      decision: "approve" as const,
      note: null,
      by: "user",
      duplicate: false,
      status: "running" as never,
      eventId: 1,
    }),
  };
}

function url(path: string): string {
  return `${server.url}${path}`;
}

function headers(mutation = false): Record<string, string> {
  return {
    Cookie: cookie,
    ...(mutation ? { "Content-Type": "application/json", "X-Relay-Csrf": "1" } : {}),
  };
}

async function json<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(url(path), {
    method,
    headers: { ...headers(method !== "GET"), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

const GATE = {
  id: "triage",
  type: "gate",
  name: "Triage",
  branches: [
    { id: "high", when: "score >= 0.8" },
    { id: "low", otherwise: true },
  ],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-gate-http-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  started = [];
  await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
  await (await import("node:fs/promises")).mkdir(projectPath, { recursive: true });
  server = await startBrowserServer({
    dataDir,
    store: store(),
    controller: controller(),
    sessionToken: TOKEN,
    instanceId: "gate-http",
    version: "0.1.0-test",
    port: 0,
    validateResponses: true,
    now: () => NOW,
  });
  const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("gate preview HTTP route", () => {
  it("returns the first true branch without touching workflow files or runs", async () => {
    const response = await json<{ branch: string; evaluated: unknown[] }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      { gate: GATE, scope: { score: 0.9 } },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      branch: "high",
      evaluated: [{ branch: "high", matched: true }],
    });
    expect(started).toHaveLength(0);
    expect(await readdir(projectPath)).toEqual([]);
  });

  it("uses otherwise when every condition is false", async () => {
    const response = await json<{ branch: string }>("POST", "/api/projects/proj-1/gates/test", {
      gate: GATE,
      scope: { score: 0.1 },
    });
    expect(response.status).toBe(200);
    expect(response.body.branch).toBe("low");
  });

  it("fails closed on a non-boolean when", async () => {
    const response = await json<{
      branch: null;
      evaluated: { branch: string; matched: boolean; error?: string }[];
      error: { code: string; message: string };
    }>("POST", "/api/projects/proj-1/gates/test", {
      gate: {
        ...GATE,
        branches: [
          { id: "high", when: "score" },
          { id: "low", otherwise: true },
        ],
      },
      scope: { score: 0.9 },
    });
    expect(response.status).toBe(200);
    expect(response.body.branch).toBeNull();
    expect(response.body.error.code).toBe("E_EXPR");
    expect(response.body.evaluated[0]).toMatchObject({ branch: "high", matched: false });
  });

  it("fails closed on an expression error", async () => {
    const response = await json<{ branch: null; error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      {
        gate: {
          ...GATE,
          branches: [
            { id: "high", when: "score >" },
            { id: "low", otherwise: true },
          ],
        },
        scope: { score: 0.9 },
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.branch).toBeNull();
    expect(response.body.error.code).toBe("E_EXPR");
  });

  it("totally bounds slow branch evaluation", async () => {
    const start = Date.now();
    const branches: { id: string; when?: string; otherwise?: true }[] = Array.from(
      { length: 31 },
      (_, index) => ({ id: `b${index}`, when: "$sum([1..5000000]) < 0" }),
    );
    branches.push({ id: "last", otherwise: true });
    const response = await json<{ branch: string | null; error?: { code: string } }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      { gate: { ...GATE, branches }, scope: {} },
    );
    const elapsed = Date.now() - start;
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
    if (response.body.branch === null) {
      expect(response.body.error?.code).toBe("E_EXPR");
    }
  });

  it("rejects malformed gates and bodies without writing anything", async () => {
    const missing = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      { gate: { ...GATE, branches: [{ id: "high", when: "true" }] }, scope: {} },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("E_VALIDATION");

    const wrongType = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      { gate: { ...GATE, type: "agent" }, scope: {} },
    );
    expect(wrongType.status).toBe(400);

    const unknown = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/gates/test",
      { gate: { ...GATE, extra: 1 }, scope: {} },
    );
    expect(unknown.status).toBe(400);

    const projectMissing = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/nope/gates/test",
      { gate: GATE, scope: {} },
    );
    expect(projectMissing.status).toBe(404);
    expect(unknown.body.error.code).toBe("E_VALIDATION");
  });

  it("applies auth, CSRF, content-type and payload caps", async () => {
    const anonymous = await fetch(url("/api/projects/proj-1/gates/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Csrf": "1" },
      body: JSON.stringify({ gate: GATE, scope: {} }),
    });
    expect(anonymous.status).toBe(401);

    const noCsrf = await fetch(url("/api/projects/proj-1/gates/test"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ gate: GATE, scope: {} }),
    });
    expect(noCsrf.status).toBe(403);

    const badType = await fetch(url("/api/projects/proj-1/gates/test"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "text/plain", "X-Relay-Csrf": "1" },
      body: "{}",
    });
    expect(badType.status).toBe(403);

    const huge = await fetch(url("/api/projects/proj-1/gates/test"), {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ gate: GATE, scope: { blob: "x".repeat(70 * 1024) } }),
    });
    expect(huge.status).toBe(413);
  });

  it("serves a six-type stored snapshot with gate and join routing metadata", async () => {
    const response = await json<RunDetailResponse>("GET", `/api/runs/${RUN_ID}`);
    expect(response.status).toBe(200);
    expect(response.body.snapshot.graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["start", "agent", "shell", "gate", "join", "end"]),
    );
    expect(response.body.view.executions.gate?.gateDecision).toMatchObject({ branch: "yes" });
    expect(response.body.view.executions.join?.joinResolution).toMatchObject({
      mode: "all",
      active: ["yes"],
      skipped: ["no"],
    });
  });
});
