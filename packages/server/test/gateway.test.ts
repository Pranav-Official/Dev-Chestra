import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionIdentity, Path } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGateway } from "../src/gateway.js";
import type { SubmissionPort } from "../src/ports.js";
import { type ExecScope, ExecTokenRegistry } from "../src/tokens.js";
import { OutputValidator } from "../src/validate.js";

const PORT = 49_991;
const PATH = "research" as Path;
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

interface Harness {
  app: ReturnType<typeof createAgentGateway>;
  store: Store;
  tokens: ExecTokenRegistry;
  identity: ExecutionIdentity;
  token: string;
  scope: ExecScope;
  dataDir: string;
  dbFile: string;
  close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openHarness(
  options: {
    validationLimit?: number;
    rateCapacity?: number;
    maxBodyBytes?: number;
    submitTimeoutMs?: number;
    submissions?: SubmissionPort;
    now?: () => number;
    reuse?: { dbFile: string; identity: ExecutionIdentity };
  } = {},
): Promise<Harness> {
  let dataDir: string;
  let dbFile: string;
  let store: Store;
  let identity: ExecutionIdentity;

  if (options.reuse === undefined) {
    dataDir = await mkdtemp(join(tmpdir(), "devchestra-server-test-"));
    dbFile = join(dataDir, "devchestra.db");
    store = openStore({ file: dbFile });
    cleanups.push(async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    store.projects.ensure({
      id: "project-1",
      name: "Project",
      path: join(dataDir, "project"),
      kind: "folder",
    });
    const run = store.runs.create({
      projectId: "project-1",
      workflowId: "workflow-1",
      workflowHash: "hash",
      snapshot: { nodes: [] },
      snapshotRaw: "{}",
    });
    store.executions.ensure({
      runId: run.runId,
      path: PATH,
      nodeId: "research",
      kind: "agent",
      validationLimit: options.validationLimit ?? 3,
    });
    identity = store.executions.beginInvocation({
      runId: run.runId,
      path: PATH,
      attempt: 1,
      mode: "fresh",
    });
  } else {
    dbFile = options.reuse.dbFile;
    dataDir = join(dbFile, "..");
    store = openStore({ file: dbFile });
    identity = options.reuse.identity;
    cleanups.push(async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
  }

  const tokens = new ExecTokenRegistry({
    registerSecret: (token) => store.security.registerSecret(token, "exec-token"),
  });
  const validator = new OutputValidator();
  const compiled = validator.compile(SCHEMA);
  const scope: ExecScope = {
    identity,
    toolset: "agent",
    outputSchema: SCHEMA,
    outputSchemaHash: compiled.hash,
    validationLimit: options.validationLimit ?? 3,
    expiresAt: Date.now() + 60_000,
  };
  const token = tokens.issue(scope);
  const app = createAgentGateway({
    tokens,
    submissions: options.submissions ?? store.submissions,
    validator,
    port: PORT,
    rateLimit: {
      capacity: options.rateCapacity ?? 100,
      refillPerSecond: 0.001,
    },
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.submitTimeoutMs === undefined ? {} : { submitTimeoutMs: options.submitTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    app,
    store,
    tokens,
    identity,
    token,
    scope,
    dataDir,
    dbFile,
    close: async (): Promise<void> => {
      store.close();
    },
  };
}

const baseHeaders = (token: string): Record<string, string> => ({
  Host: `127.0.0.1:${PORT}`,
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

function url(path: string): string {
  return `http://127.0.0.1:${PORT}${path}`;
}

async function submit(
  h: Harness,
  callId: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return h.app.request(url("/internal/agent/call"), {
    method: "POST",
    headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": callId },
    body: JSON.stringify({ name: "submit_result", arguments: args }),
  });
}

describe("agent gateway authentication and transport hardening", () => {
  it("rejects a missing bearer token", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "E_AUTH" } });
  });

  it("does not authorize a browser session cookie", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Cookie: "devchestra_session=not-an-exec-token",
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong Host header", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: { Host: "evil.example:49991", Authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(421);
  });

  it("rejects a foreign Origin on POST", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: {
        ...baseHeaders(h.token),
        Origin: "http://evil.example",
        "X-DevChestra-Call-Id": "call-1",
      },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "ok" } }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts a legitimate agent POST without a browser CSRF header", async () => {
    const h = await openHarness();
    const res = await submit(h, "call-1", { answer: "ok" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isError: false });
  });

  it("rejects a revoked token", async () => {
    const h = await openHarness();
    h.tokens.revoke(h.token);
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: baseHeaders(h.token),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const h = await openHarness({ now: () => Date.now() + 120_000 });
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: baseHeaders(h.token),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a supervisor token while only the agent toolset exists", async () => {
    const h = await openHarness();
    const supervisor = h.tokens.issue({ ...h.scope, toolset: "supervisor" });
    const tools = await h.app.request(url("/internal/agent/tools"), {
      headers: baseHeaders(supervisor),
    });
    expect(tools.status).toBe(403);
    const call = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(supervisor), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "ok" } }),
    });
    expect(call.status).toBe(403);
  });

  it("rejects a tool outside the token toolset", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "context_read", arguments: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("requires a call id", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: baseHeaders(h.token),
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "ok" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const h = await openHarness({ maxBodyBytes: 64 });
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "x".repeat(200) } }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized chunked body without content-length", async () => {
    const h = await openHarness({ maxBodyBytes: 64 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(200)));
        controller.close();
      },
    });
    const request = new Request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await h.app.request(request);
    expect(res.status).toBe(413);
  });

  it("times out a stalled request body and cancels the stream", async () => {
    const h = await openHarness({ submitTimeoutMs: 20 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await h.app.request(request);
    expect(res.status).toBe(500);
    expect(cancelled).toBe(true);
  });

  it("times out a stalled submission", async () => {
    const stalled: SubmissionPort = {
      submit: (() => new Promise<never>(() => undefined)) as unknown as SubmissionPort["submit"],
      get: () => null,
      accepted: () => null,
      validationLeft: () => 1,
    };
    const h = await openHarness({ submitTimeoutMs: 10, submissions: stalled });
    const res = await submit(h, "call-1", { answer: "ok" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "E_INTERNAL" } });
  });

  it("rate limits per execution token", async () => {
    const h = await openHarness({ rateCapacity: 2 });
    const headers = baseHeaders(h.token);
    expect((await h.app.request(url("/internal/agent/tools"), { headers })).status).toBe(200);
    expect((await h.app.request(url("/internal/agent/tools"), { headers })).status).toBe(200);
    expect((await h.app.request(url("/internal/agent/tools"), { headers })).status).toBe(429);
  });

  it("never echoes the bearer token in an error body", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/tools"), {
      headers: { Host: "evil.example:49991", Authorization: `Bearer ${h.token}` },
    });
    const text = await res.text();
    expect(text).not.toContain(h.token);
  });
});

describe("submit_result semantics against the real store", () => {
  it("rejects invalid output, then accepts a corrected result", async () => {
    const h = await openHarness();
    const first = await submit(h, "call-1", { answer: 42 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ isError: true });
    const rejected = h.store.events.list(h.identity.runId, {
      types: ["node.output.rejected"],
    });
    expect(rejected).toHaveLength(1);

    const second = await submit(h, "call-2", { answer: "fixed" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ isError: false });
    const validated = h.store.events.list(h.identity.runId, {
      types: ["node.output.validated"],
    });
    expect(validated).toHaveLength(1);
  });

  it("rejects and does not persist the exec token echoed in the output", async () => {
    const h = await openHarness();
    const res = await submit(h, "call-1", { answer: h.token });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(h.token);
    expect(
      h.store.submissions.accepted({
        runId: h.identity.runId,
        path: h.identity.path,
        attempt: h.identity.attempt,
      }),
    ).toBeNull();
    expect(
      h.store.events.list(h.identity.runId, {
        types: ["node.output.validated", "node.output.rejected"],
      }),
    ).toHaveLength(0);

    for (const file of [h.dbFile, `${h.dbFile}-wal`]) {
      try {
        const bytes = await readFile(file);
        expect(bytes.includes(Buffer.from(h.token, "utf8"))).toBe(false);
      } catch {
        // WAL may not exist before the first write.
      }
    }
  });

  it("rejects a call id that echoes the exec token without persisting it", async () => {
    const h = await openHarness();
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": h.token },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "ok" } }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(h.token);
    expect(
      h.store.events.list(h.identity.runId, {
        types: ["node.output.validated", "node.output.rejected"],
      }),
    ).toHaveLength(0);
  });

  it("registers the exec token with the store secret guard and releases it on revoke", async () => {
    const h = await openHarness();
    expect(h.store.security.scan({ answer: h.token })).not.toBeNull();
    expect(() =>
      h.store.submissions.submit({
        identity: h.identity,
        callId: "direct-store-call",
        request: { name: "submit_result", arguments: { answer: h.token } },
        ok: true,
        output: { answer: h.token },
      }),
    ).toThrow();
    h.tokens.revoke(h.token);
    expect(h.store.security.scan({ answer: h.token })).toBeNull();
  });

  it("rechecks the token after a stalled body and rejects revocation before submit", async () => {
    const h = await openHarness();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(new TextEncoder().encode('{"name":"submit_result","arguments":'));
      },
    });
    const request = new Request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = h.app.request(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.tokens.revoke(h.token);
    expect(controller).toBeDefined();
    controller?.enqueue(new TextEncoder().encode('{"answer":"ok"}}'));
    controller?.close();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(
      h.store.events.list(h.identity.runId, {
        types: ["node.output.validated", "node.output.rejected"],
      }),
    ).toHaveLength(0);
  });

  it("rechecks token expiry after a stalled body before submit", async () => {
    let clock = Date.now();
    const h = await openHarness({ now: () => clock });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(new TextEncoder().encode('{"name":"submit_result","arguments":'));
      },
    });
    const request = new Request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(h.token), "X-DevChestra-Call-Id": "call-1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = h.app.request(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 120_000;
    expect(controller).toBeDefined();
    controller?.enqueue(new TextEncoder().encode('{"answer":"ok"}}'));
    controller?.close();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(
      h.store.events.list(h.identity.runId, {
        types: ["node.output.validated", "node.output.rejected"],
      }),
    ).toHaveLength(0);
  });

  it("returns the committed receipt for an identical transport retry", async () => {
    const h = await openHarness();
    const first = await submit(h, "call-1", { answer: "ok" });
    const second = await submit(h, "call-1", { answer: "ok" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(
      h.store.events.list(h.identity.runId, { types: ["node.output.validated"] }),
    ).toHaveLength(1);
  });

  it("conflicts when the same receipt id carries a different payload", async () => {
    const h = await openHarness();
    await submit(h, "call-1", { answer: "ok" });
    const altered = await submit(h, "call-1", { answer: "different" });
    expect(altered.status).toBe(409);
    expect(await altered.json()).toMatchObject({ error: { code: "E_CONFLICT" } });
  });

  it("does not accept a submission from a stale generation", async () => {
    const h = await openHarness();
    h.tokens.clear();
    const stale = h.tokens.issue({
      ...h.scope,
      identity: { ...h.identity, generation: h.identity.generation - 1 },
    });
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(stale), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "stale" } }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects a future generation as well as a stale one", async () => {
    const h = await openHarness();
    h.tokens.clear();
    const future = h.tokens.issue({
      ...h.scope,
      identity: { ...h.identity, generation: h.identity.generation + 1 },
    });
    const res = await h.app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(future), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "future" } }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects a new submission after the run is cancelled", async () => {
    const h = await openHarness();
    h.store.events.append(h.identity.runId, [
      {
        runId: h.identity.runId,
        path: "" as Path,
        type: "run.cancelled",
        actor: "user",
        payload: { by: "user" },
      },
    ]);
    const res = await submit(h, "call-1", { answer: "late" });
    expect(res.status).toBe(409);
  });

  it("rejects submissions for a cancelled execution", async () => {
    const h = await openHarness();
    h.store.events.append(h.identity.runId, [
      {
        runId: h.identity.runId,
        path: h.identity.path,
        type: "node.state",
        actor: "engine",
        payload: {
          from: "running",
          to: "cancelled",
          attempt: h.identity.attempt,
          generation: h.identity.generation,
        },
      },
    ]);
    const res = await submit(h, "call-1", { answer: "late" });
    expect(res.status).toBe(409);
  });

  it("returns already accepted for a new call id after success", async () => {
    const h = await openHarness();
    expect((await submit(h, "call-1", { answer: "ok" })).status).toBe(200);
    const second = await submit(h, "call-2", { answer: "other" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { content: { text: string }[]; isError: boolean };
    expect(body.isError).toBe(false);
    expect(body.content[0]?.text).toContain("accepted");
    expect(
      h.store.events.list(h.identity.runId, { types: ["node.output.validated"] }),
    ).toHaveLength(1);
  });

  it("returns already accepted even when a later call is invalid", async () => {
    const h = await openHarness();
    expect((await submit(h, "call-1", { answer: "ok" })).status).toBe(200);
    const second = await submit(h, "call-2", { answer: 42 });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { content: { text: string }[]; isError: boolean };
    expect(body.isError).toBe(false);
    expect(body.content[0]?.text).toContain("accepted");
    expect(h.store.events.list(h.identity.runId, { types: ["node.output.rejected"] })).toHaveLength(
      0,
    );
  });

  it("enforces the durable validation retry cap across restart", async () => {
    const h = await openHarness({ validationLimit: 2 });
    for (const callId of ["call-1", "call-2"]) {
      const res = await submit(h, callId, { answer: 42 });
      expect(await res.json()).toMatchObject({ isError: true });
    }
    expect(h.store.submissions.validationLeft(h.identity)).toBe(0);

    const dbFile = h.dbFile;
    const identity = h.identity;
    h.store.close();
    const reopened = openStore({ file: dbFile });
    cleanups.push(async () => {
      reopened.close();
      await rm(h.dataDir, { recursive: true, force: true });
    });
    expect(reopened.submissions.validationLeft(identity)).toBe(0);

    const tokens = new ExecTokenRegistry();
    const validator = new OutputValidator();
    const compiled = validator.compile(SCHEMA);
    const token = tokens.issue({
      ...h.scope,
      outputSchemaHash: compiled.hash,
      expiresAt: Date.now() + 60_000,
    });
    const app = createAgentGateway({
      tokens,
      submissions: reopened.submissions,
      validator,
      port: PORT,
    });
    const res = await app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(token), "X-DevChestra-Call-Id": "call-3" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: "late" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: { text: string }[]; isError: boolean };
    expect(body.isError).toBe(true);
    expect(body.content[0]?.text).toContain("No attempts left");
    expect(reopened.submissions.validationLeft(identity)).toBe(0);
  });

  it("replays a committed rejected receipt after restart without consuming budget", async () => {
    const h = await openHarness({ validationLimit: 2 });
    const first = await submit(h, "call-1", { answer: 42 });
    expect(await first.json()).toMatchObject({ isError: true });
    expect(h.store.submissions.validationLeft(h.identity)).toBe(1);

    const dbFile = h.dbFile;
    const identity = h.identity;
    h.store.close();
    const reopened = openStore({ file: dbFile });
    cleanups.push(async () => {
      reopened.close();
      await rm(h.dataDir, { recursive: true, force: true });
    });

    const tokens = new ExecTokenRegistry();
    const validator = new OutputValidator();
    const compiled = validator.compile(SCHEMA);
    const token = tokens.issue({
      ...h.scope,
      outputSchemaHash: compiled.hash,
      expiresAt: Date.now() + 60_000,
    });
    const app = createAgentGateway({
      tokens,
      submissions: reopened.submissions,
      validator,
      port: PORT,
    });
    const replay = await app.request(url("/internal/agent/call"), {
      method: "POST",
      headers: { ...baseHeaders(token), "X-DevChestra-Call-Id": "call-1" },
      body: JSON.stringify({ name: "submit_result", arguments: { answer: 42 } }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ isError: true });
    expect(reopened.submissions.validationLeft(identity)).toBe(1);
    expect(reopened.events.list(identity.runId, { types: ["node.output.rejected"] })).toHaveLength(
      1,
    );
  });

  it("keeps accepted output unfinished until process stop and finalization evidence", async () => {
    const h = await openHarness();
    expect((await submit(h, "call-1", { answer: "ok" })).status).toBe(200);
    expect(h.store.executions.get(h.identity.runId, h.identity.path)?.status).not.toBe("succeeded");

    h.store.executions.recordProcessStopped({
      identity: h.identity,
      reason: "exited",
      exitCode: 0,
    });
    expect(h.store.executions.get(h.identity.runId, h.identity.path)?.status).not.toBe("succeeded");

    h.store.executions.recordWorkspaceFinalized({
      identity: h.identity,
      dir: join(h.dataDir, "workspace"),
    });
    const completed = h.store.executions.complete({ identity: h.identity });
    expect(completed.status).toBe("succeeded");
    expect(h.store.executions.get(h.identity.runId, h.identity.path)?.status).toBe("succeeded");
  });
});
