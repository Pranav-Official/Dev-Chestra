import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EventPageResponse,
  ExecutionDetailResponse,
  RunDetailResponse,
  TranscriptPageResponse,
} from "@devchestra/api";
import type { EventEnvelope, Path, RunId, RunView } from "@devchestra/core";
import { DevChestraError as CoreDevChestraError, emptyRunView } from "@devchestra/core";
import { type NormalizedWorkflow, normalizeWorkflow } from "@devchestra/schema";
import { type ExecutionHistory, openStore } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserQueryPort,
  type BrowserRunControllerPort,
  type BrowserStreamPort,
  createBrowserApp,
  createStoreQueryPort,
  type ProjectView,
  type RunSummary,
  type StartRunCommand,
  startBrowserServer,
} from "../src/index.js";

const PORT = 51_234;
const TOKEN = "a".repeat(43);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workflow(): NormalizedWorkflow {
  const result = normalizeWorkflow({
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
      ],
      edges: [{ id: "e1", from: "start", to: "done" }],
    },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

const SNAPSHOT = workflow();
const NOW = 1_700_000_000_000;

function view(): RunView {
  return { ...emptyRunView(), status: "queued", runNumber: 1, lastEventId: 1 };
}

function summary(): RunSummary {
  return {
    id: RUN_ID,
    projectId: "proj-1",
    projectName: "Project",
    workflowId: "wf",
    workflowName: "Workflow",
    runNumber: 1,
    kind: "run",
    status: "queued",
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    pauseReason: null,
    costUsd: 0,
    tokens: 0,
    activeMs: 0,
  };
}

function runEvent(): EventEnvelope {
  return {
    id: 1,
    runId: RUN_ID,
    ts: new Date(NOW).toISOString(),
    path: "" as Path,
    type: "run.created",
    actor: "system",
    v: 1,
    payload: {
      workflowId: "wf",
      workflowHash: "hash",
      runNumber: 1,
      params: {},
      budgets: {},
      kind: "run",
    },
  } as EventEnvelope;
}

class FakeStore implements BrowserQueryPort {
  projects: ProjectView[] = [];
  events: EventEnvelope[] = [runEvent()];
  history: ExecutionHistory = {
    runId: RUN_ID,
    path: "draft" as Path,
    attempts: [],
    transcripts: [],
    latestTranscript: null,
  };
  output: {
    id: string;
    runId: RunId;
    path: Path;
    attempt: number;
    generation: number;
    hash: string;
    bytes: number;
    json: unknown;
    createdAt: number;
  } | null = null;
  fail = false;
  failWith: string | null = null;

  listProjects() {
    if (this.failWith !== null) {
      throw Object.assign(new Error("boom"), { code: this.failWith });
    }
    if (this.fail) throw new Error("boom");
    return this.projects;
  }
  getProject(projectId: string) {
    return this.projects.find((project) => project.id === projectId) ?? null;
  }
  registerProject(input: { path: string; name: string; kind: "git" | "folder" }) {
    const existing = this.projects.find((project) => project.path === input.path);
    if (existing !== undefined) return existing;
    const project: ProjectView = {
      id: `proj-${this.projects.length + 1}`,
      name: input.name,
      path: input.path,
      kind: input.kind,
      missing: false,
      addedAt: NOW,
    };
    this.projects.push(project);
    return project;
  }
  relinkProject(input: { projectId: string; path: string; name: string; kind: "git" | "folder" }) {
    const project = this.projects.find((item) => item.id === input.projectId);
    if (project === undefined) throw new Error("missing");
    project.path = input.path;
    project.name = input.name;
    project.kind = input.kind;
    return project;
  }
  listRuns() {
    return { items: [summary()], nextCursor: null };
  }
  getRun(runId: string) {
    return runId === RUN_ID ? summary() : null;
  }
  runDetail(runId: string) {
    if (runId !== RUN_ID) return null;
    return { run: summary(), view: view(), snapshot: SNAPSHOT, watermark: 1, workspace: null };
  }
  eventsPage(
    _runId: string,
    input: {
      after?: number;
      upTo?: number;
      limit: number;
      types?: readonly string[];
      pathPrefix?: string;
    },
  ) {
    let items = this.events.filter((event) =>
      input.after === undefined ? true : event.id > input.after,
    );
    const upTo = input.upTo;
    if (upTo !== undefined) items = items.filter((event) => event.id <= upTo);
    if (input.types !== undefined) {
      const types = new Set(input.types);
      items = items.filter((event) => types.has(event.type));
    }
    const pathPrefix = input.pathPrefix;
    if (pathPrefix !== undefined) {
      items = items.filter((event) => event.path.startsWith(pathPrefix));
    }
    items = items.slice(0, input.limit);
    return {
      events: items,
      nextAfter: items.at(-1)?.id ?? input.after ?? 0,
      hasMore: false,
      watermark: 1,
    };
  }
  getExecution() {
    return {
      runId: RUN_ID,
      path: "draft" as Path,
      nodeId: "draft",
      status: "running",
      attempt: 1,
      generation: 1,
      kind: "agent" as const,
      validationAttempts: 0,
      validationLimit: 3,
      crashAttempts: 0,
      outputId: this.output?.id ?? null,
      cli: "codex",
      sessionId: null,
      sessionCwd: null,
      model: null,
      startedAt: NOW,
      endedAt: null,
      workspaceDir: null,
      branch: null,
      errorCode: null,
      errorMessage: null,
      lastEventId: 1,
    };
  }
  executionHistory() {
    return this.history;
  }
  getOutput() {
    return this.output;
  }
  counts() {
    return { runs: 1, activeRuns: 1, inbox: 0 };
  }
  listApprovals() {
    return { items: [], nextCursor: null };
  }
  getApproval() {
    return null;
  }
}

function fakeController(starts: StartRunCommand[]): BrowserRunControllerPort {
  return {
    startRun(input) {
      starts.push(input);
      return { runId: RUN_ID, duplicate: false, status: "queued" };
    },
    cancelRun(runId) {
      return { runId: runId as RunId, status: "cancelled" };
    },
    resumeRun(runId) {
      return { runId: runId as RunId, status: "queued" };
    },
    resolveApproval() {
      return {
        runId: RUN_ID,
        path: "approval" as never,
        decision: "approve" as const,
        note: null,
        by: "user",
        duplicate: false,
        status: "running" as never,
        eventId: 1,
      };
    },
  };
}

function fakeStream(): BrowserStreamPort {
  return {
    mountRoutes(app) {
      app.get("/api/runs/:rid/stream", (c) =>
        c.body("event: snapshot\ndata: {}\n\n", 200, { "content-type": "text/event-stream" }),
      );
      app.get("/api/stream", (c) =>
        c.body("event: inbox\ndata: {}\n\n", 200, { "content-type": "text/event-stream" }),
      );
    },
  };
}

interface Harness {
  app: ReturnType<typeof createBrowserApp>;
  store: FakeStore;
  starts: StartRunCommand[];
  dataDir: string;
  projectDir: string;
  logs: string[];
}

async function harness(
  options: {
    webRoot?: string;
    logger?: boolean;
    controller?: BrowserRunControllerPort;
    noAuth?: boolean;
  } = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "devchestra-browser-data-"));
  const projectDir = await mkdtemp(join(tmpdir(), "devchestra-browser-project-"));
  cleanups.push(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });
  const store = new FakeStore();
  store.projects.push({
    id: "proj-1",
    name: "Project",
    path: projectDir,
    kind: "folder",
    missing: false,
    addedAt: NOW,
  });
  const starts: StartRunCommand[] = [];
  const logs: string[] = [];
  const raw = createBrowserApp({
    dataDir,
    store,
    controller: options.controller ?? fakeController(starts),
    stream: fakeStream(),
    sessionToken: TOKEN,
    instanceId: "instance-1",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => NOW,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    ...(options.logger === true ? { logger: (line) => logs.push(line) } : {}),
    ...(options.noAuth === true ? { noAuth: true } : {}),
  });
  const app = {
    request(input: Request | string | URL, init?: RequestInit) {
      if (input instanceof Request) {
        const headers = new Headers(input.headers);
        if (!headers.has("Host")) headers.set("Host", HOST);
        return raw.request(new Request(input, { headers }), init);
      }
      const headers = new Headers(init?.headers);
      if (!headers.has("Host")) headers.set("Host", HOST);
      return raw.request(input, { ...init, headers });
    },
  } as unknown as ReturnType<typeof createBrowserApp>;
  return { app, store, starts, dataDir, projectDir, logs };
}

function url(path: string): string {
  return `http://127.0.0.1:${PORT}${path}`;
}

function cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Host: HOST, Cookie: `devchestra_session=${TOKEN}`, ...extra };
}

function mutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Host: HOST,
    Cookie: `devchestra_session=${TOKEN}`,
    Origin: ORIGIN,
    "X-DevChestra-Csrf": "1",
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("browser app security", () => {
  it("serves health without auth and applies security headers", async () => {
    const h = await harness();
    const res = await h.app.request(url("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      instanceId: "instance-1",
      ready: true,
      checks: { store: "ok" },
    });
    expect(res.headers.get("x-devchestra-api")).toBe("1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports ready:false when the store is unreachable", async () => {
    const h = await harness();
    h.store.counts = () => {
      throw new Error("boom");
    };
    const res = await h.app.request(url("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ready: false,
      checks: { store: "error" },
    });
  });

  it("rejects wrong Host and foreign Origin", async () => {
    const h = await harness();
    expect(
      (await h.app.request(url("/api/health"), { headers: { Host: "evil.test:1" } })).status,
    ).toBe(421);
    expect(
      (
        await h.app.request(url("/api/bootstrap"), {
          headers: cookieHeaders({ Origin: "http://evil.test" }),
        })
      ).status,
    ).toBe(403);
    const post = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders({ Origin: "http://evil.test" }),
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(post.status).toBe(403);
  });

  it("requires a browser session or X-DevChestra-Token and never accepts a Bearer exec token", async () => {
    const h = await harness();
    expect((await h.app.request(url("/api/bootstrap"))).status).toBe(401);
    const bearer = await h.app.request(url("/api/bootstrap"), {
      headers: { Host: HOST, Authorization: "Bearer exec-token" },
    });
    expect(bearer.status).toBe(401);
    expect((await h.app.request(url("/api/bootstrap"), { headers: cookieHeaders() })).status).toBe(
      200,
    );
    expect(
      (
        await h.app.request(url("/api/bootstrap"), {
          headers: { Host: HOST, "X-DevChestra-Token": TOKEN },
        })
      ).status,
    ).toBe(200);
    const internal = await h.app.request(url("/internal/agent/tools"), {
      headers: cookieHeaders(),
    });
    expect(internal.status).toBe(404);
    expect(((await internal.json()) as { error: { code: string } }).error.code).toBe("E_NOT_FOUND");
  });

  it("serves the API and app without a session when noAuth is set", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "devchestra-browser-web-"));
    cleanups.push(async () => rm(webRoot, { recursive: true, force: true }));
    await writeFile(join(webRoot, "index.html"), "<html>APP SHELL</html>");
    const h = await harness({ webRoot, noAuth: true });
    expect((await h.app.request(url("/api/bootstrap"))).status).toBe(200);
    const created = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: {
        Host: HOST,
        Origin: ORIGIN,
        "X-DevChestra-Csrf": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(created.status).toBe(200);
    const page = await h.app.request(url("/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("APP SHELL");
  });

  it("requires CSRF and JSON for mutations", async () => {
    const h = await harness();
    const missing = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: {
        Host: HOST,
        Cookie: `devchestra_session=${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(missing.status).toBe(403);
    const wrongType = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: {
        Host: HOST,
        Cookie: `devchestra_session=${TOKEN}`,
        Origin: ORIGIN,
        "X-DevChestra-Csrf": "1",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(wrongType.status).toBe(403);
    const plusJson = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/vnd.api+json" }),
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(plusJson.status).toBe(403);
    const ok = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(ok.status).toBe(200);
    const first = (await ok.json()) as ProjectView;
    const duplicate = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ path: h.projectDir }),
    });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as ProjectView).id).toBe(first.id);
  });

  it("bootstraps the session cookie and redirects to a clean URL", async () => {
    const h = await harness();
    const res = await h.app.request(url(`/?t=${TOKEN}`), { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`devchestra_session=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(await res.text()).not.toContain(TOKEN);

    const bad = await h.app.request(url("/?t=wrong"), { redirect: "manual" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect(await bad.text()).not.toContain(TOKEN);
  });

  it("shows only terminal instructions without a cookie", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "devchestra-browser-web-"));
    cleanups.push(async () => rm(webRoot, { recursive: true, force: true }));
    await writeFile(join(webRoot, "index.html"), "<html>APP SHELL</html>");
    const h = await harness({ webRoot });
    const anonymous = await h.app.request(url("/"));
    const body = await anonymous.text();
    expect(body).toContain("Open DevChestra from your terminal");
    expect(body).not.toContain("APP SHELL");
    const direct = await h.app.request(url("/index.html"));
    expect(await direct.text()).not.toContain("APP SHELL");
    const authed = await h.app.request(url("/"), { headers: cookieHeaders() });
    expect(await authed.text()).toContain("APP SHELL");
  });

  it("enforces project path boundaries and preserves relink identity", async () => {
    const h = await harness();
    const other = await mkdtemp(join(tmpdir(), "devchestra-browser-other-"));
    cleanups.push(async () => rm(other, { recursive: true, force: true }));
    for (const path of [h.dataDir, join(h.dataDir, "nested"), tmpdir()]) {
      const res = await h.app.request(url("/api/projects"), {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ path }),
      });
      expect([403, 404]).toContain(res.status);
    }
    const registered = await h.app.request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ path: other }),
    });
    const project = (await registered.json()) as ProjectView;
    const relinked = await h.app.request(url(`/api/projects/${project.id}/relink`), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ path: h.projectDir }),
    });
    const moved = (await relinked.json()) as ProjectView;
    expect(moved.id).toBe(project.id);
    expect(moved.name).toBe(project.name);
    expect(moved.path).toBe(h.projectDir);
  });

  it("returns JSON 404 for unknown API and 501 for unsupported features", async () => {
    const h = await harness();
    for (const path of ["/api", "/api/nope", "/internal"]) {
      const unknown = await h.app.request(url(path), { headers: cookieHeaders() });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("content-type")).toContain("application/json");
    }
    for (const path of ["/api/projects/proj-1/pins", `/api/runs/${RUN_ID}/pause`]) {
      const unsupported = await h.app.request(url(path), { headers: cookieHeaders() });
      expect(unsupported.status).toBe(501);
      expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
        "E_NOT_SUPPORTED",
      );
    }
  });

  it("rejects oversized chunked bodies without trusting Content-Length", async () => {
    const h = await harness();
    const chunk = new TextEncoder().encode("x".repeat(2 * 1024 * 1024 + 1));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(url("/api/projects"), {
      method: "POST",
      headers: mutationHeaders({ "Content-Length": "10" }),
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await h.app.request(request);
    expect(res.status).toBe(413);
  });

  it("requires auth and same-origin for SSE routes", async () => {
    const h = await harness();
    expect((await h.app.request(url("/api/stream"))).status).toBe(401);
    const foreign = await h.app.request(url("/api/stream"), {
      headers: cookieHeaders({ Origin: "http://evil.test" }),
    });
    expect(foreign.status).toBe(403);
    const ok = await h.app.request(url("/api/stream"), { headers: cookieHeaders() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
  });
});

describe("browser read routes", () => {
  it("pages projects with bounded stable keyset cursors", async () => {
    const h = await harness();
    h.store.projects.push({
      id: "proj-2",
      name: "Second",
      path: h.projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW + 1,
    });
    const first = await h.app.request(url("/api/projects?limit=1"), { headers: cookieHeaders() });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { items: ProjectView[]; nextCursor: string | null };
    expect(page1.items.map((item) => item.id)).toEqual(["proj-1"]);
    expect(page1.nextCursor).not.toBeNull();
    const second = await h.app.request(
      url(`/api/projects?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`),
      { headers: cookieHeaders() },
    );
    const page2 = (await second.json()) as { items: ProjectView[]; nextCursor: string | null };
    expect(page2.items.map((item) => item.id)).toEqual(["proj-2"]);
    expect(page2.nextCursor).toBeNull();
    const overlap = page1.items.filter((item) => page2.items.some((other) => other.id === item.id));
    expect(overlap).toEqual([]);

    for (const query of ["limit=0", "limit=501", "cursor=not-a-cursor"]) {
      const invalid = await h.app.request(url(`/api/projects?${query}`), {
        headers: cookieHeaders(),
      });
      expect(invalid.status).toBe(400);
    }
  });

  it("returns run detail, pages and execution previews with schema validation", async () => {
    const h = await harness();
    const detail = await h.app.request(url(`/api/runs/${RUN_ID}`), { headers: cookieHeaders() });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ view: { status: "queued" }, watermark: 1 });

    expect(
      (await h.app.request(url(`/api/runs/${RUN_ID}/events?after=x`), { headers: cookieHeaders() }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.app.request(url(`/api/runs/${RUN_ID}/events?types=not.real`), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(400);
    const events = await h.app.request(url(`/api/runs/${RUN_ID}/events?limit=10`), {
      headers: cookieHeaders(),
    });
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject({ nextAfter: 1, hasMore: false });

    h.store.events.push({
      id: 2,
      runId: RUN_ID,
      ts: new Date(NOW).toISOString(),
      path: "draft" as Path,
      type: "node.input.resolved",
      actor: "engine",
      v: 1,
      payload: { attempt: 1, generation: 1, inputsHash: "hash", inputs: { topic: "devchestra" } },
    } as EventEnvelope);
    h.store.output = {
      id: "out-1",
      runId: RUN_ID,
      path: "draft" as Path,
      attempt: 1,
      generation: 1,
      hash: "out-hash",
      bytes: 100,
      json: { summary: "<b>not html</b>" },
      createdAt: NOW,
    };
    h.store.history = {
      runId: RUN_ID,
      path: "draft" as Path,
      attempts: [
        {
          attempt: 1,
          generation: 1,
          mode: "fresh",
          startedAt: NOW,
          stoppedAt: null,
          stopReason: null,
          exitCode: null,
          cli: "codex",
          model: null,
          sessionId: null,
          validationAttempts: 0,
          process: null,
        },
      ],
      transcripts: [],
      latestTranscript: null,
    };
    const execution = await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft`), {
      headers: cookieHeaders(),
    });
    expect(execution.status).toBe(200);
    const body = (await execution.json()) as ExecutionDetailResponse;
    expect(body.input?.data).toEqual({ topic: "devchestra" });
    expect(body.output?.data).toEqual({ summary: "<b>not html</b>" });
    expect(body.attempts).toHaveLength(1);
  });

  it("caps inline output previews at 64 KiB", async () => {
    const h = await harness();
    h.store.output = {
      id: "out-big",
      runId: RUN_ID,
      path: "draft" as Path,
      attempt: 1,
      generation: 1,
      hash: "big",
      bytes: 70_000,
      json: { text: "x".repeat(70_000) },
      createdAt: NOW,
    };
    const res = await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft`), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionDetailResponse;
    expect(body.output).toMatchObject({ truncated: true, data: null });
  });

  it("reports a pending transcript before the first ref exists", async () => {
    const h = await harness();
    h.store.history = { ...h.store.history, latestTranscript: null };
    const res = await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft/transcript`), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as TranscriptPageResponse;
    expect(page.state).toBe("pending");
    expect(page.lines).toEqual([]);
  });

  it("pages transcripts, truncates oversized lines and advances the cursor", async () => {
    const h = await harness();
    const transcriptDir = join(h.dataDir, "projects", "proj-1", "runs", RUN_ID, "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const file = join(transcriptDir, "draft.a1.g1.jsonl");
    const big = "x".repeat(300 * 1024);
    await writeFile(
      file,
      `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "text", text: big })}\n${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "text", text: "small" })}\n`,
    );
    h.store.history = {
      ...h.store.history,
      latestTranscript: {
        attempt: 1,
        generation: 1,
        file: "/elsewhere/ignored.jsonl",
        bytes: 1,
        eventId: 2,
        ts: NOW,
      },
    };
    const badCursor = await h.app.request(
      url(`/api/runs/${RUN_ID}/executions/draft/transcript?cursor=abc`),
      { headers: cookieHeaders() },
    );
    expect(badCursor.status).toBe(400);
    const res = await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft/transcript`), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as TranscriptPageResponse;
    expect(page.state).toBe("available");
    expect(page.lines).toHaveLength(2);
    expect(page.lines[0]?.text).toContain("[truncated:");
    expect(page.lines[1]?.text).toBe("small");

    const many = Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "text", text: `line-${index}` }),
    ).join("\n");
    await writeFile(file, `${many}\n`);
    const first = await h.app.request(
      url(`/api/runs/${RUN_ID}/executions/draft/transcript?limit=200`),
      {
        headers: cookieHeaders(),
      },
    );
    const firstPage = (await first.json()) as TranscriptPageResponse;
    expect(firstPage.lines).toHaveLength(200);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe("200");
    const second = await h.app.request(
      url(
        `/api/runs/${RUN_ID}/executions/draft/transcript?limit=200&cursor=${firstPage.nextCursor}`,
      ),
      { headers: cookieHeaders() },
    );
    const secondPage = (await second.json()) as TranscriptPageResponse;
    expect(secondPage.lines).toHaveLength(5);
  });

  it("reads a running node's transcript before its ref event exists", async () => {
    const h = await harness();
    h.store.history = { ...h.store.history, latestTranscript: null };
    const transcriptDir = join(h.dataDir, "projects", "proj-1", "runs", RUN_ID, "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const record = (text: string) =>
      `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "text", text })}\n`;
    const file = join(transcriptDir, "draft.a1.g1.jsonl");
    await writeFile(file, record("working"));
    const res = await h.app.request(
      url(`/api/runs/${RUN_ID}/executions/draft/transcript?format=monitor`),
      {
        headers: cookieHeaders(),
      },
    );
    const page = (await res.json()) as TranscriptPageResponse;
    expect(page.state).toBe("available");
    expect(page.lines.map((line) => line.text)).toEqual(["working"]);
    expect(page.endCursor).toBe("1");
    expect(typeof page.updatedAt).toBe("string");
  });

  it("tails the most recent lines and continues from the end cursor", async () => {
    const h = await harness();
    h.store.history = { ...h.store.history, latestTranscript: null };
    const transcriptDir = join(h.dataDir, "projects", "proj-1", "runs", RUN_ID, "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const record = (text: string) =>
      `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "text", text })}\n`;
    const file = join(transcriptDir, "draft.a1.g1.jsonl");
    await writeFile(
      file,
      Array.from({ length: 10 }, (_, index) => record(`line-${index}`)).join(""),
    );
    const get = async (query: string) =>
      (await (
        await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft/transcript?${query}`), {
          headers: cookieHeaders(),
        })
      ).json()) as TranscriptPageResponse;
    const tail = await get("tail=3");
    expect(tail.lines.map((line) => line.text)).toEqual(["line-7", "line-8", "line-9"]);
    expect(tail.endCursor).toBe(
      `b${Buffer.byteLength(Array.from({ length: 10 }, (_, index) => record(`line-${index}`)).join(""))}`,
    );
    expect(tail.hasMore).toBe(false);

    await writeFile(
      file,
      `${await readFile(file, "utf8")}${record("line-10")}${record("line-11")}`,
    );
    const next = await get(`cursor=${tail.endCursor}`);
    expect(next.lines.map((line) => line.text)).toEqual(["line-10", "line-11"]);
    expect(next.endCursor).toBe(`b${Buffer.byteLength(await readFile(file))}`);
    const idle = await get(`cursor=${next.endCursor}`);
    expect(idle.lines).toEqual([]);
    expect(idle.endCursor).toBe(next.endCursor);

    const both = await h.app.request(
      url(`/api/runs/${RUN_ID}/executions/draft/transcript?tail=2&cursor=3`),
      { headers: cookieHeaders() },
    );
    expect(both.status).toBe(400);
  });

  it("does not count a half-written trailing line", async () => {
    const h = await harness();
    h.store.history = { ...h.store.history, latestTranscript: null };
    const transcriptDir = join(h.dataDir, "projects", "proj-1", "runs", RUN_ID, "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const whole = `${JSON.stringify({ ts: null, kind: "text", text: "done" })}\n`;
    const file = join(transcriptDir, "draft.a1.g1.jsonl");
    await writeFile(file, `${whole}{"ts":null,"kind":"te`);
    const get = async (query: string) =>
      (await (
        await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft/transcript?${query}`), {
          headers: cookieHeaders(),
        })
      ).json()) as TranscriptPageResponse;
    expect((await get("tail=5")).endCursor).toBe(`b${Buffer.byteLength(whole)}`);
    expect((await get("limit=5&format=monitor")).endCursor).toBe("1");
    await writeFile(file, `${whole}${JSON.stringify({ ts: null, kind: "text", text: "next" })}\n`);
    const resumed = await get("cursor=1");
    expect(resumed.lines.map((line) => line.text)).toEqual(["next"]);
  });

  it("preserves legacy transcript responses and incomplete oversized cursors", async () => {
    const h = await harness();
    h.store.history = { ...h.store.history, latestTranscript: null };
    const dir = join(h.dataDir, "projects", "proj-1", "runs", RUN_ID, "transcripts");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "draft.a1.g1.jsonl");
    const whole = `${JSON.stringify({ kind: "text", text: "done" })}\n`;
    const partial = `{"kind":"text","text":"${"a".repeat(1100000)}`;
    await writeFile(file, whole + partial);
    const get = async (query: string) =>
      (await (
        await h.app.request(url(`/api/runs/${RUN_ID}/executions/draft/transcript?${query}`), {
          headers: cookieHeaders(),
        })
      ).json()) as TranscriptPageResponse;
    const legacy = await get("");
    expect(legacy).not.toHaveProperty("endCursor");
    expect(legacy).not.toHaveProperty("updatedAt");
    const page = await get("format=monitor");
    const tail = await get("tail=5");
    expect(page.endCursor).toBe("1");
    expect(tail.endCursor).toBe(`b${Buffer.byteLength(whole)}`);
    await writeFile(file, `${whole}${partial}"}\n`);
    expect((await get(`cursor=${page.endCursor}&format=monitor`)).lines[0]?.kind).toBe("notice");
    const resumed = await get(`cursor=${tail.endCursor}&format=monitor`);
    expect(resumed.lines[0]?.kind).toBe("notice");
    expect(resumed.endCursor).toBe(`b${Buffer.byteLength(await readFile(file))}`);
  });

  it("accepts cancel and resume commands with 202", async () => {
    const h = await harness();
    const cancel = await h.app.request(url(`/api/runs/${RUN_ID}/cancel`), {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    });
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({ runId: RUN_ID, status: "cancelled" });
    const resume = await h.app.request(url(`/api/runs/${RUN_ID}/resume`), {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    });
    expect(resume.status).toBe(202);
    expect(await resume.json()).toEqual({ runId: RUN_ID, status: "queued" });
  });

  it("starts a validated relative workflow and replies 202", async () => {
    const h = await harness();
    await writeFile(
      join(h.projectDir, "wf.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "wf",
        name: "Workflow",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
          ],
          edges: [{ id: "e1", from: "start", to: "done" }],
        },
      }),
    );
    const res = await h.app.request(url("/api/projects/proj-1/runs"), {
      method: "POST",
      headers: mutationHeaders({ "Idempotency-Key": "idem-1" }),
      body: JSON.stringify({ workflowFile: "wf.json", params: {} }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: RUN_ID, duplicate: false, status: "queued" });
    expect(h.starts[0]?.idempotencyKey).toBe("idem-1");
    expect(h.starts[0]?.workflowId).toBe("wf");

    const traversal = await h.app.request(url("/api/projects/proj-1/runs"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ workflowFile: "../wf.json" }),
    });
    expect([400, 403]).toContain(traversal.status);

    const project = h.store.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    project.missing = true;
    const missing = await h.app.request(url("/api/projects/proj-1/runs"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ workflowFile: "wf.json" }),
    });
    expect(missing.status).toBe(409);
  });

  it("keeps unknown launch errors generic and secret-free", async () => {
    const secret = "sk-live-DEADBEEF";
    const h = await harness({
      logger: true,
      controller: {
        startRun() {
          throw new CoreDevChestraError(
            "E_VALIDATION",
            `provider failed with ${secret} at /home/person/.claude/credentials.json`,
          );
        },
        cancelRun(runId) {
          return { runId: runId as RunId, status: "cancelled" };
        },
        resumeRun(runId) {
          return { runId: runId as RunId, status: "queued" };
        },
        resolveApproval() {
          throw new Error("unused");
        },
      },
    });
    await writeFile(
      join(h.projectDir, "wf.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "wf",
        name: "Workflow",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
          ],
          edges: [{ id: "e1", from: "start", to: "done" }],
        },
      }),
    );
    const res = await h.app.request(url("/api/projects/proj-1/runs"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ workflowFile: "wf.json", params: {} }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "E_VALIDATION", message: "The request is invalid." },
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("/home/person");
    expect(h.logs.join("\n")).not.toContain(secret);
    expect(h.logs.join("\n")).not.toContain("/home/person");
    expect(h.starts).toHaveLength(0);
  });

  it("normalizes store/core error codes to their declared HTTP statuses", async () => {
    const h = await harness();
    const cases: [string, number][] = [
      ["E_VALIDATION", 400],
      ["E_FORBIDDEN_PATH", 403],
      ["E_NOT_FOUND", 404],
      ["E_CONFLICT", 409],
      ["E_LOCKED", 409],
      ["E_PAYLOAD_TOO_LARGE", 413],
      ["E_RATE_LIMIT", 429],
      ["E_NOT_SUPPORTED", 501],
      ["E_INTERNAL", 500],
    ];
    for (const [code, status] of cases) {
      h.store.failWith = code;
      const res = await h.app.request(url("/api/bootstrap"), { headers: cookieHeaders() });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("does not leak session tokens in errors or logs", async () => {
    const h = await harness({ logger: true });
    h.store.fail = true;
    const res = await h.app.request(url("/api/bootstrap"), {
      headers: cookieHeaders({ "X-DevChestra-Token": TOKEN }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("x-devchestra-api")).toBe("1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("live loopback listener", () => {
  it("serves health, bootstrap redirect and session auth over real HTTP", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "devchestra-browser-live-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "devchestra-browser-live-project-"));
    const store = new FakeStore();
    store.projects.push({
      id: "proj-1",
      name: "Project",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW,
    });
    store.projects.push({
      id: "proj-2",
      name: "Second",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW + 1,
    });
    const server = await startBrowserServer({
      dataDir,
      store,
      controller: fakeController([]),
      sessionToken: TOKEN,
      instanceId: "live-instance",
      version: "0.1.0-test",
      port: 0,
      validateResponses: true,
      now: () => NOW,
    });
    cleanups.push(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ instanceId: "live-instance" });

    const anonymous = await fetch(`${server.url}/api/bootstrap`);
    expect(anonymous.status).toBe(401);

    const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/");
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).not.toBeNull();

    const cookieHeader = cookie?.split(";", 1)[0] ?? "";
    const authed = await fetch(`${server.url}/api/bootstrap`, {
      headers: { Cookie: cookieHeader },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toMatchObject({ instanceId: "live-instance" });

    const firstPageResponse = await fetch(`${server.url}/api/projects?limit=1`, {
      headers: { Cookie: cookieHeader },
    });
    const firstPage = (await firstPageResponse.json()) as {
      items: ProjectView[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((item) => item.id)).toEqual(["proj-1"]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPageResponse = await fetch(
      `${server.url}/api/projects?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: { Cookie: cookieHeader } },
    );
    const secondPage = (await secondPageResponse.json()) as {
      items: ProjectView[];
      nextCursor: string | null;
    };
    expect(secondPage.items.map((item) => item.id)).toEqual(["proj-2"]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

describe("static serving", () => {
  it("blocks traversal and symlink escapes and caches hashed assets", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "devchestra-browser-web-"));
    const outside = await mkdtemp(join(tmpdir(), "devchestra-browser-secret-"));
    cleanups.push(async () => {
      await rm(webRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<html>APP</html>");
    await writeFile(join(webRoot, "assets", "app-abc123.js"), "console.log('ok')");
    await writeFile(join(outside, "secret.txt"), "TOP SECRET");
    await symlink(join(outside, "secret.txt"), join(webRoot, "assets", "leak.txt"));
    const h = await harness({ webRoot });

    const asset = await h.app.request(url("/assets/app-abc123.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const traversal = await h.app.request(url("/assets/%2e%2e/%2e%2e/secret.txt"));
    expect(traversal.status).toBe(404);
    const leak = await h.app.request(url("/assets/leak.txt"));
    expect(leak.status).toBe(404);
    const spa = await h.app.request(url("/p/proj-1/runs"), { headers: cookieHeaders() });
    expect(await spa.text()).toContain("APP");
    for (const path of [
      "/settings",
      "/settings/providers",
      "/settings/models",
      "/settings/usage",
      "/p/proj-1/settings",
      "/p/proj-1/settings/providers",
      "/p/proj-1/settings/models",
      "/p/proj-1/settings/usage",
    ]) {
      const settings = await h.app.request(url(path), { headers: cookieHeaders() });
      expect(settings.status, path).toBe(200);
      expect(await settings.text()).toContain("APP");
    }
    const unknownSettings = await h.app.request(url("/settings/nope"), {
      headers: cookieHeaders(),
    });
    expect(unknownSettings.status).toBe(404);
    const unknown = await h.app.request(url("/not-an-app-route"));
    expect(unknown.status).toBe(404);
  });
});

describe("real store DTO validation", () => {
  it("serves run detail and events from the real store", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "devchestra-browser-store-"));
    const projectDir = await mkdtemp(join(tmpdir(), "devchestra-browser-store-project-"));
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    cleanups.push(async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    store.projects.ensure({ id: "proj-real", name: "Real", path: projectDir, kind: "folder" });
    const vanished = await mkdtemp(join(tmpdir(), "devchestra-browser-vanished-"));
    store.projects.ensure({
      id: "proj-vanished",
      name: "Vanished",
      path: vanished,
      kind: "folder",
    });
    await rm(vanished, { recursive: true, force: true });
    const created = store.runs.create({
      projectId: "proj-real",
      workflowId: "wf",
      workflowHash: "hash",
      snapshot: SNAPSHOT,
      snapshotRaw: "{}",
    });
    const app = createBrowserApp({
      dataDir,
      store: createStoreQueryPort(store),
      controller: fakeController([]),
      sessionToken: TOKEN,
      instanceId: "instance-real",
      version: "0.1.0-test",
      port: PORT,
      validateResponses: true,
      now: () => NOW,
    });
    const detail = await app.request(url(`/api/runs/${created.runId}`), {
      headers: cookieHeaders(),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as RunDetailResponse;
    expect(body.run.id).toBe(created.runId);
    expect(body.snapshot.id).toBe("wf");
    expect(body.watermark).toBeGreaterThan(0);
    expect(body.workspace).toBeNull();

    const frozen = store.runs.create({
      projectId: "proj-real",
      workflowId: "wf",
      workflowHash: "hash",
      snapshot: SNAPSHOT,
      snapshotRaw: "{}",
      workspace: {
        selection: { mode: "new-worktree" },
        projectRoot: projectDir,
      },
    });
    const frozenDetail = await app.request(url(`/api/runs/${frozen.runId}`), {
      headers: cookieHeaders(),
    });
    expect(frozenDetail.status).toBe(200);
    const frozenBody = (await frozenDetail.json()) as RunDetailResponse;
    expect(frozenBody.workspace).toEqual({ mode: "new-worktree" });
    expect(JSON.stringify(frozenBody)).not.toContain(projectDir);

    const events = await app.request(url(`/api/runs/${created.runId}/events?limit=50`), {
      headers: cookieHeaders(),
    });
    expect(events.status).toBe(200);
    const eventBody = (await events.json()) as EventPageResponse;
    expect(eventBody.events.length).toBeGreaterThan(0);
    expect(eventBody.nextAfter).toBeGreaterThan(0);

    const missing = await app.request(url(`/api/runs/${RUN_ID}/events`), {
      headers: cookieHeaders(),
    });
    expect(missing.status).toBe(404);
    const projects = await app.request(url("/api/projects"), { headers: cookieHeaders() });
    const projectsBody = (await projects.json()) as { items: ProjectView[] };
    expect(projectsBody.items.find((item) => item.id === "proj-vanished")?.missing).toBe(true);

    const missingDetail = await app.request(url(`/api/runs/${RUN_ID}`), {
      headers: cookieHeaders(),
    });
    expect(missingDetail.status).toBe(404);
    expect(((await missingDetail.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_FOUND",
    );
  });

  it("serves normalized worktree agent and shell snapshots without rewriting them", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "devchestra-browser-worktree-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "devchestra-browser-worktree-project-"));
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    cleanups.push(async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    store.projects.ensure({
      id: "proj-worktree",
      name: "Worktree",
      path: projectDir,
      kind: "git",
    });
    const snapshot: NormalizedWorkflow = {
      schemaVersion: 1,
      id: "wf-worktree",
      name: "Worktree",
      graph: {
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            supervise: "default",
            env: [],
            params: [],
          },
          {
            id: "agent",
            type: "agent",
            name: "Agent",
            supervise: "default",
            env: [],
            cli: "codex",
            prompt: "do it",
            output: { type: "object" },
            permissions: { network: false, write: [] },
            workspace: { mode: "worktree" },
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
            workspace: { mode: "worktree" },
            timeoutMin: 10,
            allowFailure: false,
          },
          {
            id: "done",
            type: "end",
            name: "Done",
            supervise: "default",
            env: [],
            status: "success",
            result: '{"ok":true}',
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "agent" },
          { id: "e2", from: "agent", to: "shell" },
          { id: "e3", from: "shell", to: "done" },
        ],
      },
    };
    const created = store.runs.create({
      projectId: "proj-worktree",
      workflowId: "wf-worktree",
      workflowHash: "hash",
      snapshot,
      snapshotRaw: "{}",
    });
    const app = createBrowserApp({
      dataDir,
      store: createStoreQueryPort(store),
      controller: fakeController([]),
      sessionToken: TOKEN,
      instanceId: "instance-worktree",
      version: "0.1.0-test",
      port: PORT,
      validateResponses: true,
      now: () => NOW,
    });
    const detail = await app.request(url(`/api/runs/${created.runId}`), {
      headers: cookieHeaders(),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as RunDetailResponse;
    const nodes = body.snapshot.graph.nodes;
    expect(nodes.find((node) => node.id === "agent")).toMatchObject({
      type: "agent",
      workspace: { mode: "worktree" },
    });
    expect(nodes.find((node) => node.id === "shell")).toMatchObject({
      type: "shell",
      workspace: { mode: "worktree" },
    });
  });
});

describe("usage summary endpoint", () => {
  it("serves empty totals and validates scope/projectId", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "devchestra-browser-usage-"));
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    cleanups.push(async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    store.projects.ensure({ id: "proj-usage", name: "Usage", path: dataDir, kind: "folder" });
    const app = createBrowserApp({
      dataDir,
      store: createStoreQueryPort(store),
      controller: fakeController([]),
      sessionToken: TOKEN,
      instanceId: "instance-usage",
      version: "0.1.0-test",
      port: PORT,
      validateResponses: true,
      now: () => NOW,
    });

    const empty = await app.request(url("/api/usage"), { headers: cookieHeaders() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      total: { usd: 0, tokens: 0 },
      byProvider: [],
      byProject: [],
    });

    const scoped = await app.request(url("/api/usage?scope=project&projectId=proj-usage"), {
      headers: cookieHeaders(),
    });
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toEqual({
      total: { usd: 0, tokens: 0 },
      byProvider: [],
      byProject: [],
    });

    const missingScope = await app.request(url("/api/usage?scope=project"), {
      headers: cookieHeaders(),
    });
    expect(missingScope.status).toBe(400);
    expect(((await missingScope.json()) as { error: { code: string } }).error.code).toBe(
      "E_VALIDATION",
    );

    const globalWithId = await app.request(url("/api/usage?scope=global&projectId=proj-usage"), {
      headers: cookieHeaders(),
    });
    expect(globalWithId.status).toBe(400);

    const missingProject = await app.request(url("/api/usage?scope=project&projectId=nope"), {
      headers: cookieHeaders(),
    });
    expect(missingProject.status).toBe(404);
    expect(((await missingProject.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_FOUND",
    );
  });
});
