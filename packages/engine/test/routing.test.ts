import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import type { Path } from "@devchestra/core";
import { openStore, type RunRecord, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { createEngine } from "../src/engine.js";
import { executeDeterministic } from "../src/exec-deterministic.js";
import { executeGate } from "../src/exec-routing.js";
import { analyzeWorkflowPlan } from "../src/graph-plan.js";
import type { EngineDeps } from "../src/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});
const shell = (id: string, command: string) =>
  node(id, "shell", { command, workspace: { mode: "scratch" }, timeoutMin: 2 });
const end = (id: string, result = "{}") => node(id, "end", { status: "success", result });
const start = () =>
  node("start", "start", { params: [{ name: "route", type: "string", required: false }] });
const gate = (branches: unknown[]) => node("gate", "gate", { branches });
const joinNode = (mode: "first" | "all", inputs: string[]) =>
  node("both", "join", { mode, inputs });

function snapshot(nodes: unknown[], edges: [string, string][]): unknown {
  return {
    schemaVersion: 1,
    id: "routing",
    name: "Routing",
    graph: {
      nodes,
      edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to })),
    },
  };
}

function setup(): { store: Store; file: string; dataDir: string; deps: EngineDeps } {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-routing-"));
  const dataDir = join(base, "data");
  const project = join(base, "project");
  mkdirSync(dataDir);
  mkdirSync(project);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const file = join(dataDir, "devchestra.db");
  const store = openStore({ file });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  return { store, file, dataDir, deps: deps(store, dataDir) };
}

function deps(store: Store, dataDir: string): EngineDeps {
  return {
    store,
    adapters: createAdapterRegistry({ ids: ["fake"] }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: { url: "http://127.0.0.1:1", issue: () => ({ token: "t", revoke: () => undefined }) },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: process.env,
  };
}

function input(snap: unknown, params: Record<string, unknown> = { route: "a" }) {
  return {
    projectId: "p1",
    workflowId: "routing",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
    params: params as never,
  };
}

function runPath() {
  return snapshot(
    [
      start(),
      gate([
        { id: "a", when: 'start.route = "a"' },
        { id: "b", otherwise: true },
      ]),
      shell("sa", "printf A"),
      shell("sb", "printf B"),
      joinNode("all", ["in_a", "in_b"]),
      end("done", '{ "gate": gate, "join": both }'),
    ],
    [
      ["start", "gate"],
      ["gate.a", "sa"],
      ["gate.b", "sb"],
      ["sa", "both.in_a"],
      ["sb", "both.in_b"],
      ["both", "done"],
    ],
  );
}

function events(store: Store, runId: string, type: string) {
  return store.events
    .list(runId as never, { limit: 10_000 })
    .filter((event) => event.type === type);
}

describe("engine routing", () => {
  it("routes one gate branch, skips the other, and joins all declared inputs", async () => {
    const { store, deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const result = await engine.run(input(runPath()));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({
      gate: { branch: "a" },
      join: { in_a: { stdout: "A" }, in_b: null },
    });
    const [decided] = events(store, result.value.runId, "gate.decided");
    expect(decided?.payload).toMatchObject({
      branch: "a",
      evaluated: [{ branch: "a", matched: true }],
    });
    expect(events(store, result.value.runId, "join.resolved")[0]?.payload).toMatchObject({
      mode: "all",
      active: ["in_a"],
      skipped: ["in_b"],
    });
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.sb?.status).toBe("skipped");
    expect(
      events(store, result.value.runId, "node.process.spawned").some((e) => e.path === "sb"),
    ).toBe(false);
    await engine.stop();
  });

  it("fails the gate and run on a non-boolean when, never falling through", async () => {
    const { store, deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [
        start(),
        gate([
          { id: "a", when: "start.route" },
          { id: "b", otherwise: true },
        ]),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        joinNode("all", ["in_a", "in_b"]),
        end("done"),
      ],
      [
        ["start", "gate"],
        ["gate.a", "sa"],
        ["gate.b", "sb"],
        ["sa", "both.in_a"],
        ["sb", "both.in_b"],
        ["both", "done"],
      ],
    );
    const result = await engine.run(input(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    const [decided] = events(store, result.value.runId, "gate.decided");
    expect(decided).toBeDefined();
    const payload = decided?.payload as { branch: unknown; evaluated: { error?: string }[] };
    expect(payload.branch).toBeNull();
    expect(payload.evaluated[0]?.error).toContain("must evaluate to a boolean");
    expect(result.value.error?.code).toBe("E_EXPR");
    expect(events(store, result.value.runId, "node.process.spawned")).toHaveLength(0);
    await engine.stop();
  });

  it("fails the gate on a runtime expression error", async () => {
    const { store, deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [
        start(),
        gate([
          { id: "a", when: '$error("boom")' },
          { id: "b", otherwise: true },
        ]),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        joinNode("all", ["in_a", "in_b"]),
        end("done"),
      ],
      [
        ["start", "gate"],
        ["gate.a", "sa"],
        ["gate.b", "sb"],
        ["sa", "both.in_a"],
        ["sb", "both.in_b"],
        ["both", "done"],
      ],
    );
    const result = await engine.run(input(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_EXPR");
    expect(events(store, result.value.runId, "gate.decided")[0]?.payload).toMatchObject({
      branch: null,
    });
    expect(events(store, result.value.runId, "node.process.spawned")).toHaveLength(0);
    await engine.stop();
  });

  it("rejects join mode first with two active inputs without picking a winner", async () => {
    const { store, deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [
        start(),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        joinNode("first", ["in_a", "in_b"]),
        end("done"),
      ],
      [
        ["start", "sa"],
        ["start", "sb"],
        ["sa", "both.in_a"],
        ["sb", "both.in_b"],
        ["both", "done"],
      ],
    );
    const result = await engine.run(input(snap));
    if (!result.ok) throw result.error;
    if (process.env.DEBUG_ROUTING)
      console.error(
        JSON.stringify(
          store.events
            .list(result.value.runId as never, { limit: 1000 })
            .filter((e) => e.type === "error.logged" || e.type === "node.state")
            .map((e) => ({ p: e.path, t: e.type, x: e.payload })),
          null,
          2,
        ),
      );
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_JOIN_CONFLICT");
    expect(store.view.get(result.value.runId as never).executions.done?.status).not.toBe(
      "succeeded",
    );
    await engine.stop();
  });

  it("rejects two simultaneously active End nodes", async () => {
    const { deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [start(), end("one"), end("two")],
      [
        ["start", "one"],
        ["start", "two"],
      ],
    );
    const result = await engine.run(input(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_WORKFLOW_INVALID");
    expect(result.value.error?.message).toContain("multiple active End nodes");
    await engine.stop();
  });

  it("aborts a pending gate evaluation on shutdown without committing a decision", async () => {
    const { store, deps: engineDeps } = setup();
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(EngineContext.prototype, "expressionExecutor")
      .mockReturnValue({ evaluate: () => pending } as never);
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [
        start(),
        gate([
          { id: "a", when: 'start.route = "a"' },
          { id: "b", otherwise: true },
        ]),
        shell("sa", "printf A"),
        end("ea"),
        shell("sb", "printf B"),
        end("eb"),
      ],
      [
        ["start", "gate"],
        ["gate.a", "sa"],
        ["sa", "ea"],
        ["gate.b", "sb"],
        ["sb", "eb"],
      ],
    );
    const launched = await engine.launch(input(snap));
    if (!launched.ok) throw launched.error;
    for (let i = 0; i < 200; i += 1) {
      if (store.view.get(launched.value.runId as never).executions.gate?.status === "running")
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopping = engine.stop();
    release(true);
    await stopping;
    const stopped = store.view.get(launched.value.runId as never);
    expect(stopped.status).toBe("paused");
    expect(stopped.pauseReason).toBe("shutdown");
    expect(stopped.executions.gate?.status).toBe("interrupted");
    expect(events(store, launched.value.runId, "gate.decided")).toHaveLength(0);
    expect(
      store.outputs.get({
        runId: launched.value.runId as never,
        path: "gate" as never,
        attempt: 1,
      }),
    ).toBeNull();
    spy.mockRestore();

    const resumedEngine = createEngine(deps(store, engineDeps.dataDir));
    const resumed = await resumedEngine.resume(launched.value.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(events(store, launched.value.runId, "gate.decided")).toHaveLength(1);
    await resumedEngine.stop();
  });

  it("keeps sibling outputs out of a node's true-ancestor scope", async () => {
    const { deps: engineDeps } = setup();
    const engine = createEngine(engineDeps);
    const snap = snapshot(
      [
        start(),
        gate([
          { id: "a", when: 'start.route = "a"' },
          { id: "b", otherwise: true },
        ]),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        joinNode("all", ["in_a"]),
        end("ea", '{ "sawSibling": $exists(sb), "join": both }'),
        end("eb"),
      ],
      [
        ["start", "gate"],
        ["gate.a", "sa"],
        ["gate.b", "sb"],
        ["sa", "both.in_a"],
        ["both", "ea"],
        ["sb", "eb"],
      ],
    );
    const result = await engine.run(input(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({
      sawSibling: false,
      join: { in_a: { stdout: "A" } },
    });
    await engine.stop();
  });

  it("refuses to resolve an unresolved ancestor as null", async () => {
    const { store, deps: engineDeps } = setup();
    const snap = runPath() as never;
    const created = store.runs.create({
      projectId: "p1",
      workflowId: "routing",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: { route: "a" },
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const ctx = new EngineContext(engineDeps);
    const run = store.runs.get(created.runId) as RunRecord;
    await expect(ctx.chainOutputs(run, planResult.value, "both")).rejects.toMatchObject({
      code: "E_INTERNAL",
    });
  });

  it("reconstructs the chosen branch after a crash without re-evaluating the gate", async () => {
    const first = setup();
    const snap = runPath() as { graph: { nodes: unknown[]; edges: unknown[] } };
    const created = first.store.runs.create({
      projectId: "p1",
      workflowId: "routing",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: { route: "a" },
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const plan = planResult.value;
    const active: ActiveRunState = {
      abort: new AbortController(),
      reason: null,
      tokens: new Set(),
    };
    const ctx = new EngineContext(first.deps);
    const run = first.store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, plan, plan.byId.get("start") as never, active);
    await executeGate(ctx, run, plan, plan.byId.get("gate") as never, active);
    expect(
      first.store.outputs.get({ runId: created.runId as never, path: "gate" as never, attempt: 1 })
        ?.json,
    ).toEqual({ branch: "a" });
    first.store.close();

    const store = openStore({ file: first.file });
    cleanups.push(() => store.close());
    const engine = createEngine(deps(store, first.dataDir));
    const resumed = await engine.resume(created.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(events(store, created.runId, "gate.decided")).toHaveLength(1);
    expect(
      store.outputs.get({ runId: created.runId as never, path: "gate" as never, attempt: 1 })?.json,
    ).toEqual({ branch: "a" });
    await engine.stop();
  });

  it("preserves a failed gate's error code across crash recovery", async () => {
    const first = setup();
    const snap = snapshot(
      [
        start(),
        gate([
          { id: "a", when: "start.route" },
          { id: "b", otherwise: true },
        ]),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        joinNode("all", ["in_a", "in_b"]),
        end("done"),
      ],
      [
        ["start", "gate"],
        ["gate.a", "sa"],
        ["gate.b", "sb"],
        ["sa", "both.in_a"],
        ["sb", "both.in_b"],
        ["both", "done"],
      ],
    );
    const created = first.store.runs.create({
      projectId: "p1",
      workflowId: "routing",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: { route: "a" },
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const plan = planResult.value;
    const active: ActiveRunState = {
      abort: new AbortController(),
      reason: null,
      tokens: new Set(),
    };
    const ctx = new EngineContext(first.deps);
    const run = first.store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, plan, plan.byId.get("start") as never, active);
    await expect(
      executeGate(ctx, run, plan, plan.byId.get("gate") as never, active),
    ).rejects.toMatchObject({
      code: "E_EXPR",
    });
    first.store.close();

    const store = openStore({ file: first.file });
    cleanups.push(() => store.close());
    const engine = createEngine(deps(store, first.dataDir));
    const resumed = await engine.resume(created.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("failed");
    expect(resumed.value.error?.code).toBe("E_EXPR");
    expect(events(store, created.runId, "node.process.spawned")).toHaveLength(0);
    await engine.stop();
  });

  it("reconciles an End success committed before run.completed without reevaluating", async () => {
    const first = setup();
    const snap = snapshot([start(), end("done", '"recomputed"')], [["start", "done"]]);
    const created = first.store.runs.create({
      projectId: "p1",
      workflowId: "routing",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: { route: "a" },
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const plan = planResult.value;
    const active: ActiveRunState = {
      abort: new AbortController(),
      reason: null,
      tokens: new Set(),
    };
    const ctx = new EngineContext(first.deps);
    const run = first.store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, plan, plan.byId.get("start") as never, active);
    const endExec = first.store.executions.ensure({
      runId: created.runId as never,
      path: "done" as Path,
      nodeId: "done",
      kind: "end",
      requireSubmission: false,
    });
    const identity = first.store.executions.beginInvocation({
      runId: created.runId as never,
      path: "done" as Path,
      attempt: endExec.attempt,
      mode: "fresh",
      resolvedConfigHash: "end",
    });
    first.store.tx(() => {
      first.store.outputs.recordDeterministic({ identity, output: { stored: true } });
      first.store.executions.complete({ identity });
    });
    first.store.close();

    const store = openStore({ file: first.file });
    cleanups.push(() => store.close());
    const engine = createEngine(deps(store, first.dataDir));
    const resumed = await engine.resume(created.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(resumed.value.result).toEqual({ stored: true });
    await engine.stop();
  });
});
