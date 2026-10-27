import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDocumentResponse, WorkflowListResponse } from "@relay/api";
import type { RunId } from "@relay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BrowserQueryPort,
  BrowserRunControllerPort,
  ProjectView,
  StartRunCommand,
  StartRunResponse,
} from "../src/index.js";
import { type RunningBrowserServer, startBrowserServer } from "../src/index.js";

const TOKEN = "b".repeat(43);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

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
    addedAt: 1_700_000_000_000,
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
    runDetail: () => null,
    eventsPage: () => ({
      events: [],
      nextAfter: 0,
      hasMore: false,
      watermark: 0,
    }),
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
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(url(path), {
    method,
    headers: { ...headers(method !== "GET"), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text === "" ? null : JSON.parse(text)) as T,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-wf-http-"));
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
    instanceId: "workflow-http",
    version: "0.1.0-test",
    port: 0,
    validateResponses: true,
    now: () => 1_700_000_000_000,
  });
  const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("workflow HTTP routes", () => {
  it("creates, reads, lists, validates and saves with strong ETags", async () => {
    const created = await json<WorkflowDocumentResponse>("POST", "/api/projects/proj-1/workflows", {
      name: "HTTP Flow",
      template: "linear-fake",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe(`"${created.body.etag}"`);
    expect(created.body.validation.ok).toBe(true);

    const fetched = await json<WorkflowDocumentResponse>(
      "GET",
      "/api/projects/proj-1/workflows/http-flow",
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("etag")).toBe(`"${created.body.etag}"`);
    expect(fetched.body.text).toBe(created.body.text);

    const listed = await json<WorkflowListResponse>(
      "GET",
      "/api/projects/proj-1/workflows?limit=1",
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]?.validationSummary?.ok).toBe(true);

    const validated = await json<{ validation: { ok: boolean } }>(
      "POST",
      "/api/projects/proj-1/workflows/http-flow/validate",
      { workflow: fetched.body.workflow },
    );
    expect(validated.status).toBe(200);
    expect(validated.body.validation.ok).toBe(true);

    const saved = await json<WorkflowDocumentResponse>(
      "PUT",
      "/api/projects/proj-1/workflows/http-flow",
      { workflow: { ...fetched.body.workflow, name: "Renamed" } },
      { "If-Match": `"${fetched.body.etag}"` },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.workflow.name).toBe("Renamed");
    expect(saved.body.etag).not.toBe(fetched.body.etag);
    expect(started).toHaveLength(0);
  });

  it("requires If-Match and returns the current ETag on conflict", async () => {
    const created = await json<WorkflowDocumentResponse>("POST", "/api/projects/proj-1/workflows", {
      name: "Conflict",
    });
    const missing = await json<{ error: { code: string } }>(
      "PUT",
      "/api/projects/proj-1/workflows/conflict",
      { workflow: created.body.workflow },
    );
    expect(missing.status).toBe(400);

    const stale = await json<{ error: { code: string; details: { currentEtag: string } } }>(
      "PUT",
      "/api/projects/proj-1/workflows/conflict",
      { workflow: created.body.workflow },
      { "If-Match": `"${"0".repeat(64)}"` },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("E_CONFLICT");
    expect(stale.body.error.details.currentEtag).toBe(created.body.etag);
    expect(stale.headers.get("etag")).toBe(`"${created.body.etag}"`);
  });

  it("runs only the exact saved revision through the trusted controller", async () => {
    const created = await json<WorkflowDocumentResponse>("POST", "/api/projects/proj-1/workflows", {
      name: "Runnable",
      template: "linear-fake",
    });
    const stale = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/workflows/runnable/runs",
      { params: {}, etag: "0".repeat(64) },
    );
    expect(stale.status).toBe(409);

    const run = await json<StartRunResponse>(
      "POST",
      "/api/projects/proj-1/workflows/runnable/runs",
      { params: {}, etag: created.body.etag },
      { "Idempotency-Key": "test-run-1" },
    );
    expect(run.status).toBe(202);
    expect(started).toHaveLength(1);
    expect(started[0]?.workflowFile).toBe(".relay/workflows/runnable.json");
    expect(started[0]?.snapshotRaw).toBe(created.body.text);
    expect(started[0]?.idempotencyKey).toBe("test-run-1");
  });

  it("deletes only with a matching strong ETag", async () => {
    const created = await json<WorkflowDocumentResponse>("POST", "/api/projects/proj-1/workflows", {
      name: "Delete Me",
    });
    const noHeader = await fetch(url("/api/projects/proj-1/workflows/delete-me"), {
      method: "DELETE",
      headers: headers(true),
    });
    expect(noHeader.status).toBe(400);
    const stale = await fetch(url("/api/projects/proj-1/workflows/delete-me"), {
      method: "DELETE",
      headers: { ...headers(true), "If-Match": `"${"0".repeat(64)}"` },
    });
    expect(stale.status).toBe(409);
    const deleted = await fetch(url("/api/projects/proj-1/workflows/delete-me"), {
      method: "DELETE",
      headers: { ...headers(true), "If-Match": `"${created.body.etag}"` },
    });
    expect(deleted.status).toBe(204);
    const gone = await json<{ error: { code: string } }>(
      "GET",
      "/api/projects/proj-1/workflows/delete-me",
    );
    expect(gone.status).toBe(404);
  });

  it("keeps auth, CSRF, body caps and unknown-API JSON behavior", async () => {
    const anonymous = await fetch(url("/api/projects/proj-1/workflows"));
    expect(anonymous.status).toBe(401);

    const noCsrf = await fetch(url("/api/projects/proj-1/workflows"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No CSRF" }),
    });
    expect(noCsrf.status).toBe(403);

    const huge = await fetch(url("/api/projects/proj-1/workflows"), {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ name: "Huge", padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(huge.status).toBe(413);

    const unknown = await fetch(url("/api/nope"), { headers: headers() });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("E_NOT_FOUND");

    const spa = await fetch(url("/p/proj-1/w/some-workflow"), { headers: headers() });
    expect([200, 404]).toContain(spa.status);
  });

  it("rejects a workflow over the 1 MiB file cap without writing it", async () => {
    const created = await json<WorkflowDocumentResponse>("POST", "/api/projects/proj-1/workflows", {
      name: "Bounded",
      template: "linear-fake",
    });
    const workflow = structuredClone(created.body.workflow);
    const agent = workflow.graph.nodes.find((node) => node.type === "agent");
    if (agent === undefined || agent.type !== "agent") throw new Error("missing agent");
    agent.prompt = "x".repeat(1024 * 1024);
    const oversized = await json<{ error: { code: string } }>(
      "PUT",
      "/api/projects/proj-1/workflows/bounded",
      { workflow },
      { "If-Match": `"${created.body.etag}"` },
    );
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("E_PAYLOAD_TOO_LARGE");
    const unchanged = await json<WorkflowDocumentResponse>(
      "GET",
      "/api/projects/proj-1/workflows/bounded",
    );
    expect(unchanged.body.etag).toBe(created.body.etag);
  });

  it("rejects traversal in the workflow id path", async () => {
    const response = await json<{ error: { code: string } }>(
      "GET",
      "/api/projects/proj-1/workflows/%2e%2e%2fsecret",
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("E_VALIDATION");
  });
});
