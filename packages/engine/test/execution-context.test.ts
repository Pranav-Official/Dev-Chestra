import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Path, RunId } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import type { Store } from "@devchestra/store";
import { acquireScratch, finalizeScratch, releaseScratch } from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { EngineContext } from "../src/context.js";
import { collectParentContext, ExecutionContextCache, resolveLoopParent } from "../src/execution-context.js";
import { analyzeWorkflowPlan } from "../src/graph-plan.js";
import { buildScopeData } from "../src/scope.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(params: Record<string, unknown> = { topic: "oceans" }) {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-eng-ctx-"));
  const store = openStore({ file: join(dir, "store.db") });
  store.projects.ensure({ id: "p", name: "P", path: dir, kind: "folder" });
  const created = store.runs.create({
    projectId: "p",
    workflowId: "w",
    workflowHash: "h",
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
    params: params as never,
    budgets: {},
  });
  const run = store.runs.get(created.runId);
  if (!run) throw new Error("run missing");
  const ctx = new EngineContext({
    store,
    adapters: { get() { throw new Error("not used"); }, has: () => false, ids: () => [] },
    workspaces: { acquire: acquireScratch, finalize: finalizeScratch, release: releaseScratch },
    gateway: { url: "http://127.0.0.1:1", issue() { throw new Error("not used"); } },
    dataDir: dir,
    nodeBin: process.execPath,
    mcpShimEntry: "/unused",
  });
  cleanups.push(() => {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, run, ctx };
}

function succeed(store: Store, runId: RunId, nodeId: string, output: unknown) {
  const path = nodeId as Path;
  store.executions.ensure({ runId, path, nodeId, requireSubmission: false });
  const identity = store.executions.beginInvocation({ runId, path, attempt: 1, resolvedConfigHash: "cfg" });
  store.outputs.recordDeterministic({ identity, output });
  store.executions.complete({ identity });
  return identity;
}

describe("ExecutionContextCache lifecycle", () => {
  it("scopes entries per run, freezes clones, and evicts on release", () => {
    const cache = new ExecutionContextCache();
    cache.set("c1", "run-a" as RunId, { start: { a: 1 } });
    const first = cache.get("c1", "run-a" as RunId);
    expect(first).toEqual({ start: { a: 1 } });
    // Cross-run hits are rejected.
    expect(cache.get("c1", "run-b" as RunId)).toBeUndefined();
    // Cached objects are frozen copies: mutation never leaks back.
    (first as Record<string, unknown>).start = { hacked: true };
    expect(cache.get("c1", "run-a" as RunId)).toEqual({ start: { a: 1 } });
    cache.evictRun("run-a" as RunId);
    expect(cache.get("c1", "run-a" as RunId)).toBeUndefined();
  });

  it("bounds growth and releases terminal runs from the engine", () => {
    const { store, run, ctx } = harness();
    const cache = ctx.contextCache;
    for (let i = 0; i < 250; i++) {
      cache.set(`c${i}`, run.id, { n: i });
    }
    expect(cache.get("c0", run.id)).toBeUndefined();
    expect(cache.get("c249", run.id)).toEqual({ n: 249 });
    cache.set("keep", run.id, { ok: true });
    ctx.releaseRunContext(run.id as string);
    expect(cache.get("keep", run.id)).toBeUndefined();
    expect(cache.get("c249", run.id)).toBeUndefined();
    void store;
  });
});

describe("collectParentContext parity", () => {
  function linearPlan(startId = "start") {
    const graph = {
      nodes: [
        { id: startId, type: "start", name: "Start", params: [] },
        { id: "a", type: "shell", name: "A", command: "echo", workspace: { mode: "scratch" as const }, timeoutMin: 1, allowFailure: false },
        { id: "loop", type: "loop", name: "Loop", mode: "repeatUntil", maxIterations: 2, until: "true", result: "loop.state", output: { type: "object" }, body: { nodes: [{ id: "bstart", type: "start", name: "BStart", params: [] }, { id: "bdone", type: "end", name: "BDone", status: "success", result: "{}" }], edges: [{ id: "be0", from: "bstart", to: "bdone" }] } },
        { id: "end", type: "end", name: "End", status: "success", result: "loop" },
      ],
      edges: [
        { id: "e0", from: startId, to: "a" },
        { id: "e1", from: "a", to: "loop" },
        { id: "e2", from: "loop", to: "end" },
      ],
    };
    const plan = analyzeWorkflowPlan({ schemaVersion: 1, id: "w", name: "W", graph });
    if (!plan.ok) throw plan.error;
    return plan.value;
  }

  it("matches chainOutputs scope and pins exact output ids", async () => {
    const { store, run, ctx } = harness({ topic: "oceans" });
    // Start output (params copy) + one succeeded ancestor.
    const startPath = "start" as Path;
    store.executions.ensure({ runId: run.id, path: startPath, nodeId: "start", kind: "start", requireSubmission: false });
    const startIdentity = store.executions.beginInvocation({ runId: run.id, path: startPath, attempt: 1, resolvedConfigHash: "cfg" });
    store.outputs.recordDeterministic({ identity: startIdentity, output: { ...run.params } });
    store.executions.complete({ identity: startIdentity });
    succeed(store, run.id, "a", { x: 1 });
    const plan = linearPlan();
    const ancestors = await ctx.chainOutputs(run, plan, "loop");
    const expected = buildScopeData(run.params, ancestors);
    const { scope, entries } = collectParentContext(ctx, run, plan, "loop");
    expect(scope).toEqual(expected);
    expect(entries.find((e) => e.name === "start")).toEqual({ name: "start", type: "run-params" });
    const aEntry = entries.find((e) => e.name === "a");
    expect(aEntry?.type).toBe("output");
    if (aEntry?.type === "output") {
      const accepted = store.outputs.get({ runId: run.id, path: "a" as Path, attempt: 1 });
      expect(aEntry.outputId).toBe(accepted?.id);
    }
  });

  it("keeps start alias and actual node id consistent for nonstandard start ids", async () => {
    const { store, run, ctx } = harness({ topic: "oceans" });
    const beginPath = "begin" as Path;
    store.executions.ensure({ runId: run.id, path: beginPath, nodeId: "begin", kind: "start", requireSubmission: false });
    const beginIdentity = store.executions.beginInvocation({ runId: run.id, path: beginPath, attempt: 1, resolvedConfigHash: "cfg" });
    store.outputs.recordDeterministic({ identity: beginIdentity, output: { ...run.params } });
    store.executions.complete({ identity: beginIdentity });
    succeed(store, run.id, "a", { x: 1 });
    const plan = linearPlan("begin");
    const ancestors = await ctx.chainOutputs(run, plan, "loop");
    const expected = buildScopeData(run.params, ancestors);
    const { scope, entries } = collectParentContext(ctx, run, plan, "loop");
    expect(scope).toEqual(expected);
    expect(scope.start).toEqual({ topic: "oceans" });
    expect(scope).toHaveProperty("begin");
    expect(entries.find((e) => e.name === "start")).toEqual({ name: "start", type: "run-params" });
    expect(entries.find((e) => e.name === "begin")?.type).toBe("output");
  });

  it("resolves legacy inline parents without a capture", () => {
    const { store, run } = harness();
    const scope = resolveLoopParent(store, run, { iteration: 1, parent: { a: 1 }, parentRef: null, state: {}, rounds: [] }, undefined);
    expect(scope).toEqual({ a: 1 });
  });
});
