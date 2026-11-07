import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSettingsResponse, SettingsResponse } from "@devchestra/api";
import type { RunId } from "@devchestra/core";
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
    ...(mutation ? { "Content-Type": "application/json", "X-DevChestra-Csrf": "1" } : {}),
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
  root = await mkdtemp(join(tmpdir(), "devchestra-settings-http-"));
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
    instanceId: "settings-http",
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

describe("settings HTTP routes", () => {
  const local = "/api/projects/proj-1/settings/local";
  const shared = "/api/projects/proj-1/settings/project";
  const effective = "/api/projects/proj-1/settings/effective";
  const high = { version: 1, models: { high: { cli: "claude-code", model: "opus" } } };

  it("reads an empty layer, saves it with its etag and rejects a stale one", async () => {
    const first = await json<SettingsResponse>("GET", local);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ scope: "local", exists: false });
    expect(first.headers.get("etag")).toBe(`"${first.body.etag}"`);

    const saved = await json<SettingsResponse>("PUT", local, high, {
      "If-Match": `"${first.body.etag}"`,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ exists: true, document: high });

    const stale = await json("PUT", local, high, { "If-Match": `"${first.body.etag}"` });
    expect(stale.status).toBe(409);
  });

  it("requires If-Match and rejects unknown tiers, clis and keys", async () => {
    const first = await json<SettingsResponse>("GET", local);
    const match = { "If-Match": `"${first.body.etag}"` };
    expect((await json("PUT", local, high)).status).toBe(400);
    for (const bad of [
      { version: 1, models: { ultra: { cli: "pi" } } },
      { version: 1, models: { high: { cli: "fake" } } },
      { version: 1, models: { high: { cli: "pi", effort: "x" } } },
      { version: 2 },
    ]) {
      expect((await json("PUT", local, bad, match)).status).toBe(400);
    }
  });

  it("returns 404 for an unknown scope", async () => {
    expect((await json("GET", "/api/projects/proj-1/settings/team")).status).toBe(404);
    expect((await json("GET", "/api/projects/nope/settings/local")).status).toBe(404);
  });

  it("reports the effective mapping with the local layer winning", async () => {
    const sharedFirst = await json<SettingsResponse>("GET", shared);
    await json(
      "PUT",
      shared,
      { version: 1, models: { low: { cli: "pi" }, high: { cli: "codex" } } },
      {
        "If-Match": `"${sharedFirst.body.etag}"`,
      },
    );
    const localFirst = await json<SettingsResponse>("GET", local);
    await json("PUT", local, high, { "If-Match": `"${localFirst.body.etag}"` });

    const result = await json<EffectiveSettingsResponse>("GET", effective);
    expect(result.status).toBe(200);
    expect(result.body.tiers).toEqual([
      { tier: "high", mapping: { ref: { cli: "claude-code", model: "opus" }, source: "local" } },
      { tier: "medium", mapping: null },
      { tier: "low", mapping: { ref: { cli: "pi" }, source: "project" } },
    ]);
  });
});
