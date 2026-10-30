import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry } from "@devchestra/adapters";
import type { JsonObject, RunId, RunStatus } from "@devchestra/core";
import { createDecisionService, type DecisionService } from "@devchestra/decisions";
import { createEngine, type Engine } from "@devchestra/engine";
import {
  type BrowserRunControllerPort,
  createAgentGateway,
  createStoreQueryPort,
  DevChestraError,
  ExecTokenRegistry,
  OutputValidator,
  type RunningBrowserServer,
  type StartRunResponse,
  startBrowserServer,
  startLoopbackServer,
} from "@devchestra/server";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";

// Full-stack decision acceptance: a real browser app (routes, validation,
// workflow files), a real engine, a real store and the fake agent, with the
// DecisionService pointed at the loopback stand-in. No live network, no real
// keys. The CLI service uses live URLs by design, so this extends the
// in-process server harness (packages/server/test/*) instead of spawning it.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAKE_AGENT_BIN = join(REPO_ROOT, "tools/fake-agent/dist/main.js");
const SHIM_ENTRY = join(REPO_ROOT, "packages/mcp/dist/bin/shim.js");

const TOKEN = "e".repeat(43);
const FAKE_ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};
const NEEDLES = ["test-typesafe-key", "test-cf-token", "test-cf-account"];
const KNOWN_SECRET_NAMES = ["TYPESAFE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"];

let root: string;
let dataDir: string;
let projectPath: string;
let projectId: string;
let standin: StandinHandle;
let store: Store;
let decisions: DecisionService;
let validator: OutputValidator;
let gatewayClose: () => Promise<void>;
let gatewayUrl = "";
let issueGatewayToken: (scope: {
  identity: unknown;
  toolset: "agent";
  outputSchema: unknown;
  outputSchemaHash: string;
  validationLimit: number;
  expiresAt: number;
  context: unknown;
}) => { token: string; revoke: () => void };
let server: RunningBrowserServer;
let cookie = "";
const holder: { engine: Engine | null } = { engine: null };
const seenBodies: unknown[] = [];
const seenEvents: unknown[] = [];
const logLines: string[] = [];

interface WorkflowDoc {
  etag: string;
  text: string;
  workflow: unknown;
  validation: { ok: boolean; errors?: unknown };
}

interface RunRecord {
  id: string;
  status: string;
}

interface ExecutionView {
  status?: string;
  decision?: { output: unknown; routing: unknown };
}

interface RunDetail {
  run: RunRecord;
  view: { executions: Record<string, ExecutionView> };
  snapshot: unknown;
  watermark: number;
}

interface StoredEvent {
  id: number;
  type: string;
  path: string;
  payload: unknown;
}

function statusOf(runId: string, fallback: RunStatus): RunStatus {
  const record = store.runs.get(runId as never) as { status?: unknown } | null;
  return (record?.status as RunStatus | undefined) ?? fallback;
}

const controller: BrowserRunControllerPort = {
  startRun: async (input): Promise<StartRunResponse> => {
    const engine = holder.engine;
    if (engine === null) throw new DevChestraError("E_INTERNAL", "Engine is not running.");
    const launched = await engine.launch({
      projectId: input.projectId,
      workflowId: input.workflowId,
      snapshot: input.snapshot,
      snapshotRaw: input.snapshotRaw,
      params: input.params as JsonObject,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    });
    if (!launched.ok) throw launched.error;
    void launched.value.completion.then(
      () => undefined,
      () => undefined,
    );
    return {
      runId: launched.value.runId as RunId,
      duplicate: launched.value.duplicate,
      status: statusOf(launched.value.runId, "queued"),
    };
  },
  cancelRun: (runId) => {
    const status = statusOf(runId, "cancelled");
    return Promise.resolve({ runId: runId as RunId, status });
  },
  resumeRun: async (runId): Promise<StartRunResponse> => {
    const engine = holder.engine;
    if (engine === null) throw new DevChestraError("E_INTERNAL", "Engine is not running.");
    const launched = await engine.launchResume(runId);
    if (!launched.ok) throw launched.error;
    void launched.value.completion.then(
      () => undefined,
      () => undefined,
    );
    return {
      runId: runId as RunId,
      duplicate: launched.value.duplicate,
      status: statusOf(runId, "paused"),
    };
  },
  resolveApproval: () => Promise.reject(new Error("unused")),
};

async function useEngine(fakeScript: unknown[]): Promise<Engine> {
  if (holder.engine !== null) {
    await holder.engine.stop();
    holder.engine = null;
  }
  const engine = createEngine({
    store,
    adapters: createAdapterRegistry({
      nodeBin: process.execPath,
      fakeAgentBin: FAKE_AGENT_BIN,
      fakeScript,
    }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: gatewayUrl,
      issue: (scope) =>
        issueGatewayToken({
          identity: scope.identity,
          toolset: "agent",
          outputSchema: scope.outputSchema,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
          context: scope.context,
        }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: SHIM_ENTRY,
    env: process.env,
    validateOutput: (schema, value) => validator.compile(schema).validate(value),
    decisions,
  });
  await engine.start();
  holder.engine = engine;
  return engine;
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
): Promise<{ status: number; body: T }> {
  const response = await fetch(url(path), {
    method,
    headers: { ...headers(method !== "GET"), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = (text === "" ? null : JSON.parse(text)) as T;
  seenBodies.push(parsed);
  return { status: response.status, body: parsed };
}

async function saveWorkflow(
  id: string,
  name: string,
  graph: { nodes: unknown[]; edges: unknown[] },
): Promise<string> {
  const created = await json<WorkflowDoc>("POST", `/api/projects/${projectId}/workflows`, {
    name,
    id,
    template: "blank",
  });
  expect(created.status).toBe(201);
  const saved = await json<WorkflowDoc>(
    "PUT",
    `/api/projects/${projectId}/workflows/${id}`,
    { workflow: { schemaVersion: 1, id, name, graph } },
    { "If-Match": `"${created.body.etag}"` },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.validation).toMatchObject({ ok: true });
  return saved.body.etag;
}

async function startRun(workflowId: string, etag: string): Promise<string> {
  const started = await json<{ runId: string }>(
    "POST",
    `/api/projects/${projectId}/workflows/${workflowId}/runs`,
    { params: {}, etag },
  );
  expect(started.status).toBe(202);
  return started.body.runId;
}

async function waitTerminal(runId: string, timeoutMs = 30_000): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await json<RunDetail>("GET", `/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    const status = detail.body.run.status;
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      return detail.body;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} not terminal: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runEvents(runId: string): Promise<StoredEvent[]> {
  const page = await json<{ events: StoredEvent[] }>("GET", `/api/runs/${runId}/events?limit=500`);
  expect(page.status).toBe(200);
  seenEvents.push(...page.body.events);
  return page.body.events;
}

async function waitForEvents(
  runId: string,
  type: string,
  count: number,
  timeoutMs = 15_000,
): Promise<StoredEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await runEvents(runId);
    const matching = events.filter((event) => event.type === type);
    if (matching.length >= count) return matching;
    const done = events.some((event) => event.type === "run.completed");
    if (done) throw new Error(`run completed before ${count}x ${type}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count}x ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function completedResult(events: StoredEvent[]): {
  status: string;
  result?: unknown;
  error?: unknown;
} {
  const done = events.find((event) => event.type === "run.completed");
  expect(done).toBeDefined();
  return (done?.payload ?? {}) as { status: string; result?: unknown; error?: unknown };
}

// --- Workflow node builders (same field shapes as the existing HTTP tests) ---

const start = () => ({
  id: "start",
  type: "start",
  name: "Start",
  supervise: "default",
  env: [],
  params: [],
});

const shell = (id: string, command: string) => ({
  id,
  type: "shell",
  name: id,
  supervise: "default",
  env: [],
  command,
  workspace: { mode: "scratch" },
  timeoutMin: 1,
  allowFailure: false,
});

const end = (id: string, result: string) => ({
  id,
  type: "end",
  name: id,
  supervise: "default",
  env: [],
  status: "success",
  result,
});

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "decision",
  name: id,
  supervise: "default",
  env: [],
  provider: "typesafe-jev",
  state: "the customer is waiting",
  instructions: "Should we escalate?",
  mode: { kind: "boolean" },
  onError: "fail",
  ...extra,
});

const gate = (id: string, branches: unknown[]) => ({
  id,
  type: "gate",
  name: id,
  supervise: "default",
  env: [],
  branches,
});

const agent = (id: string) => ({
  id,
  type: "agent",
  name: id,
  supervise: "default",
  env: [],
  cli: "fake",
  prompt: "Return the accepted fake output.",
  output: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  permissions: { network: false, write: ["workspace"] },
  workspace: { mode: "scratch" },
  limits: { timeoutMin: 1, validationRetries: 1, crashRetries: 0 },
  context: { project: "none", workflow: "none" },
});

const edge = (id: string, from: string, to: string) => ({ id, from, to });

beforeAll(async () => {
  if (!existsSync(FAKE_AGENT_BIN) || !existsSync(SHIM_ENTRY)) {
    throw new Error("Acceptance prerequisites are missing; run `pnpm build` first.");
  }
  root = await mkdtemp(join(tmpdir(), "devchestra-decision-accept-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  standin = await startStandin();
  decisions = createDecisionService({
    env: { ...FAKE_ENV },
    dotenvPath: null,
    baseUrlOverride: standin.origin,
  });
  store = openStore({ file: join(dataDir, "devchestra.db") });
  validator = new OutputValidator();
  const tokens = new ExecTokenRegistry({
    registerSecret: (value, name) => store.security.registerSecret(value, name),
  });
  let gatewayPort = 0;
  const gatewayApp = createAgentGateway({
    tokens,
    submissions: store.submissions,
    context: store.contextPool,
    validator,
    port: () => gatewayPort,
    logger: (line) => {
      logLines.push(line);
    },
  });
  const gatewayServer = await startLoopbackServer(gatewayApp);
  gatewayPort = gatewayServer.port;
  gatewayUrl = gatewayServer.url;
  issueGatewayToken = (scope) => {
    const token = tokens.issue({
      identity: scope.identity as never,
      toolset: "agent",
      outputSchema: scope.outputSchema as never,
      outputSchemaHash: scope.outputSchemaHash,
      validationLimit: scope.validationLimit,
      expiresAt: scope.expiresAt,
      context: scope.context as never,
    });
    return { token, revoke: () => tokens.revoke(token) };
  };
  gatewayClose = async () => {
    tokens.clear();
    await gatewayServer.close();
  };
  server = await startBrowserServer({
    dataDir,
    store: createStoreQueryPort(store),
    controller,
    decisions,
    sessionToken: TOKEN,
    instanceId: "decision-acceptance",
    version: "0.1.0-test",
    port: 0,
    validateResponses: true,
    now: () => Date.now(),
    logger: (line) => {
      logLines.push(line);
    },
  });
  const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const registered = await json<{ id: string }>("POST", "/api/projects", { path: projectPath });
  expect(registered.status).toBe(200);
  projectId = registered.body.id;
}, 60_000);

afterEach(() => {
  const haystack = JSON.stringify({ seenBodies, seenEvents, logLines });
  for (const needle of NEEDLES) {
    expect(haystack).not.toContain(needle);
  }
});

afterAll(async () => {
  if (holder.engine !== null) {
    await holder.engine.stop();
    holder.engine = null;
  }
  await server.close();
  await gatewayClose();
  await standin.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("decision full-stack acceptance", () => {
  it("routes boolean true through the fake agent and a downstream gate reading value+confidence", async () => {
    await useEngine([{ type: "submit", output: { summary: "escalate now" } }]);
    standin.clear();
    const etag = await saveWorkflow("dec-bool", "Decision Boolean", {
      nodes: [
        start(),
        decision("d"),
        agent("agent"),
        shell("shell_no", "printf no"),
        gate("g", [
          { id: "sure", when: "d.confidence >= 0.8" },
          { id: "low", otherwise: true },
        ]),
        end("end_sure", '"sure"'),
        end("end_low", '{ "picked": d.value, "conf": d.confidence }'),
        end("end_false", '"no"'),
      ],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.true", "agent"),
        edge("e3", "d.false", "shell_no"),
        edge("e4", "shell_no", "end_false"),
        edge("e5", "agent", "g"),
        edge("e6", "g.sure", "end_sure"),
        edge("e7", "g.low", "end_low"),
      ],
    });
    const runId = await startRun("dec-bool", etag);
    const detail = await waitTerminal(runId);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.view.executions.agent?.status).toBe("succeeded");
    expect(detail.view.executions.shell_no?.status).toBe("skipped");
    expect(detail.view.executions.end_false?.status).toBe("skipped");
    expect(detail.view.executions.end_sure?.status).toBe("skipped");
    expect(detail.view.executions.d?.decision?.routing).toEqual({
      branch: "true",
      reason: "matched",
    });
    expect(detail.view.executions.d?.decision?.output).toMatchObject({
      kind: "boolean",
      value: true,
      probability: 0.75,
      confidence: 0.75,
      confidenceSource: "derived",
      model: "jev-latest",
    });
    const events = await runEvents(runId);
    expect(events.filter((e) => e.type === "decision.requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "decision.answered")).toHaveLength(1);
    expect(events.find((e) => e.type === "decision.requested")?.payload).toMatchObject({
      provider: "typesafe-jev",
      model: "jev-latest",
      questionIds: ["q0"],
    });
    expect(events.find((e) => e.type === "decision.answered")?.payload).toMatchObject({
      output: { kind: "boolean", value: true },
      routing: { branch: "true", reason: "matched" },
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    });
    // The downstream gate/template read the normalized output, not a branch name.
    expect(completedResult(events).result).toEqual({ picked: true, conf: 0.75 });
    expect(standin.requests()).toHaveLength(1);
    expect(standin.lastRequest()?.body).toMatchObject({
      model: "jev-latest",
      questions: { q0: { type: "noul" } },
    });
    const spawned = events.filter((e) => e.type === "node.process.spawned");
    expect(spawned.some((e) => e.path === "shell_no")).toBe(false);
  });

  it("routes choice to the branch holding the picked option", async () => {
    await useEngine([]);
    standin.clear();
    const etag = await saveWorkflow("dec-choice", "Decision Choice", {
      nodes: [
        start(),
        decision("d", {
          mode: {
            kind: "choice",
            options: [{ value: "red" }, { value: "blue", description: "cool blue" }],
            branches: [
              { id: "warm", values: ["red"] },
              { id: "cool", values: ["blue"] },
            ],
          },
        }),
        shell("shell_w", "printf W"),
        shell("shell_c", "printf C"),
        end("end_w", '"warm"'),
        end("end_c", '"cool"'),
      ],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.warm", "shell_w"),
        edge("e3", "shell_w", "end_w"),
        edge("e4", "d.cool", "shell_c"),
        edge("e5", "shell_c", "end_c"),
      ],
    });
    const runId = await startRun("dec-choice", etag);
    const detail = await waitTerminal(runId);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.view.executions.shell_c?.status).toBe("skipped");
    expect(detail.view.executions.d?.decision?.routing).toEqual({
      branch: "warm",
      reason: "matched",
    });
    const events = await runEvents(runId);
    expect(completedResult(events).result).toBe("warm");
    expect(standin.lastRequest()?.body).toMatchObject({
      questions: { q0: { type: "choice" } },
    });
  });

  it("routes score to the matching band with probabilities by level label", async () => {
    await useEngine([]);
    standin.clear();
    const etag = await saveWorkflow("dec-score", "Decision Score", {
      nodes: [
        start(),
        decision("d", {
          mode: {
            kind: "score",
            levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
            bands: [
              { id: "top", atLeast: 2 },
              { id: "rest", atLeast: null },
            ],
          },
        }),
        end("end_t", '"top"'),
        end("end_r", '"rest"'),
      ],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.top", "end_t"),
        edge("e3", "d.rest", "end_r"),
      ],
    });
    const runId = await startRun("dec-score", etag);
    const detail = await waitTerminal(runId);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.view.executions.d?.decision?.routing).toEqual({
      branch: "rest",
      reason: "matched",
    });
    expect(detail.view.executions.d?.decision?.output).toMatchObject({
      kind: "score",
      value: "mid",
      score: 1.2,
      probabilities: { low: expect.any(Number), mid: 0.6, high: expect.any(Number) },
    });
    const events = await runEvents(runId);
    expect(completedResult(events).result).toBe("rest");
  });

  it("takes the wired uncertain route on a provider refusal", async () => {
    await useEngine([]);
    standin.clear();
    standin.setNext(["refusal-missing"]);
    const etag = await saveWorkflow("dec-refused", "Decision Refused", {
      nodes: [
        start(),
        decision("d", { mode: { kind: "boolean", trueAt: 0.9, falseAt: 0.5 } }),
        end("end_u", '"unsure"'),
        end("end_t", '"sure"'),
      ],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.uncertain", "end_u"),
        edge("e3", "d.true", "end_t"),
      ],
    });
    const runId = await startRun("dec-refused", etag);
    const detail = await waitTerminal(runId);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.view.executions.d?.decision?.routing).toEqual({
      branch: "uncertain",
      reason: "refused",
    });
    const events = await runEvents(runId);
    expect(completedResult(events).result).toBe("unsure");
  });

  it("fails with a clear error when uncertain is reached but unwired", async () => {
    await useEngine([]);
    standin.clear();
    standin.setNext(["refusal-missing"]);
    const etag = await saveWorkflow("dec-unwired", "Decision Unwired", {
      nodes: [
        start(),
        decision("d", { mode: { kind: "boolean", trueAt: 0.9, falseAt: 0.5 } }),
        end("end_t", '"sure"'),
      ],
      edges: [edge("e1", "start", "d"), edge("e2", "d.true", "end_t")],
    });
    const runId = await startRun("dec-unwired", etag);
    const detail = await waitTerminal(runId);
    expect(detail.run.status).toBe("failed");
    const events = await runEvents(runId);
    const completed = completedResult(events);
    expect(completed.status).toBe("failed");
    expect(completed.error).toMatchObject({ code: "E_WORKFLOW_INVALID" });
    expect(JSON.stringify(completed.error)).toContain("d.uncertain");
  });

  it("fails the run on a provider 500 when onError is fail (the default)", async () => {
    await useEngine([]);
    standin.clear();
    standin.setNext(["error-500", "error-500", "error-500"]);
    const etag = await saveWorkflow("dec-fail", "Decision Fail", {
      nodes: [
        start(),
        // No onError field: the default is fail.
        {
          ...decision("d"),
          onError: undefined,
        },
        end("end_t", '"sure"'),
      ],
      edges: [edge("e1", "start", "d"), edge("e2", "d.true", "end_t")],
    });
    const runId = await startRun("dec-fail", etag);
    const detail = await waitTerminal(runId, 60_000);
    expect(detail.run.status).toBe("failed");
    const events = await runEvents(runId);
    expect(completedResult(events).error).toMatchObject({ code: "E_PROVIDER" });
  }, 90_000);

  it("routes to uncertain on a provider 500 when onError is uncertain", async () => {
    await useEngine([]);
    standin.clear();
    standin.setNext(["error-500", "error-500", "error-500"]);
    const etag = await saveWorkflow("dec-err-uncertain", "Decision Error Uncertain", {
      nodes: [
        start(),
        decision("d", { onError: "uncertain" }),
        end("end_u", '"unsure"'),
        end("end_t", '"sure"'),
      ],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.uncertain", "end_u"),
        edge("e3", "d.true", "end_t"),
      ],
    });
    const runId = await startRun("dec-err-uncertain", etag);
    const detail = await waitTerminal(runId, 60_000);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.view.executions.d?.decision?.routing).toEqual({
      branch: "uncertain",
      reason: "error",
    });
    expect(detail.view.executions.d?.decision?.output).toMatchObject({
      value: null,
      confidence: null,
    });
    const events = await runEvents(runId);
    expect(completedResult(events).result).toBe("unsure");
  }, 90_000);

  it("serves provider readiness and the test route with caps and auth", async () => {
    await useEngine([]);
    standin.clear();
    const listed = await json<{ id: string; label: string; ready: boolean; missing: string[] }[]>(
      "GET",
      "/api/decision-providers",
    );
    expect(listed.status).toBe(200);
    expect(listed.body.map((entry) => entry.id).sort()).toEqual([
      "cloudflare-clef",
      "cloudflare-clef-flash",
      "typesafe-jev",
    ]);
    expect(listed.body.find((entry) => entry.id === "typesafe-jev")).toMatchObject({
      ready: true,
      missing: [],
    });
    for (const entry of listed.body) {
      expect(entry.missing.every((name) => KNOWN_SECRET_NAMES.includes(name))).toBe(true);
    }
    const tested = await json<{ routing: { branch: string; reason: string } }>(
      "POST",
      `/api/projects/${projectId}/decisions/test`,
      {
        provider: "typesafe-jev",
        state: "customer is waiting",
        instructions: "Should we escalate?",
        mode: { kind: "boolean" },
      },
    );
    expect(tested.status).toBe(200);
    expect(tested.body.routing).toEqual({ branch: "true", reason: "matched" });
    const huge = await json<{ error: { code: string } }>(
      "POST",
      `/api/projects/${projectId}/decisions/test`,
      {
        provider: "typesafe-jev",
        state: "x".repeat(70 * 1024),
        instructions: "Should we escalate?",
        mode: { kind: "boolean" },
      },
    );
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe("E_VALIDATION");
    const anonymous = await fetch(url(`/api/projects/${projectId}/decisions/test`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DevChestra-Csrf": "1" },
      body: JSON.stringify({
        provider: "typesafe-jev",
        state: "x",
        instructions: "pick",
        mode: { kind: "boolean" },
      }),
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await fetch(url(`/api/projects/${projectId}/decisions/test`), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "typesafe-jev",
        state: "x",
        instructions: "pick",
        mode: { kind: "boolean" },
      }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("asks the provider again after an interrupt before decision.answered", async () => {
    await useEngine([]);
    standin.clear();
    const etag = await saveWorkflow("dec-restart-req", "Decision Restart Requested", {
      nodes: [start(), decision("d"), end("end_t", '"ok"')],
      edges: [edge("e1", "start", "d"), edge("e2", "d.true", "end_t")],
    });
    standin.setNext([{ scenario: "slow", delayMs: 2500 }]);
    const runId = await startRun("dec-restart-req", etag);
    const deadline = Date.now() + 10_000;
    while (standin.requests().length < 1) {
      if (Date.now() > deadline) throw new Error("provider was never asked");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const engine = holder.engine;
    expect(engine).not.toBeNull();
    await engine?.stop();
    holder.engine = null;
    const interrupted = await runEvents(runId);
    // Finding: recordDecision commits requested+answered atomically at answer
    // time, so an interrupt mid-call persists neither (there is no
    // requested-only state on this path). Resume must therefore ask again.
    expect(interrupted.filter((e) => e.type === "decision.requested")).toHaveLength(0);
    expect(interrupted.filter((e) => e.type === "decision.answered")).toHaveLength(0);
    const paused = await json<RunDetail>("GET", `/api/runs/${runId}`);
    expect(paused.body.run.status).toBe("paused");
    await standin.drain();
    await useEngine([]);
    const resumed = await json<{ status: number }>("POST", `/api/runs/${runId}/resume`);
    expect(resumed.status).toBe(202);
    const detail = await waitTerminal(runId, 60_000);
    expect(detail.run.status).toBe("succeeded");
    // Nothing was persisted mid-call, so resume asks again exactly once more.
    expect(standin.requests()).toHaveLength(2);
    const events = await runEvents(runId);
    expect(events.filter((e) => e.type === "decision.requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "decision.answered")).toHaveLength(1);
  }, 90_000);

  it("does not ask the provider again after a resume past decision.answered", async () => {
    await useEngine([
      { type: "sleep", ms: 3000 },
      { type: "submit", output: { summary: "late" } },
    ]);
    standin.clear();
    const etag = await saveWorkflow("dec-restart-ans", "Decision Restart Answered", {
      nodes: [start(), decision("d"), agent("agent"), end("end_t", '{ "s": agent.summary }')],
      edges: [
        edge("e1", "start", "d"),
        edge("e2", "d.true", "agent"),
        edge("e3", "agent", "end_t"),
      ],
    });
    const runId = await startRun("dec-restart-ans", etag);
    await waitForEvents(runId, "decision.answered", 1);
    const engine = holder.engine;
    expect(engine).not.toBeNull();
    await engine?.stop();
    holder.engine = null;
    const paused = await json<RunDetail>("GET", `/api/runs/${runId}`);
    expect(paused.body.run.status).toBe("paused");
    await useEngine([{ type: "submit", output: { summary: "late" } }]);
    const resumed = await json<{ status: number }>("POST", `/api/runs/${runId}/resume`);
    expect(resumed.status).toBe(202);
    const detail = await waitTerminal(runId, 60_000);
    expect(detail.run.status).toBe("succeeded");
    // The persisted answer is reused: no second provider call.
    expect(standin.requests()).toHaveLength(1);
    const events = await runEvents(runId);
    expect(events.filter((e) => e.type === "decision.answered")).toHaveLength(1);
    expect(completedResult(events).result).toEqual({ s: "late" });
  }, 90_000);
});
