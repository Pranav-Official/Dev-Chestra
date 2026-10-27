import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWorkspacesResponse, RunWorkspaceSelection } from "@relay/api";
import type { RunId } from "@relay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserQueryPort,
  type BrowserRunControllerPort,
  type BrowserWorkspacePort,
  type ProjectView,
  RelayError,
  type RunningBrowserServer,
  type StartRunCommand,
  type StartRunResponse,
  startBrowserServer,
} from "../src/index.js";

const TOKEN = "c".repeat(43);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

let root: string;
let dataDir: string;
let projectPath: string;
let worktreePath: string;
let server: RunningBrowserServer;
let cookie: string;
let started: StartRunCommand[];
let catalogCalls: string[];
let validateCalls: RunWorkspaceSelection[];

function projectView(): ProjectView {
  return {
    id: "proj-1",
    name: "Project",
    path: projectPath,
    kind: "git",
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

function workspaceService(): BrowserWorkspacePort {
  const catalog: ProjectWorkspacesResponse = {
    projectRoot: projectPath,
    worktrees: [{ path: worktreePath, branch: "feature", head: "a".repeat(40), detached: false }],
    git: true,
  };
  return {
    catalog(rootPath) {
      catalogCalls.push(rootPath);
      return catalog;
    },
    validate(_rootPath, selection) {
      validateCalls.push(selection);
      if (selection.mode === "existing-worktree" && selection.path !== worktreePath) {
        throw new RelayError("E_VALIDATION", "That path is not a worktree of this project.");
      }
      return selection;
    },
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

async function createWorkflow(): Promise<string> {
  const created = await json<{ etag: string }>("POST", "/api/projects/proj-1/workflows", {
    name: "Workspace Flow",
    template: "linear-fake",
  });
  expect(created.status).toBe(201);
  return created.body.etag;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-ws-http-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  worktreePath = join(root, "worktree");
  started = [];
  catalogCalls = [];
  validateCalls = [];
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(join(projectPath, ".relay", "workflows"), { recursive: true });
  server = await startBrowserServer({
    dataDir,
    store: store(),
    controller: controller(),
    workspaceService: workspaceService(),
    sessionToken: TOKEN,
    instanceId: "workspace-http",
    version: "0.1.0-test",
    port: 0,
    validateResponses: true,
    now: () => 1_700_000_000_000,
  });
  const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
});

afterEach(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe("workspace HTTP routes", () => {
  it("returns the worktree catalog and requires a browser session", async () => {
    const anonymous = await fetch(url("/api/projects/proj-1/workspaces"), {
      headers: { Host: new URL(server.url).host },
    });
    expect(anonymous.status).toBe(401);

    const listed = await json<ProjectWorkspacesResponse>("GET", "/api/projects/proj-1/workspaces");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      projectRoot: projectPath,
      worktrees: [{ path: worktreePath, branch: "feature", head: "a".repeat(40), detached: false }],
      git: true,
    });
    expect(catalogCalls).toEqual([projectPath]);

    const missing = await json("GET", "/api/projects/nope/workspaces");
    expect(missing.status).toBe(404);
  });

  it("propagates an existing-worktree selection after read-only validation", async () => {
    const etag = await createWorkflow();
    const selection = { mode: "existing-worktree" as const, path: worktreePath };
    const response = await json<StartRunResponse>(
      "POST",
      "/api/projects/proj-1/workflows/workspace-flow/runs",
      { etag, workspace: selection },
    );
    expect(response.status).toBe(202);
    expect(started).toHaveLength(1);
    expect(started[0]?.workspace).toEqual(selection);
    expect(validateCalls).toEqual([selection]);
    expect(catalogCalls).toHaveLength(0);
  });

  it("defaults an omitted workspace to the project root", async () => {
    const etag = await createWorkflow();
    const response = await json<StartRunResponse>(
      "POST",
      "/api/projects/proj-1/workflows/workspace-flow/runs",
      { etag },
    );
    expect(response.status).toBe(202);
    expect(started[0]?.workspace).toEqual({ mode: "project" });
    expect(validateCalls).toEqual([]);
  });

  it("rejects an unlisted existing worktree before creating a run", async () => {
    const etag = await createWorkflow();
    const response = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/workflows/workspace-flow/runs",
      { etag, workspace: { mode: "existing-worktree", path: join(root, "elsewhere") } },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("E_VALIDATION");
    expect(started).toHaveLength(0);
  });

  it("rejects a missing CSRF header or malformed body before validation", async () => {
    const etag = await createWorkflow();
    const noCsrf = await fetch(url("/api/projects/proj-1/workflows/workspace-flow/runs"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ etag, workspace: { mode: "new-worktree" } }),
    });
    expect(noCsrf.status).toBe(403);

    const malformed = await json("POST", "/api/projects/proj-1/workflows/workspace-flow/runs", {
      etag,
      workspace: { selection: { mode: "new-worktree" } },
    });
    expect(malformed.status).toBe(400);
    expect(started).toHaveLength(0);
    expect(validateCalls).toEqual([]);
  });

  it("propagates selection on the legacy project run route too", async () => {
    await writeFile(
      join(projectPath, "flow.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "legacy-flow",
        name: "Legacy",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "done", type: "end", name: "Done", status: "success", result: '{"ok":true}' },
          ],
          edges: [{ id: "e1", from: "start", to: "done" }],
        },
      }),
    );
    const response = await json<StartRunResponse>("POST", "/api/projects/proj-1/runs", {
      workflowFile: "flow.json",
      workspace: { mode: "new-worktree" },
    });
    expect(response.status).toBe(202);
    expect(started[0]?.workspace).toEqual({ mode: "new-worktree" });
    expect(validateCalls).toEqual([{ mode: "new-worktree" }]);
  });
});
