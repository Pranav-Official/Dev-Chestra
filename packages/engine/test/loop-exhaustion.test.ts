import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { loopTerminalOutcome, type Path } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../src/engine.js";
import { StopSignal } from "../src/stop.js";
import type { EngineDeps } from "../src/types.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, type, name: id, ...extra };
}

function bodyGraph(work?: Record<string, unknown>) {
  const nodes = [
    node("start", "start", { params: [] }),
    ...(work ? [work] : []),
    node("done", "end", { status: "success", result: "{}" }),
  ];
  const edges = work
    ? [
        { id: "b0", from: "start", to: "work" },
        { id: "b1", from: "work", to: "done" },
      ]
    : [{ id: "b0", from: "start", to: "done" }];
  return { nodes, edges };
}

function loop(extra: Record<string, unknown> = {}) {
  return node("refine", "loop", {
    mode: "repeatUntil",
    maxIterations: 5,
    initialState: '{"value":0}',
    nextState: '{"value":result.round}',
    result: '{"round":loop.iteration}',
    until: "false",
    output: { type: "object", additionalProperties: true },
    body: bodyGraph(),
    ...extra,
  });
}

/** start -> refine; refine -> ok (success); optionally refine.exhausted -> spent. */
function snapshot(config: Record<string, unknown> = {}, wired = true) {
  return {
    schemaVersion: 1,
    id: "loops",
    name: "Loops",
    graph: {
      nodes: [
        node("start", "start", { params: [] }),
        loop(config),
        node("ok", "end", { status: "success", result: "refine" }),
        ...(wired ? [node("spent", "end", { status: "success", result: "refine" })] : []),
      ],
      edges: [
        { id: "e0", from: "start", to: "refine" },
        { id: "e1", from: "refine", to: "ok" },
        ...(wired ? [{ id: "e2", from: "refine.exhausted", to: "spent" }] : []),
      ],
    },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "devchestra-loop-exhaust-"));
  const dataDir = join(root, "data");
  const project = join(root, "project");
  mkdirSync(dataDir);
  mkdirSync(project);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "store.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p", name: "Project", path: project, kind: "folder" });
  const deps: EngineDeps = {
    store,
    dataDir,
    adapters: createAdapterRegistry({ ids: ["fake"] }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: { url: "http://127.0.0.1:1", issue: () => ({ token: "unused", revoke() {} }) },
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: process.env,
    validateOutput: (schema, value) =>
      schema.type === "object" && typeof value === "object" && value !== null
        ? { ok: true }
        : { ok: false, issues: [{ path: "", message: "Expected object" }] },
  };
  const engine = createEngine(deps);
  cleanups.push(() => engine.stop());
  const input = (snap: unknown) => ({
    projectId: "p",
    workflowId: "loops",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
  });
  return { store, engine, deps, input };
}

function completedPath(store: ReturnType<typeof setup>["store"], runId: string): unknown {
  return store.events
    .list(runId as never, { limit: 1000 })
    .filter((e) => e.type === "run.completed")
    .map((e) => e.path);
}

describe("loop alternate routing", () => {
  it("takes only the exhausted branch when the condition never matches", async () => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: "false" })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const runId = result.value.runId;
    const view = store.view.get(runId as never);
    const controller = view.executions.refine;
    expect(controller?.status).toBe("succeeded");
    expect(controller?.loop?.rounds).toHaveLength(5);
    const last = controller?.loop?.rounds.at(-1);
    // `done` keeps meaning "condition matched": never faked for exhaustion.
    expect(last).toMatchObject({ iteration: 5, done: false, outcome: "iteration_limit" });
    expect(last?.nextState).toBeNull();
    expect(controller?.loop?.iteration).toBe(5);
    expect(loopTerminalOutcome(controller?.loop)).toBe("iteration_limit");
    // No sixth round was started.
    expect(view.executions["refine#6/start"]).toBeUndefined();
    expect(view.executions.spent?.status).toBe("succeeded");
    expect(view.executions.ok?.status).toBe("skipped");
    expect(completedPath(store, runId)).toEqual(["spent"]);
    const output = store.outputs.get({ runId: runId as never, path: "refine" as Path, attempt: 1 });
    expect(output?.json).toEqual({
      result: { round: 5 },
      iterations: 5,
      outcome: "iteration_limit",
    });
    expect(view.errors).toEqual([]);
  });

  it("takes only the success branch when the condition matches on the final round", async () => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: "loop.iteration >= 5" })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const runId = result.value.runId;
    const view = store.view.get(runId as never);
    const last = view.executions.refine?.loop?.rounds.at(-1);
    expect(view.executions.refine?.loop?.rounds).toHaveLength(5);
    expect(last).toMatchObject({ iteration: 5, done: true, outcome: "condition_met" });
    expect(view.executions["refine#6/start"]).toBeUndefined();
    expect(view.executions.ok?.status).toBe("succeeded");
    expect(view.executions.spent?.status).toBe("skipped");
    expect(completedPath(store, runId)).toEqual(["ok"]);
    const output = store.outputs.get({ runId: runId as never, path: "refine" as Path, attempt: 1 });
    expect(output?.json).toMatchObject({ iterations: 5, outcome: "condition_met" });
  });

  it("takes the success branch on an early match even with exhaustion wired", async () => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: "loop.iteration >= 2" })));
    if (!result.ok) throw result.error;
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.refine?.loop?.rounds).toHaveLength(2);
    expect(view.executions.ok?.status).toBe("succeeded");
    expect(view.executions.spent?.status).toBe("skipped");
  });

  it("keeps exhaustion a run failure when `.exhausted` is not wired", async () => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: "false", maxIterations: 2 }, false)));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    const view = store.view.get(result.value.runId as never);
    expect(view.errors.some((e) => e.code === "E_LOOP_LIMIT")).toBe(true);
    expect(view.executions.refine?.status).toBe("failed");
    // Historical shape: a plain false round, never an explicit terminal outcome.
    const last = view.executions.refine?.loop?.rounds.at(-1);
    expect(last).toMatchObject({ iteration: 2, done: false, outcome: null });
    expect(view.executions.ok).toBeUndefined();
    expect(view.executions["refine#3/start"]).toBeUndefined();
  });

  it("fails on an actual child error even when `.exhausted` is wired", async () => {
    const { store, engine, input } = setup();
    const work = node("work", "shell", {
      command: `node -e "process.exit(3)"`,
      timeoutMin: 1,
      workspace: { mode: "scratch" },
    });
    const result = await engine.run(input(snapshot({ body: bodyGraph(work) })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.refine?.status).toBe("failed");
    expect(view.executions.refine?.loop?.rounds).toHaveLength(0);
    expect(view.errors.length).toBeGreaterThan(0);
    expect(view.errors.some((e) => e.code === "E_LOOP_LIMIT")).toBe(false);
    expect(view.executions.spent).toBeUndefined();
    expect(view.executions.ok).toBeUndefined();
  }, 30000);

  it("fails on an error in the final round's decision even when `.exhausted` is wired", async () => {
    const { store, engine, input } = setup();
    // Round 5 produces a non-boolean `until`, which is a real error, not exhaustion.
    const result = await engine.run(
      input(snapshot({ until: "loop.iteration >= 5 ? 'maybe' : false" })),
    );
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    const view = store.view.get(result.value.runId as never);
    expect(view.errors.some((e) => e.code === "E_EXPR")).toBe(true);
    expect(view.executions.refine?.loop?.rounds).toHaveLength(4);
    expect(view.executions.spent).toBeUndefined();
  });

  it("completes exhaustion after a crash between the final decision and publication", async () => {
    const { store, engine, deps, input } = setup();
    const decide = store.loops.decide.bind(store.loops);
    vi.spyOn(store.loops, "decide").mockImplementation((args) => {
      const decided = decide(args);
      if (args.outcome === "iteration_limit") throw new StopSignal("shutdown");
      return decided;
    });
    const first = await engine.run(input(snapshot({ until: "false", maxIterations: 3 })));
    if (!first.ok) throw first.error;
    expect(first.value.status).not.toBe("succeeded");
    const runId = first.value.runId as never;
    const before = store.view.get(runId);
    // The terminal round is durable but nothing has been published yet.
    expect(loopTerminalOutcome(before.executions.refine?.loop)).toBe("iteration_limit");
    expect(before.executions.refine?.status).not.toBe("succeeded");
    expect(before.executions.spent).toBeUndefined();

    vi.restoreAllMocks();
    const resumedEngine = createEngine(deps);
    cleanups.push(() => resumedEngine.stop());
    const resumed = await resumedEngine.resume(runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    const after = store.view.get(runId);
    // Resume reuses the recorded terminal round: no extra round, no duplicate decision.
    expect(after.executions.refine?.loop?.rounds).toHaveLength(3);
    expect(after.executions["refine#4/start"]).toBeUndefined();
    expect(after.executions.spent?.status).toBe("succeeded");
    expect(after.executions.ok?.status).toBe("skipped");
    const decided = store.events
      .list(runId, { limit: 1000 })
      .filter((e) => e.type === "loop.iteration.decided");
    expect(decided).toHaveLength(3);
  });
});
