import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevChestraError as CoreDevChestraError, FakeClock, FakeIdGen } from "@devchestra/core";
import { normalizeWorkflow, type WorkflowFile } from "@devchestra/schema";
import { openStore, type Store } from "@devchestra/store";
import type { Hono } from "hono";
import {
  type BrowserRunControllerPort,
  type BrowserWebhookPorts,
  type BrowserWorkspacePort,
  createBrowserApp,
  createStoreQueryPort,
  DevChestraError,
  type WebhookRunCommand,
} from "../src/index.js";

export const TOKEN = "c".repeat(43);
export const PORT = 51_777;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const COOKIE = `devchestra_session=${TOKEN}`;
export const PROJECT_ID = "proj-hooks";
export const WORKFLOW_ID = "hook";
export const CHILD_ID = "child";
const NOW = Date.UTC(2026, 0, 1);

export interface Harness {
  readonly app: Hono;
  readonly store: Store;
  readonly projectPath: string;
  readonly dataDir: string;
  readonly launches: WebhookRunCommand[];
  readonly freezeCalls: string[];
  readonly pumps: { count: number };
  /** Whether the workspace preflight treats the project as a Git repository. */
  git: boolean;
  /** Makes the fake engine refuse every launch with this core error code; null restores it. */
  failLaunchWith(code: string | null): void;
  writeWorkflow(id: string, file: unknown): void;
  workflowPath(id: string): string;
  removeWorkflow(id: string): void;
  close(): void;
}

export interface HarnessOptions {
  readonly git?: boolean;
  readonly webRoot?: string;
  readonly maxQueueDepth?: number;
}

const openHarnesses: Harness[] = [];

/** Shape of a workflow file the tests write. Ids and mappings are per test. */
export function hookWorkflow(
  options: {
    id?: string;
    webhook?: boolean;
    mapping?: Record<string, string>;
    params?: { name: string; type: string; required?: boolean }[];
    edgeTo?: string;
  } = {},
): Record<string, unknown> {
  const webhook =
    options.webhook === false
      ? {}
      : {
          webhook: {
            enabled: true,
            paramMapping: options.mapping ?? { title: "body.issue.title" },
          },
        };
  return {
    schemaVersion: 1,
    id: options.id ?? WORKFLOW_ID,
    name: "Hook",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: options.params ?? [{ name: "title", type: "string", required: true }],
          ...webhook,
        },
        { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
      ],
      edges: [{ id: "e1", from: "start", to: options.edgeTo ?? "done" }],
    },
  };
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-webhooks-"));
  const projectPath = join(dir, "project");
  const dataDir = join(dir, "data");
  mkdirSync(join(projectPath, ".devchestra", "workflows"), { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = openStore({
    file: join(dataDir, "devchestra.db"),
    clock: new FakeClock(NOW),
    idGen: new FakeIdGen("wh"),
  });
  store.projects.ensure({ id: PROJECT_ID, name: "Project", path: projectPath, kind: "git" });
  if (options.maxQueueDepth !== undefined) {
    store.executionSettings.set({ maxConcurrentRuns: 1, maxQueueDepth: options.maxQueueDepth });
  }

  const launches: WebhookRunCommand[] = [];
  const freezeCalls: string[] = [];
  const pumps = { count: 0 };
  const harness: { git: boolean; failLaunch: string | null } = {
    git: options.git ?? true,
    failLaunch: null,
  };

  const workspaceService: BrowserWorkspacePort = {
    catalog: () => {
      throw new DevChestraError("E_NOT_SUPPORTED", "catalog is not used by webhook tests");
    },
    validate: (_root, selection) => {
      if (!harness.git) {
        throw new DevChestraError("E_VALIDATION", "Worktree selections require a Git project");
      }
      return selection;
    },
  };

  // Mirrors the engine launch order: dedupe, armed check, enqueue, bind. Runs go
  // through the real store so queue depth and delivery claims are the real ones.
  const webhooks: BrowserWebhookPorts = {
    store,
    runs: {
      launch: async (command) => {
        launches.push(command);
        if (harness.failLaunch !== null) {
          throw new CoreDevChestraError(
            harness.failLaunch as ConstructorParameters<typeof CoreDevChestraError>[0],
            "The engine refused this launch.",
          );
        }
        return store.tx(() => {
          const delivery = command.delivery;
          const claim = store.webhooks.claimDelivery({
            hookId: delivery.hookId,
            deliveryId: delivery.deliveryId,
            fingerprint: delivery.fingerprint,
          });
          if (claim.kind === "duplicate") {
            return { runId: claim.runId, duplicate: true, completion: Promise.resolve() };
          }
          store.webhooks.assertArmedRevision(delivery.hookId, delivery.armedRevision);
          const made = store.runs.enqueue({
            projectId: command.projectId,
            workflowId: command.workflowId,
            workflowHash: "test-hash",
            snapshot: command.snapshot,
            snapshotRaw: command.snapshotRaw,
            params: command.params,
            workspace: { selection: command.workspace, projectRoot: projectPath },
          });
          store.webhooks.bindDelivery(delivery.hookId, claim.key, made.runId);
          return {
            runId: made.runId,
            duplicate: made.duplicate,
            completion: new Promise<unknown>(() => undefined),
          };
        });
      },
      pumpQueue: () => {
        pumps.count += 1;
      },
    },
    freeze: {
      // Test stand-in for the engine walk: the child file, when present, is the only
      // transitive dependency. Invalid child files fail the freeze like a real walk.
      freeze: async (_projectId, workflowId) => {
        freezeCalls.push(workflowId);
        const bundle: Record<string, unknown> = {};
        const childPath = join(projectPath, ".devchestra", "workflows", `${CHILD_ID}.json`);
        if (existsSync(childPath)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(readFileSync(childPath, "utf8"));
          } catch {
            throw new CoreDevChestraError("E_VALIDATION", "Child workflow is not valid JSON.");
          }
          const normalized = normalizeWorkflow(parsed as WorkflowFile);
          if (!normalized.ok) throw normalized.error;
          bundle[CHILD_ID] = normalized.value;
        }
        return bundle;
      },
    },
  };

  const controller: BrowserRunControllerPort = {
    startRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "startRun is not used by webhook tests");
    },
    cancelRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "cancelRun is not used by webhook tests");
    },
    resumeRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "resumeRun is not used by webhook tests");
    },
    resolveApproval: () => {
      throw new CoreDevChestraError("E_INTERNAL", "resolveApproval is not used by webhook tests");
    },
  };

  const app = createBrowserApp({
    dataDir,
    store: createStoreQueryPort(store),
    controller,
    sessionToken: TOKEN,
    instanceId: "webhook-test",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => NOW,
    workspaceService,
    webhooks,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  });

  const workflowPath = (id: string): string =>
    join(projectPath, ".devchestra", "workflows", `${id}.json`);
  const harnessApi: Harness = {
    app,
    store,
    projectPath,
    dataDir,
    launches,
    freezeCalls,
    pumps,
    get git() {
      return harness.git;
    },
    set git(value: boolean) {
      harness.git = value;
    },
    failLaunchWith: (code) => {
      harness.failLaunch = code;
    },
    writeWorkflow: (id, file) => {
      writeFileSync(workflowPath(id), `${JSON.stringify(file, null, 2)}\n`);
    },
    workflowPath,
    removeWorkflow: (id) => {
      rmSync(workflowPath(id), { force: true });
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harnessApi);
  return harnessApi;
}

export function closeAllHarnesses(): void {
  for (const harness of openHarnesses.splice(0)) harness.close();
}

export interface Res {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Browser-session request. Mutations carry the CSRF header and a JSON content type. */
export async function api(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Res> {
  const mutation = method !== "GET";
  const response = await h.app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      Host: HOST,
      Cookie: COOKIE,
      ...(mutation ? { "Content-Type": "application/json", "X-DevChestra-Csrf": "1" } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: parse(text) };
}

export interface DeliveryOptions {
  readonly body: string | Uint8Array;
  readonly headers?: Record<string, string>;
  /**
   * Signs the exact body bytes with this secret, as GitHub does, and sends the result
   * in `X-Hub-Signature-256`. Omit it to send the delivery unsigned.
   */
  readonly secret?: string | null;
  /** Pass null to omit the Host header entirely. */
  readonly host?: string | null;
}

/** Public ingress request. No session cookie, no CSRF header. */
export async function deliver(h: Harness, hookId: string, options: DeliveryOptions): Promise<Res> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.secret !== undefined && options.secret !== null) {
    const bytes = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
    headers["x-hub-signature-256"] =
      `sha256=${createHmac("sha256", options.secret).update(bytes).digest("hex")}`;
  }
  if (options.host !== null) headers.Host = options.host ?? HOST;
  const response = await h.app.request(`${ORIGIN}/webhooks/${hookId}`, {
    method: "POST",
    headers,
    body: options.body,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: parse(text) };
}

export function errorCode(res: Res): string | undefined {
  const error = (res.json as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string" ? error.code : undefined;
}

export function errorReason(res: Res): string | undefined {
  const details = (res.json as { error?: { details?: unknown } } | null)?.error?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Arms `WORKFLOW_ID` through the management route and returns the response body. */
export async function armHook(h: Harness): Promise<{
  hookId: string;
  /** The one secret, present only when this arm created the hook. */
  secret: string | null;
  status: { state: string; hookId: string; url: string | null; armedRevision: string | null };
}> {
  const res = await api(
    h,
    "POST",
    `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/webhook/arm`,
  );
  if (res.status !== 200) throw new Error(`arm failed: ${res.status} ${res.text}`);
  const body = res.json as {
    status: { hookId: string; state: string; url: string | null; armedRevision: string | null };
    secret: string | null;
  };
  return { hookId: body.status.hookId, secret: body.secret, status: body.status };
}
