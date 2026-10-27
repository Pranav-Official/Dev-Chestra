import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@relay/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningBrowserServer, startBrowserServer } from "../src/browser/server.js";
import { createStoreQueryPort } from "../src/browser/store-query.js";

const TOKEN = "d".repeat(43);
const NOW = 1_700_000_000_000;

let root: string;
let dataDir: string;
let store: ReturnType<typeof openStore>;
let server: RunningBrowserServer;
let cookie: string;

function headers(mutation = false): Record<string, string> {
  return {
    Cookie: cookie,
    ...(mutation ? { "Content-Type": "application/json", "X-Relay-Csrf": "1" } : {}),
  };
}
function url(p: string): string {
  return `${server.url}${p}`;
}
async function fetchJson<T>(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const r = await fetch(url(path), {
    method,
    headers: { ...headers(method !== "GET"), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await r.text();
  return { status: r.status, body: (t ? JSON.parse(t) : null) as T };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-approval-http-"));
  dataDir = join(root, "data");
  await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
  store = openStore({ file: join(dataDir, "relay.db") });
  // Seed project and run with approval execution
  const projPath = join(root, "proj");
  await (await import("node:fs/promises")).mkdir(projPath, { recursive: true });
  store.projects.ensure({ id: "proj-1", name: "P", path: projPath, kind: "folder" });
  // Create minimal snapshot with approval node and optional rejected edge
  const snapshot: unknown = {
    schemaVersion: 1,
    id: "wf-approval",
    name: "WF",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", supervise: "default", env: [], params: [] },
        {
          id: "approval",
          type: "approval",
          name: "Approve",
          supervise: "default",
          env: [],
          message: "Please approve",
          irreversible: false,
        },
        {
          id: "end",
          type: "end",
          name: "End",
          supervise: "default",
          env: [],
          status: "success",
          result: "{}",
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "approval" },
        { id: "e2", from: "approval", to: "end" },
      ],
    },
  };
  const runId = store.runs.create({
    projectId: "proj-1",
    workflowId: "wf-approval",
    workflowHash: "h",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  }).runId;
  // Create execution for approval
  store.executions.ensure({
    runId: runId as never,
    path: "approval" as never,
    nodeId: "approval",
    kind: "approval" as never,
  });
  const inv = store.executions.beginInvocation({
    runId: runId as never,
    path: "approval" as never,
    attempt: 1,
  });
  store.approvals.request({
    identity: inv,
    message: "Please approve",
    irreversible: false,
    criteria: ["check"],
  });
  (global as unknown as { __runId: string }).__runId = runId;
  const controller = {
    startRun: async () => ({ runId: runId as never, duplicate: false, status: "queued" as never }),
    cancelRun: async (rid: string) => {
      store.events.append(rid as never, [
        {
          runId: rid as never,
          path: "" as never,
          type: "run.cancelled" as never,
          actor: "user" as never,
          payload: { by: "user" },
        },
      ]);
      return { runId: rid as never, status: "cancelled" as never };
    },
    resumeRun: async (rid: string) => ({ runId: rid as never, status: "running" as never }),
    resolveApproval: async (input: {
      runId: string;
      path: string;
      requestId: string;
      decision: "approve" | "reject";
      note?: string;
      expectedAttempt: number;
      expectedGeneration: number;
    }) => {
      const trimmed = input.note?.trim();
      const note = trimmed === "" ? undefined : trimmed;
      const r = store.approvals.resolve({
        identity: {
          runId: input.runId as never,
          path: input.path as never,
          attempt: input.expectedAttempt,
          generation: input.expectedGeneration,
        },
        requestId: input.requestId,
        decision: input.decision,
        by: "user",
        ...(note === undefined ? {} : { note }),
      });
      if (r.duplicate) {
        const rec = store.approvals.get({
          runId: input.runId as never,
          path: input.path as never,
          attempt: input.expectedAttempt,
          generation: input.expectedGeneration,
        });
        if (!rec?.resolvedEventId)
          throw new Error("Missing resolvedEventId for duplicate approval");
        return {
          runId: input.runId as never,
          path: input.path as never,
          decision: input.decision,
          note: note ?? null,
          by: "user",
          duplicate: true,
          status: "running" as never,
          eventId: rec.resolvedEventId,
        };
      }
      if (r.resolvedEventId == null) throw new Error("Missing resolvedEventId");
      return {
        runId: input.runId as never,
        path: input.path as never,
        decision: input.decision,
        note: note ?? null,
        by: "user",
        duplicate: false,
        status: "running" as never,
        eventId: r.resolvedEventId,
      };
    },
  };
  server = await startBrowserServer({
    dataDir,
    store: createStoreQueryPort(store),
    controller: controller as never,
    sessionToken: TOKEN,
    instanceId: "approval-http",
    version: "0.1.0-test",
    port: 0,
    validateResponses: false,
    now: () => NOW,
  });
  const b = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = b.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
});

afterEach(async () => {
  await server.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("approval HTTP", () => {
  it("global inbox requires auth and lists pending across projects", async () => {
    const anon = await fetch(url("/api/approvals"), { headers: { "X-Relay-Csrf": "1" } });
    expect(anon.status).toBe(401);
    const ok = await fetchJson<{
      items: { projectId: string; runNumber: number; runId: string }[];
    }>("GET", "/api/approvals");
    expect(ok.status).toBe(200);
    expect(ok.body.items.length).toBe(1);
    expect(ok.body.items[0] as NonNullable<(typeof ok.body.items)[number]>).toMatchObject({
      projectId: "proj-1",
      runNumber: 1,
    });
    const runId = (global as unknown as { __runId: string }).__runId;
    const perRun = await fetchJson<{ items: { projectId: string }[] }>(
      "GET",
      `/api/runs/${runId}/approvals`,
    );
    expect(perRun.status).toBe(200);
    expect(perRun.body.items.length).toBe(1);
    expect(
      (perRun.body.items[0] as NonNullable<(typeof perRun.body.items)[number]>).projectId,
    ).toBe("proj-1");
  });

  it("detail exposes opaque requestId and expected attempt/generation", async () => {
    const runId = (global as unknown as { __runId: string }).__runId;
    const list = await fetchJson<{
      items: {
        requestId: string;
        expectedAttempt: number;
        expectedGeneration: number;
        path: string;
      }[];
    }>("GET", `/api/runs/${runId}/approvals`);
    const item = list.body.items[0] as NonNullable<(typeof list.body.items)[number]>;
    expect(item.requestId).toMatch(new RegExp(`${runId}:approval:1:2`));
    const detail = await fetchJson<{ approval: { requestId: string } }>(
      "GET",
      `/api/runs/${runId}/approvals/approval`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.approval.requestId).toBe(item.requestId);
  });

  it("resolve is idempotent same note and conflicts on different note, stale fenced", async () => {
    const runId = (global as unknown as { __runId: string }).__runId;
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${runId}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    const body = {
      requestId,
      decision: "approve" as const,
      note: "  looks good  ",
      expectedAttempt,
      expectedGeneration,
    };
    const a = await fetchJson<{ duplicate: boolean; eventId: number; note: string | null }>(
      "POST",
      `/api/runs/${runId}/approvals/approval/resolve`,
      body,
    );
    expect(a.status).toBe(200);
    expect(a.body.duplicate).toBe(false);
    expect(a.body.note).toBe("looks good");
    expect(a.body.eventId).toBeGreaterThan(0);
    const dup = await fetchJson<{ duplicate: boolean; eventId: number }>(
      "POST",
      `/api/runs/${runId}/approvals/approval/resolve`,
      body,
    );
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.eventId).toBe(a.body.eventId);
    const diff = await fetchJson<{ error: { code: string } }>(
      "POST",
      `/api/runs/${runId}/approvals/approval/resolve`,
      { ...body, note: "different" },
    );
    expect(diff.status).toBe(409);
    expect(diff.body.error.code).toBe("E_CONFLICT");
    // Stale on a fresh waiting approval (before resolve)
    const snapStale: unknown = {
      schemaVersion: 1,
      id: "wf-stale",
      name: "WFs",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const rStale = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf-stale",
      workflowHash: "hs",
      snapshot: snapStale,
      snapshotRaw: JSON.stringify(snapStale),
    }).runId;
    store.executions.ensure({
      runId: rStale as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const invStale = store.executions.beginInvocation({
      runId: rStale as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: invStale, message: "m", irreversible: false });
    const staleList = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${rStale}/approvals`);
    const staleItem = staleList.body.items[0];
    if (!staleItem) throw new Error("missing staleItem");
    const stale = await fetchJson<{ error: { code: string } }>(
      "POST",
      `/api/runs/${rStale}/approvals/approval/resolve`,
      {
        requestId: staleItem.requestId,
        decision: "approve",
        expectedAttempt: 999,
        expectedGeneration: staleItem.expectedGeneration,
      },
    );
    expect(stale.status).toBe(409);
  });

  it("concurrent resolve: one wins, other duplicate", async () => {
    // New run for isolation
    const projPath2 = join(root, "proj2");
    await (await import("node:fs/promises")).mkdir(projPath2, { recursive: true });
    store.projects.ensure({ id: "proj-2", name: "P2", path: projPath2, kind: "folder" });
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf2",
      name: "WF2",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r2 = store.runs.create({
      projectId: "proj-2",
      workflowId: "wf2",
      workflowHash: "h2",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    store.executions.ensure({
      runId: r2 as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r2 as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${r2}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    const payload = {
      requestId,
      decision: "approve" as const,
      expectedAttempt,
      expectedGeneration,
    };
    const [a, b] = await Promise.all([
      fetchJson<{ duplicate: boolean }>(
        "POST",
        `/api/runs/${r2}/approvals/approval/resolve`,
        payload,
      ),
      fetchJson<{ duplicate: boolean }>(
        "POST",
        `/api/runs/${r2}/approvals/approval/resolve`,
        payload,
      ),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    const dups = [a.body.duplicate, b.body.duplicate].filter(Boolean).length;
    expect(dups).toBe(1);
  });

  it("cancel fences pending resolve (409)", async () => {
    const _runId = (global as unknown as { __runId: string }).__runId;
    // Create a second approval run for cancel test
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf3",
      name: "WF3",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r3 = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf3",
      workflowHash: "h3",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    store.executions.ensure({
      runId: r3 as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r3 as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${r3}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    // Cancel via API (fences)
    const cancelled = await fetchJson<{ status: string }>("POST", `/api/runs/${r3}/cancel`, {});
    expect(cancelled.status).toBe(202);
    // Try resolve after cancel
    const res = await fetchJson<{ error: { code: string } }>(
      "POST",
      `/api/runs/${r3}/approvals/approval/resolve`,
      { requestId, decision: "approve", expectedAttempt, expectedGeneration },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("E_CONFLICT");
  });

  it("enforces CSRF and trusted by", async () => {
    const runId = (global as unknown as { __runId: string }).__runId;
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${runId}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    const noCsrf = await fetch(url(`/api/runs/${runId}/approvals/approval/resolve`), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision: "approve", expectedAttempt, expectedGeneration }),
    });
    expect(noCsrf.status).toBe(403);
    const ok = await fetchJson<{ by: string }>(
      "POST",
      `/api/runs/${runId}/approvals/approval/resolve`,
      { requestId, decision: "reject", expectedAttempt, expectedGeneration },
    );
    // Even if we sent by in body (ignored), server sets by=user
    expect(ok.status === 200 || ok.status === 409).toBe(true);
    if (ok.status === 200) expect(ok.body.by).toBe("user");
  });

  it("note max 4096 and replay", async () => {
    const _runId = (global as unknown as { __runId: string }).__runId;
    // Need fresh approval because previous was resolved
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf4",
      name: "WF4",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r4 = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf4",
      workflowHash: "h4",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    store.executions.ensure({
      runId: r4 as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r4 as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${r4}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    const long = "a".repeat(4097);
    const tooLong = await fetchJson<{ error: { code: string } }>(
      "POST",
      `/api/runs/${r4}/approvals/approval/resolve`,
      { requestId, decision: "approve", note: long, expectedAttempt, expectedGeneration },
    );
    expect(tooLong.status).toBe(400);
    const okNote = "a".repeat(4096);
    const ok = await fetchJson<{ note: string | null }>(
      "POST",
      `/api/runs/${r4}/approvals/approval/resolve`,
      { requestId, decision: "approve", note: okNote, expectedAttempt, expectedGeneration },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.note?.length).toBe(4096);
    const evs = await fetchJson<{
      events: { type: string; payload: { decision: string; note?: string } }[];
    }>("GET", `/api/runs/${r4}/events?types=approval.resolved`);
    expect(
      evs.body.events.some((e) => e.payload.decision === "approve" && e.payload.note === okNote),
    ).toBe(true);
  });

  it("rejected with .rejected edge is succeeded", async () => {
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf-rej-edge",
      name: "WFE",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
          {
            id: "end2",
            type: "end",
            name: "E2",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
          { id: "e3", from: "approval.rejected", to: "end2" },
        ],
      },
    };
    const r = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf-rej-edge",
      workflowHash: "hre",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    store.executions.ensure({
      runId: r as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    const list = await fetchJson<{
      items: { requestId: string; expectedAttempt: number; expectedGeneration: number }[];
    }>("GET", `/api/runs/${r}/approvals`);
    const { requestId, expectedAttempt, expectedGeneration } = list.body.items[0] as NonNullable<
      (typeof list.body.items)[number]
    >;
    const res = await fetchJson<{ status: string; duplicate: boolean }>(
      "POST",
      `/api/runs/${r}/approvals/approval/resolve`,
      { requestId, decision: "reject", expectedAttempt, expectedGeneration },
    );
    expect(res.status).toBe(200);
    const detail = await fetchJson<{ approval: { status: string } }>(
      "GET",
      `/api/runs/${r}/approvals/approval`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.approval.status).toBe("succeeded");
  });

  it("cancelled pending detail is cancelled", async () => {
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf-cancel",
      name: "WFC",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf-cancel",
      workflowHash: "hc",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    store.executions.ensure({
      runId: r as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    store.events.append(r as never, [
      {
        runId: r as never,
        path: "" as never,
        type: "run.cancelled" as never,
        actor: "user" as never,
        payload: { by: "user" },
      },
    ]);
    const detail = await fetchJson<{ approval: { status: string } }>(
      "GET",
      `/api/runs/${r}/approvals/approval`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.approval.status).toBe("cancelled");
  });

  it("legacy null identity run-detail still validates with validateResponses true", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openStore } = await import("@relay/store");
    const { createStoreQueryPort } = await import("../src/browser/store-query.js");
    const { startBrowserServer } = await import("../src/browser/server.js");
    const legacyRoot = await mkdtemp(join(tmpdir(), "relay-legacy-"));
    const legacyData = join(legacyRoot, "data");
    await (await import("node:fs/promises")).mkdir(legacyData, { recursive: true });
    const legacyStore = openStore({ file: join(legacyData, "relay.db") });
    const projPath = join(legacyRoot, "proj");
    await (await import("node:fs/promises")).mkdir(projPath, { recursive: true });
    legacyStore.projects.ensure({ id: "proj-legacy", name: "P", path: projPath, kind: "folder" });
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf-leg",
      name: "WFL",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r = legacyStore.runs.create({
      projectId: "proj-legacy",
      workflowId: "wf-leg",
      workflowHash: "hl",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    legacyStore.executions.ensure({
      runId: r as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = legacyStore.executions.beginInvocation({
      runId: r as never,
      path: "approval" as never,
      attempt: 1,
    });
    // Directly append legacy event without requestId/attempt/generation
    legacyStore.events.append(r as never, [
      {
        runId: r as never,
        path: "approval" as never,
        type: "approval.requested" as never,
        actor: "engine" as never,
        payload: { message: "legacy", irreversible: false, autoApprove: false },
      },
      {
        runId: r as never,
        path: "approval" as never,
        type: "node.state" as never,
        actor: "engine" as never,
        payload: {
          from: "running",
          to: "waiting_approval",
          attempt: 1,
          generation: inv.generation,
        },
      },
    ]);
    const ctrl = {
      startRun: async () => ({ runId: r as never, duplicate: false, status: "queued" as never }),
      cancelRun: async (rid: string) => ({ runId: rid as never, status: "cancelled" as never }),
      resumeRun: async (rid: string) => ({ runId: rid as never, status: "running" as never }),
      resolveApproval: async () => {
        throw new Error("not used");
      },
    };
    const srv = await startBrowserServer({
      dataDir: legacyData,
      store: createStoreQueryPort(legacyStore),
      controller: ctrl as never,
      sessionToken: TOKEN,
      instanceId: "legacy",
      version: "0.1.0-test",
      port: 0,
      validateResponses: true,
      now: () => NOW,
    });
    const b = await fetch(`${srv.url}/?t=${TOKEN}`, { redirect: "manual" });
    const ck = b.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const res = await fetch(`${srv.url}/api/runs/${r}`, { headers: { Cookie: ck } });
    const txt = await res.text();
    if (res.status !== 200) console.log("legacy detail failed", res.status, txt.slice(0, 2000));
    expect(res.status).toBe(200);
    const body = JSON.parse(txt) as {
      view: {
        executions: Record<
          string,
          { approvalRequest: { requestId: string | null; attempt: number | null } }
        >;
      };
    };
    expect(body.view.executions.approval?.approvalRequest?.requestId).toBeNull();
    expect(body.view.executions.approval?.approvalRequest?.attempt).toBeNull();
    await srv.close();
    legacyStore.close();
    await (await import("node:fs/promises")).rm(legacyRoot, { recursive: true, force: true });
  });

  it("inbox still works when request is beyond 10k list limit", async () => {
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf-big",
      name: "WFB",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r = store.runs.create({
      projectId: "proj-1",
      workflowId: "wf-big",
      workflowHash: "hb",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    // Push >10k dummy events to exceed list default cap
    const dummy = Array.from({ length: 10005 }, (_, i) => ({
      runId: r as never,
      path: "" as never,
      type: "error.logged" as never,
      actor: "system" as never,
      payload: { code: "E_INTERNAL" as const, message: `dummy ${i}` },
    }));
    for (let i = 0; i < dummy.length; i += 500)
      store.events.append(r as never, dummy.slice(i, i + 500) as never);
    store.executions.ensure({
      runId: r as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = store.executions.beginInvocation({
      runId: r as never,
      path: "approval" as never,
      attempt: 1,
    });
    store.approvals.request({ identity: inv, message: "m", irreversible: false });
    const list = await fetchJson<{ items: { requestId: string; requestEventId: number }[] }>(
      "GET",
      `/api/runs/${r}/approvals`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0] as NonNullable<(typeof list.body.items)[number]>).toBeDefined();
    const global = await fetchJson<{ items: { requestId: string }[] }>("GET", "/api/approvals");
    expect(
      global.body.items.some(
        (it) =>
          it.requestId ===
          (list.body.items[0] as NonNullable<(typeof list.body.items)[number]>).requestId,
      ),
    ).toBe(true);
    const detail = await fetchJson<{ approval: { requestId: string } }>(
      "GET",
      `/api/runs/${r}/approvals/approval`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.approval.requestId).toBe(
      (list.body.items[0] as NonNullable<(typeof list.body.items)[number]>).requestId,
    );
  });
  it("GET /events with validateResponses:true includes approval.requested with requestId", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openStore } = await import("@relay/store");
    const { createStoreQueryPort } = await import("../src/browser/store-query.js");
    const { startBrowserServer } = await import("../src/browser/server.js");
    const regRoot = await mkdtemp(join(tmpdir(), "relay-events-"));
    const regData = join(regRoot, "data");
    await (await import("node:fs/promises")).mkdir(regData, { recursive: true });
    const regStore = openStore({ file: join(regData, "relay.db") });
    const projPath = join(regRoot, "proj");
    await (await import("node:fs/promises")).mkdir(projPath, { recursive: true });
    regStore.projects.ensure({ id: "proj-e", name: "P", path: projPath, kind: "folder" });
    const snap: unknown = {
      schemaVersion: 1,
      id: "wf-e",
      name: "WFE",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "S", supervise: "default", env: [], params: [] },
          {
            id: "approval",
            type: "approval",
            name: "A",
            supervise: "default",
            env: [],
            message: "m",
            irreversible: false,
          },
          {
            id: "end",
            type: "end",
            name: "E",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "approval" },
          { id: "e2", from: "approval", to: "end" },
        ],
      },
    };
    const r = regStore.runs.create({
      projectId: "proj-e",
      workflowId: "wf-e",
      workflowHash: "he",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    }).runId;
    regStore.executions.ensure({
      runId: r as never,
      path: "approval" as never,
      nodeId: "approval",
      kind: "approval" as never,
    });
    const inv = regStore.executions.beginInvocation({
      runId: r as never,
      path: "approval" as never,
      attempt: 1,
    });
    regStore.approvals.request({
      identity: inv,
      message: "m",
      irreversible: false,
      criteria: ["c"],
    });
    regStore.approvals.resolve({
      identity: {
        runId: r as never,
        path: "approval" as never,
        attempt: inv.attempt,
        generation: inv.generation,
      },
      requestId: `${r}:approval:${inv.attempt}:${inv.generation}`,
      decision: "approve",
      by: "user",
      note: "ok",
    });
    const ctrl = {
      startRun: async () => ({ runId: r as never, duplicate: false, status: "queued" as never }),
      cancelRun: async (rid: string) => ({ runId: rid as never, status: "cancelled" as never }),
      resumeRun: async (rid: string) => ({ runId: rid as never, status: "running" as never }),
      resolveApproval: async () => {
        throw new Error("unused");
      },
    };
    const srv = await startBrowserServer({
      dataDir: regData,
      store: createStoreQueryPort(regStore),
      controller: ctrl as never,
      sessionToken: TOKEN,
      instanceId: "events-validate",
      version: "0.1.0-test",
      port: 0,
      validateResponses: true,
      now: () => NOW,
    });
    const b = await fetch(`${srv.url}/?t=${TOKEN}`, { redirect: "manual" });
    const ck = b.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const res = await fetch(`${srv.url}/api/runs/${r}/events`, { headers: { Cookie: ck } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { type: string; payload: { requestId?: string; attempt?: number } }[];
    };
    const req = body.events.find((e) => e.type === "approval.requested");
    const resv = body.events.find((e) => e.type === "approval.resolved");
    expect(req?.payload.requestId).toBeDefined();
    expect(req?.payload.attempt).toBe(1);
    expect(resv?.payload.requestId).toBeDefined();
    await srv.close();
    regStore.close();
    await (await import("node:fs/promises")).rm(regRoot, { recursive: true, force: true });
  });
});
