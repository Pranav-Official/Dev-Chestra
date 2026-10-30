import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ApiClient } from "@devchestra/api";
import type { ExecutionIdentity, Path, RunId } from "@devchestra/core";
import { normalizeWorkflow } from "@devchestra/schema";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserRunControllerPort,
  createAgentGateway,
  createStoreQueryPort,
  type ExecScope,
  ExecTokenRegistry,
  OutputValidator,
  type RunningBrowserServer,
  type RunningLoopbackServer,
  startBrowserServer,
  startLoopbackServer,
} from "../src/index.js";

const RUN_PATH = "research" as Path;
const TOKEN = "c".repeat(43);
const SHIM = resolve(import.meta.dirname, "../../mcp/dist/bin/shim.js");

const RAW_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

const ANY_FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {},
    meta: { type: "object", additionalProperties: true },
  },
} as const;

const STRICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
} as const;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class StdioMcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[] = [];
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;

  constructor(env: Record<string, string>, cwd: string) {
    this.child = spawn(process.execPath, [SHIM], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      if (this.stderr.length < 200) this.stderr.push(chunk);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "devchestra-flexible-output-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method: string, params: Record<string, unknown>, id = this.#nextId++): Promise<unknown> {
    const requestId = id;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30_000);
      this.#pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(line);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async callTool(
    argumentsValue: Record<string, unknown>,
    id?: number,
  ): Promise<{ isError: boolean; text: string }> {
    const result = (await this.request(
      "tools/call",
      { name: "submit_result", arguments: argumentsValue },
      id,
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    return {
      isError: result.isError === true,
      text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
    };
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

interface Harness {
  store: Store;
  identity: ExecutionIdentity;
  token: string;
  tokens: ExecTokenRegistry;
  scope: ExecScope;
  shim: StdioMcpClient;
  listener: RunningLoopbackServer;
  runId: RunId;
  dataDir: string;
  close(): Promise<void>;
}

async function openHarness(schema: Record<string, unknown>): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "devchestra-flexible-output-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "project-1", name: "Project", path: projectDir, kind: "folder" });
  const normalized = normalizeWorkflow({
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "done", type: "end", name: "Done", status: "success", result: '{"ok":true}' },
      ],
      edges: [{ id: "e1", from: "start", to: "done" }],
    },
  });
  if (!normalized.ok) throw normalized.error;
  const run = store.runs.create({
    projectId: "project-1",
    workflowId: "wf",
    workflowHash: "hash",
    snapshot: normalized.value,
    snapshotRaw: "{}",
  });
  store.executions.ensure({
    runId: run.runId,
    path: RUN_PATH,
    nodeId: "research",
    kind: "agent",
    validationLimit: 3,
  });
  const identity = store.executions.beginInvocation({
    runId: run.runId,
    path: RUN_PATH,
    attempt: 1,
    mode: "fresh",
  });

  const tokens = new ExecTokenRegistry({
    registerSecret: (token) => store.security.registerSecret(token, "exec-token"),
  });
  const validator = new OutputValidator();
  const compiled = validator.compile(schema);
  const scope: ExecScope = {
    identity,
    toolset: "agent",
    outputSchema: schema,
    outputSchemaHash: compiled.hash,
    validationLimit: 3,
    expiresAt: Date.now() + 120_000,
    context: { project: "none", workflow: "none", execution: "none" },
  };
  const token = tokens.issue(scope);

  let port = 0;
  const app = createAgentGateway({
    tokens,
    submissions: store.submissions,
    context: store.contextPool,
    validator,
    port: () => port,
    rateLimit: { capacity: 100, refillPerSecond: 0.001 },
  });
  const listener = await startLoopbackServer(app, { port: 0 });
  port = listener.port;

  const shim = new StdioMcpClient(
    {
      DEVCHESTRA_GATEWAY_URL: listener.url,
      DEVCHESTRA_EXEC_TOKEN: token,
      DEVCHESTRA_TOOLSET: "agent",
      DEVCHESTRA_MCP_DEBUG: "0",
    },
    root,
  );
  await shim.initialize();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await shim.close();
    await listener.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  };
  cleanups.push(close);
  return {
    store,
    identity,
    token,
    tokens,
    scope,
    shim,
    listener,
    runId: run.runId,
    dataDir,
    close,
  };
}

async function apiOutput(
  store: Store,
  dataDir: string,
  runId: RunId,
): Promise<Record<string, unknown>> {
  const controller: BrowserRunControllerPort = {
    startRun: () => ({ runId, duplicate: false, status: "queued" }),
    cancelRun: () => ({ runId, status: "cancelled" }),
    resumeRun: () => ({ runId, status: "running" }),
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
  let server: RunningBrowserServer | null = null;
  try {
    server = await startBrowserServer({
      dataDir,
      store: createStoreQueryPort(store),
      controller,
      sessionToken: TOKEN,
      instanceId: "flexible-output",
      version: "0.0.0-test",
      port: 0,
      validateResponses: true,
    });
    const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("browser API bootstrap did not set a cookie");
    const client = new ApiClient({
      baseUrl: server.url,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Cookie", cookie);
        return fetch(input, { ...init, headers });
      },
    });
    const detail = await client.getExecution(runId, RUN_PATH);
    if (detail.output?.data === null || detail.output?.data === undefined) {
      throw new Error("typed API execution detail has no output data");
    }
    return detail.output.data as Record<string, unknown>;
  } finally {
    if (server !== null) await server.close();
  }
}

async function submitDirect(
  h: Harness,
  args: Record<string, unknown>,
  callId: string,
): Promise<Response> {
  return fetch(`${h.listener.url}/internal/agent/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.token}`,
      "Content-Type": "application/json",
      "X-DevChestra-Call-Id": callId,
    },
    body: JSON.stringify({ name: "submit_result", arguments: args }),
  });
}

function rawPayload(includeProto = true): Record<string, unknown> {
  const parsed = JSON.parse(
    includeProto
      ? '{"repo":{"name":"acme/processor","stars":0,"fork":false,"topics":["alpha"],"owner":null,"meta":{"nested":{"deep":[1,false,null,0]}}},"matrix":[[1,0],[false,null]],"__proto__":{"polluted":true,"list":[0,false,null]},"constructor":{"own":true,"prototype":{"kept":true}},"prototype":{"own":true}}'
      : '{"repo":{"name":"acme/processor","stars":0,"fork":false,"topics":["alpha"],"owner":null,"meta":{"nested":{"deep":[1,false,null,0]}}},"matrix":[[1,0],[false,null]],"constructor":{"own":true,"prototype":{"kept":true}},"prototype":{"own":true}}',
  ) as Record<string, unknown>;
  if (includeProto) {
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  }
  let deep: Record<string, unknown> = { leaf: "bottom" };
  for (let index = 0; index < 14; index += 1) {
    deep = { level: index, child: deep };
  }
  parsed.depth = deep;
  return parsed;
}

describe("flexible output through real stdio MCP, gateway, SQLite and API", () => {
  it("retains arbitrary raw objects, arrays, scalars and deep data through real stdio MCP", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const tools = (await h.shim.request("tools/list", {})) as {
      tools?: Array<{ inputSchema?: unknown }>;
    };
    expect(tools.tools?.[0]?.inputSchema).toEqual(RAW_SCHEMA);

    const payload = rawPayload(false);
    const result = await h.shim.callTool(payload, 10);
    expect(result.isError).toBe(false);

    const output = h.store.outputs.get({
      runId: h.identity.runId,
      path: h.identity.path,
      attempt: h.identity.attempt,
    });
    expect(output).not.toBeNull();
    const stored = output?.json;
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).toBe(JSON.stringify(payload));
    expect(Object.hasOwn(stored as object, "constructor")).toBe(true);
    expect(Object.hasOwn(stored as object, "prototype")).toBe(true);
    expect(output?.bytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
  });

  it("retains own __proto__ data through direct gateway, SQLite and the typed API", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const payload = rawPayload();
    const response = await submitDirect(h, payload, "direct-proto");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { isError?: boolean };
    expect(body.isError).toBe(false);

    const output = h.store.outputs.get({
      runId: h.identity.runId,
      path: h.identity.path,
      attempt: h.identity.attempt,
    });
    const stored = output?.json;
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).toBe(JSON.stringify(payload));
    expect(Object.getOwnPropertyDescriptor(stored as object, "__proto__")?.value).toEqual({
      polluted: true,
      list: [0, false, null],
    });
    expect(Object.hasOwn(stored as object, "__proto__")).toBe(true);
    expect(Object.hasOwn(stored as object, "constructor")).toBe(true);
    expect(Object.hasOwn(stored as object, "prototype")).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();

    const api = await apiOutput(h.store, h.dataDir, h.runId);
    expect(JSON.stringify(api)).toBe(JSON.stringify(payload));
    expect(Object.hasOwn(api, "__proto__")).toBe(true);
    expect(Object.hasOwn(api, "constructor")).toBe(true);
    expect(Object.hasOwn(api, "prototype")).toBe(true);
  });

  it("retains own __proto__ data through real stdio MCP", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const payload = rawPayload();
    const result = await h.shim.callTool(payload, 12);
    expect(result.isError).toBe(false);
    const output = h.store.outputs.get({
      runId: h.identity.runId,
      path: h.identity.path,
      attempt: h.identity.attempt,
    });
    const stored = output?.json;
    expect(stored).toBeDefined();
    expect(Object.hasOwn(stored as object, "__proto__")).toBe(true);
    expect(Object.hasOwn(stored as object, "constructor")).toBe(true);
    expect(Object.hasOwn(stored as object, "prototype")).toBe(true);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(payload));
  });

  it("accepts an Any property holding an array of mixed JSON values", async () => {
    const h = await openHarness(ANY_FIELD_SCHEMA);
    const payload = {
      value: [1, null, false, 0, { repo: "acme/processor", stars: 0 }],
      meta: { unknown: { nested: [null, false, 0] } },
    };
    const result = await h.shim.callTool(payload, 11);
    expect(result.isError).toBe(false);
    const output = h.store.outputs.get({
      runId: h.identity.runId,
      path: h.identity.path,
      attempt: h.identity.attempt,
    });
    expect(output?.json).toEqual(payload);
  });

  it("keeps strict schemas closed and rejects unknown or wrongly-typed fields", async () => {
    const h = await openHarness(STRICT_SCHEMA);
    const unknown = await h.shim.callTool({ answer: "ok", extra: true }, 20);
    expect(unknown.isError).toBe(true);
    expect(h.store.events.list(h.identity.runId, { types: ["node.output.rejected"] })).toHaveLength(
      1,
    );
    expect(
      h.store.outputs.get({
        runId: h.identity.runId,
        path: h.identity.path,
        attempt: h.identity.attempt,
      }),
    ).toBeNull();

    const wrongType = await h.shim.callTool({ answer: 42 }, 21);
    expect(wrongType.isError).toBe(true);
    const valid = await h.shim.callTool({ answer: "fixed" }, 22);
    expect(valid.isError).toBe(false);
    expect(
      h.store.events.list(h.identity.runId, { types: ["node.output.validated"] }),
    ).toHaveLength(1);
  });

  it("keeps receipt idempotence/conflict, identity fencing and secret guards", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const payload = { repo: "acme/processor", stars: 0, unknown: [null, false] };
    const first = await h.shim.callTool(payload, 30);
    expect(first.isError).toBe(false);
    const replay = await h.shim.callTool(payload, 30);
    expect(replay.isError).toBe(false);
    expect(
      h.store.events.list(h.identity.runId, { types: ["node.output.validated"] }),
    ).toHaveLength(1);

    const conflict = await h.shim.callTool({ ...payload, stars: 1 }, 30);
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/conflict|E_CONFLICT/i);
    expect(
      h.store.events.list(h.identity.runId, { types: ["node.output.validated"] }),
    ).toHaveLength(1);
  });

  it("rejects the exec token echoed anywhere in a raw payload without persisting it", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const result = await h.shim.callTool(
      { repo: { nested: { values: [h.token] } }, records: [{ note: h.token }] },
      40,
    );
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(h.token);
    expect(
      h.store.outputs.get({
        runId: h.identity.runId,
        path: h.identity.path,
        attempt: h.identity.attempt,
      }),
    ).toBeNull();
    const dbFile = join(h.dataDir, "devchestra.db");
    for (const file of [dbFile, `${dbFile}-wal`]) {
      try {
        const bytes = await readFile(file);
        expect(bytes.includes(Buffer.from(h.token, "utf8"))).toBe(false);
      } catch {
        // WAL may not exist.
      }
    }
  });

  it("rejects a future generation token and an oversized raw body before persistence", async () => {
    const h = await openHarness(RAW_SCHEMA);
    const futureScope: ExecScope = {
      ...h.scope,
      identity: { ...h.identity, generation: h.identity.generation + 1 },
      expiresAt: Date.now() + 120_000,
    };
    const futureToken = h.tokens.issue(futureScope);
    const stale = new StdioMcpClient(
      {
        DEVCHESTRA_GATEWAY_URL: h.listener.url,
        DEVCHESTRA_EXEC_TOKEN: futureToken,
        DEVCHESTRA_TOOLSET: "agent",
        DEVCHESTRA_MCP_DEBUG: "0",
      },
      h.dataDir,
    );
    cleanups.push(() => stale.close());
    await stale.initialize();
    const rejected = await stale.callTool({ repo: "future", values: [0, false, null] }, 50);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|E_CONFLICT/i);
    expect(
      h.store.outputs.get({
        runId: h.identity.runId,
        path: h.identity.path,
        attempt: h.identity.attempt,
      }),
    ).toBeNull();

    const oversized = { value: "x".repeat(1_100_000) };
    const bodyResult = await h.shim.callTool(oversized, 51);
    expect(bodyResult.isError).toBe(true);
    expect(
      h.store.outputs.get({
        runId: h.identity.runId,
        path: h.identity.path,
        attempt: h.identity.attempt,
      }),
    ).toBeNull();
  });
});
