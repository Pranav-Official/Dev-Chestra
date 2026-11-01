import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@devchestra/core";
import { normalizeWorkflow, parseWorkflow } from "@devchestra/schema";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountRunStartRoute } from "../src/browser/run-start-route.js";
import type {
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
  ProjectView,
  StartRunCommand,
} from "../src/index.js";
import { mountWorkflowRoutes } from "../src/workflows/routes.js";
import type { ManagedWorkflowService } from "../src/workflows/service.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
const WORKFLOW_FILE = ".devchestra/workflows/codex-flow.json";

const WORKFLOW = {
  schemaVersion: 1,
  id: "codex-flow",
  name: "Codex flow",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      {
        id: "work",
        type: "agent",
        name: "Work",
        cli: "codex",
        prompt: "Do nothing.",
        output: { type: "object", properties: { ok: { type: "boolean" } } },
        permissions: { network: false, write: [] },
        workspace: { mode: "scratch" },
        limits: { validationRetries: 0, crashRetries: 0 },
      },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ],
    edges: [
      { id: "e1", from: "start", to: "work" },
      { id: "e2", from: "work", to: "end" },
    ],
  },
};

let root: string;
let projectPath: string;
let dataDir: string;
let started: StartRunCommand[];

function settings(disabled: string[]): BrowserProviderSettingsPort {
  const off = new Set(disabled);
  return {
    list: () => [],
    setEnabled: () => undefined,
    disabled: () => new Set(off),
  };
}

function project(): ProjectView {
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
  const view = project();
  return {
    getProject: (id: string) => (id === view.id ? view : null),
  } as unknown as BrowserQueryPort;
}

function controller(): BrowserRunControllerPort {
  return {
    startRun: (input: StartRunCommand) => {
      started.push(input);
      return { runId: RUN_ID, duplicate: false, status: "queued" };
    },
  } as unknown as BrowserRunControllerPort;
}

function snapshot() {
  const parsed = parseWorkflow(WORKFLOW);
  if (!parsed.ok) throw parsed.error;
  const normalized = normalizeWorkflow(parsed.value);
  if (!normalized.ok) throw normalized.error;
  return {
    workflowId: "codex-flow",
    workflowFile: WORKFLOW_FILE,
    snapshot: normalized.value,
    snapshotRaw: JSON.stringify(WORKFLOW),
    workflowHash: "hash",
    params: {},
  };
}

function runStartApp(providerSettings?: BrowserProviderSettingsPort): Hono {
  const app = new Hono();
  mountRunStartRoute(app, {
    store: store(),
    controller: controller(),
    dataDir,
    ...(providerSettings === undefined ? {} : { providerSettings }),
    validate: () => undefined,
  });
  return app;
}

function workflowsApp(providerSettings?: BrowserProviderSettingsPort): Hono {
  const app = new Hono();
  const service = { run: async () => snapshot() } as unknown as ManagedWorkflowService;
  mountWorkflowRoutes(app, {
    store: store(),
    controller: controller(),
    service,
    dataDir,
    ...(providerSettings === undefined ? {} : { providerSettings }),
    validate: () => undefined,
  });
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devchestra-launch-guard-"));
  mkdirSync(join(root, "project"), { recursive: true });
  projectPath = realpathSync(join(root, "project"));
  dataDir = join(root, "data");
  mkdirSync(join(projectPath, ".devchestra", "workflows"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(projectPath, WORKFLOW_FILE), JSON.stringify(WORKFLOW));
  started = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("provider launch guard on POST /api/projects/:pid/runs", () => {
  it("returns 409 E_CLI_DISABLED and starts nothing when a needed provider is off", async () => {
    const res = await post(runStartApp(settings(["codex"])), "/api/projects/proj-1/runs", {
      workflowFile: WORKFLOW_FILE,
      params: {},
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { clis: string[] } };
    };
    expect(body.error.code).toBe("E_CLI_DISABLED");
    expect(body.error.message).toBe("Codex is turned off. Turn it on in Settings > Providers.");
    expect(body.error.details.clis).toEqual(["codex"]);
    expect(started).toHaveLength(0);
  });

  it("starts the run when the provider is on", async () => {
    const res = await post(runStartApp(settings([])), "/api/projects/proj-1/runs", {
      workflowFile: WORKFLOW_FILE,
      params: {},
    });
    expect(res.status).toBe(202);
    expect(started).toHaveLength(1);
  });

  it("starts the run when no settings port is wired", async () => {
    const res = await post(runStartApp(), "/api/projects/proj-1/runs", {
      workflowFile: WORKFLOW_FILE,
      params: {},
    });
    expect(res.status).toBe(202);
    expect(started).toHaveLength(1);
  });

  it("ignores a disabled provider the workflow does not use", async () => {
    const res = await post(runStartApp(settings(["pi"])), "/api/projects/proj-1/runs", {
      workflowFile: WORKFLOW_FILE,
      params: {},
    });
    expect(res.status).toBe(202);
    expect(started).toHaveLength(1);
  });
});

describe("provider launch guard on POST /api/projects/:pid/workflows/:wid/runs", () => {
  const body = { params: {}, etag: "0".repeat(64) };

  it("returns 409 E_CLI_DISABLED and starts nothing when a needed provider is off", async () => {
    const res = await post(
      workflowsApp(settings(["codex"])),
      "/api/projects/proj-1/workflows/codex-flow/runs",
      body,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("E_CLI_DISABLED");
    expect(started).toHaveLength(0);
  });

  it("starts the run when the provider is on", async () => {
    const res = await post(
      workflowsApp(settings([])),
      "/api/projects/proj-1/workflows/codex-flow/runs",
      body,
    );
    expect(res.status).toBe(202);
    expect(started).toHaveLength(1);
  });
});
