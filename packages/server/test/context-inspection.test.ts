import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Path, RunId } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserApp, createStoreQueryPort } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-ctx-api-"));
  const store = openStore({ file: join(dir, "store.db") });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "wf",
    workflowHash: "h",
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
    params: {},
    budgets: {},
  });
  // Seed one durable output via a deterministic record.
  const path = "draft" as Path;
  store.executions.ensure({ runId: run.runId, path, nodeId: "draft", kind: "shell", requireSubmission: false });
  const identity = store.executions.beginInvocation({ runId: run.runId, path, attempt: 1, resolvedConfigHash: "cfg" });
  const { output } = store.outputs.recordDeterministic({ identity, output: { hello: "world" } });
  cleanups.push(() => {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const query = createStoreQueryPort(store);
  const raw = createBrowserApp({
    dataDir: dir,
    store: query,
    controller: {
      startRun: () => { throw new Error("unused"); },
      cancelRun: async () => ({ runId: run.runId, status: "cancelled" as const }),
      resumeRun: async () => ({ runId: run.runId, status: "running" as const }),
      resolveApproval: async () => { throw new Error("unused"); },
    },
    sessionToken: TOKEN,
    instanceId: "test",
    version: "test",
    port: 51234,
  });
  const app = {
    request(input: Request | string | URL, init?: RequestInit) {
      const headers = new Headers(init?.headers);
      if (!headers.has("Host")) headers.set("Host", HOST);
      return raw.request(input, { ...init, headers });
    },
  } as unknown as ReturnType<typeof createBrowserApp>;
  return { store, runId: run.runId as RunId, outputId: output.id, app, query };
}

const TOKEN = "t".repeat(43);
const HOST = "127.0.0.1:51234";

function cookie() {
  return { Host: HOST, Cookie: `devchestra_session=${TOKEN}` };
}

describe("metadata-first runtime context inspection", () => {
  it("lists execution context without hydrating outputs", async () => {
    const h = harness();
    const res = await h.app.request(`/api/runs/${h.runId}/context`, { headers: cookie() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ path: string; output: { id: string; hash: string; bytes: number } | null }> };
    expect(Array.isArray(body.entries)).toBe(true);
    const draft = body.entries.find((e) => e.path === "draft");
    expect(draft?.output?.id).toBe(h.outputId);
    // Metadata only: no full JSON values in the context payload.
    expect(JSON.stringify(body)).not.toContain("hello");
  });

  it("fetches values on demand with ownership and truncation semantics", async () => {
    const h = harness();
    const ok = await h.app.request(`/api/runs/${h.runId}/outputs/${h.outputId}`, { headers: cookie() });
    expect(ok.status).toBe(200);
    const value = (await ok.json()) as { id: string; truncated: boolean; data: unknown };
    expect(value.id).toBe(h.outputId);
    expect(value.truncated).toBe(false);
    expect(value.data).toEqual({ hello: "world" });
    const missing = await h.app.request(`/api/runs/${h.runId}/outputs/nope`, { headers: cookie() });
    expect(missing.status).toBe(404);
    // Cross-run ownership is rejected.
    const other = h.store.runs.create({
      projectId: "proj",
      workflowId: "wf",
      workflowHash: "h",
      snapshot: { nodes: [] },
      snapshotRaw: "{}",
      params: {},
      budgets: {},
    });
    const cross = await h.app.request(`/api/runs/${other.runId}/outputs/${h.outputId}`, { headers: cookie() });
    expect(cross.status).toBe(404);
  });

  it("never hydrates oversized values and honors exact byte boundaries", async () => {
    const h = harness();
    const bigPath = "big" as Path;
    h.store.executions.ensure({ runId: h.runId, path: bigPath, nodeId: "big", kind: "shell", requireSubmission: false });
    const bigIdentity = h.store.executions.beginInvocation({ runId: h.runId, path: bigPath, attempt: 1, resolvedConfigHash: "cfg" });
    const big = "x".repeat(100 * 1024);
    const { output } = h.store.outputs.recordDeterministic({ identity: bigIdentity, output: { blob: big } });
    // Prove the value-hydration path is never touched for oversized payloads.
    let hydrated = 0;
    const mutable = h.query as unknown as { getOutputById: (id: string) => unknown };
    const original = mutable.getOutputById;
    mutable.getOutputById = (...args: [string]) => {
      hydrated += 1;
      return original(...args);
    };
    const res = await h.app.request(`/api/runs/${h.runId}/outputs/${output.id}`, { headers: cookie() });
    expect(hydrated).toBe(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated: boolean; data: unknown; bytes: number };
    expect(body.truncated).toBe(true);
    expect(body.data).toBeNull();
    expect(body.bytes).toBeGreaterThan(64 * 1024);
    // Exact 64 KiB boundary is served inline; multibyte UTF-8 counts bytes, not chars.
    const exactPath = "exact" as Path;
    h.store.executions.ensure({ runId: h.runId, path: exactPath, nodeId: "exact", kind: "shell", requireSubmission: false });
    const exactIdentity = h.store.executions.beginInvocation({ runId: h.runId, path: exactPath, attempt: 1, resolvedConfigHash: "cfg" });
    // {"v":"..."} with total serialized bytes exactly 65536.
    const overhead = Buffer.byteLength(JSON.stringify({ v: "" }), "utf8");
    const exact = h.store.outputs.recordDeterministic({ identity: exactIdentity, output: { v: "y".repeat(64 * 1024 - overhead) } });
    const exactRes = await h.app.request(`/api/runs/${h.runId}/outputs/${exact.output.id}`, { headers: cookie() });
    const exactBody = (await exactRes.json()) as { truncated: boolean; data: unknown };
    expect(exactBody.truncated).toBe(false);
    expect(exactBody.data).toEqual({ v: "y".repeat(64 * 1024 - overhead) });
    const widePath = "wide" as Path;
    h.store.executions.ensure({ runId: h.runId, path: widePath, nodeId: "wide", kind: "shell", requireSubmission: false });
    const wideIdentity = h.store.executions.beginInvocation({ runId: h.runId, path: widePath, attempt: 1, resolvedConfigHash: "cfg" });
    // 40k multibyte chars: char count under the cap, byte count over it.
    const wide = h.store.outputs.recordDeterministic({ identity: wideIdentity, output: { v: "é".repeat(40 * 1024) } });
    const wideRes = await h.app.request(`/api/runs/${h.runId}/outputs/${wide.output.id}`, { headers: cookie() });
    const wideBody = (await wideRes.json()) as { truncated: boolean; data: unknown; bytes: number };
    expect(wideBody.bytes).toBeGreaterThan(64 * 1024);
    expect(wideBody.truncated).toBe(true);
    expect(wideBody.data).toBeNull();
  });

  it("paginates context and reports loop-body round provenance", async () => {
    const h = harness();
    const loopPath = "refine" as Path;
    h.store.executions.ensure({ runId: h.runId, path: loopPath, nodeId: "refine", kind: "loop", requireSubmission: false });
    const loopIdentity = h.store.executions.beginInvocation({ runId: h.runId, path: loopPath, attempt: 1, resolvedConfigHash: "cfg" });
    h.store.loops.start({ identity: loopIdentity, parent: {}, state: {} });
    const childPath = "refine#1/step" as Path;
    h.store.executions.ensure({ runId: h.runId, path: childPath, nodeId: "step", kind: "shell", requireSubmission: false });
    const first = await h.app.request(`/api/runs/${h.runId}/context?limit=1`, { headers: cookie() });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { entries: Array<{ path: string; loopRound: number | null }>; nextCursor: string | null };
    expect(firstBody.entries).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await h.app.request(`/api/runs/${h.runId}/context?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`, { headers: cookie() });
    const secondBody = (await second.json()) as { entries: Array<{ path: string }> };
    expect(secondBody.entries.length).toBeGreaterThan(0);
    expect(secondBody.entries[0]?.path).not.toBe(firstBody.entries[0]?.path);
    // Path-prefix filtering and body round provenance.
    const kids = await h.app.request(`/api/runs/${h.runId}/context?pathPrefix=${encodeURIComponent("refine#1/")}`, { headers: cookie() });
    const kidsBody = (await kids.json()) as { entries: Array<{ path: string; loopRound: number | null; attempt: number; generation: number }> };
    expect(kidsBody.entries).toHaveLength(1);
    expect(kidsBody.entries[0]?.path).toBe("refine#1/step");
    expect(kidsBody.entries[0]?.loopRound).toBe(1);
    expect(kidsBody.entries[0]?.attempt).toBe(1);
  });
});
