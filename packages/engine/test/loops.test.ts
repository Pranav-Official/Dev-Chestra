import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import type { Path } from "@devchestra/core";
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, type, name: id, ...extra };
}
function graph(nodes: unknown[], edges: Array<[string, string]>) {
  return { nodes, edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })) };
}
function loop(extra: Record<string, unknown> = {}) {
  return node("refine", "loop", {
    mode: "repeatUntil",
    maxIterations: 5,
    initialState: '{"value":0}',
    nextState: '{"value":result.round}',
    result: '{"round":loop.iteration,"previous":loop.state.value}',
    until: "loop.iteration >= 3",
    output: { type: "object", additionalProperties: true },
    body: graph(
      [
        node("start", "start", { params: [] }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [["start", "done"]],
    ),
    ...extra,
  });
}
function snapshot(config: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "loops",
    name: "Loops",
    graph: graph(
      [
        node("start", "start", { params: [] }),
        loop(config),
        node("end", "end", { status: "success", result: "refine" }),
      ],
      [
        ["start", "refine"],
        ["refine", "end"],
      ],
    ),
  };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "devchestra-loop-"));
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
  return { store, engine, deps, project, input };
}

describe("bounded loops", () => {
  it.each([1, 3, 5])("exits in round %i and publishes once", async (rounds) => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: `loop.iteration >= ${rounds}` })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.refine?.loop?.rounds).toHaveLength(rounds);
    const output = store.outputs.get({
      runId: result.value.runId as never,
      path: "refine" as Path,
      attempt: 1,
    });
    expect(output?.json).toEqual({
      result: { round: rounds, previous: rounds - 1 },
      iterations: rounds,
      outcome: "condition_met",
    });
    for (let i = 1; i <= rounds; i++)
      expect(view.executions[`refine#${i}/done`]?.status).toBe("succeeded");
    const completed = store.events
      .list(result.value.runId as never, { limit: 1000 })
      .filter((e) => e.type === "run.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.path).toBe("end");
  });

  it("fails on false at the final round without starting another round", async () => {
    const { store, engine, input } = setup();
    const result = await engine.run(input(snapshot({ until: "false", maxIterations: 2 })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    const view = store.view.get(result.value.runId as never);
    expect(view.errors.some((e) => e.code === "E_LOOP_LIMIT")).toBe(true);
    expect(view.executions["refine#3/start"]).toBeUndefined();
    expect(view.executions.end).toBeUndefined();
  });

  it.each([{ until: '"yes"' }, { initialState: "[]" }, { result: "42" }, { nextState: "null" }])(
    "fails invalid loop values: %j",
    async (config) => {
      const { engine, input } = setup();
      const result = await engine.run(input(snapshot(config)));
      if (result.ok) expect(result.value.status).toBe("failed");
      else
        expect(["E_WORKFLOW_INVALID", "E_EXPR", "E_OUTPUT_INVALID"]).toContain(result.error.code);
    },
  );

  it("preserves shared workspace edits across native shell rounds", async () => {
    const { store, engine, input, project } = setup();
    const command = `node -e "require('fs').appendFileSync('rounds.txt','x')"`;
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("write", "shell", { command, timeoutMin: 1, workspace: { mode: "scratch" } }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "write"],
        ["write", "done"],
      ],
    );
    const result = await engine.run(input(snapshot({ body })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(readFileSync(join(project, "rounds.txt"), "utf8")).toBe("xxx");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions["refine#1/write"]?.workspaceDir).toBe(
      view.executions["refine#3/write"]?.workspaceDir,
    );
  }, 30_000);

  it.each([false, true])(
    "resumes a persisted %s decision without re-running the round",
    async (done) => {
      const { store, engine, input } = setup();
      const decide = store.loops.decide.bind(store.loops);
      const fault = vi.spyOn(store.loops, "decide").mockImplementationOnce((value) => {
        decide(value);
        throw new StopSignal("shutdown");
      });
      const result = await engine.run(
        input(snapshot({ until: done ? "true" : "loop.iteration >= 3" })),
      );
      if (!result.ok) throw result.error;
      expect(result.value.status).toBe("paused");
      fault.mockRestore();
      const resumed = await engine.resume(result.value.runId);
      if (!resumed.ok) throw resumed.error;
      expect(resumed.value.status).toBe("succeeded");
      const view = store.view.get(result.value.runId as never);
      expect(view.executions.refine?.loop?.rounds).toHaveLength(done ? 1 : 3);
      expect(view.executions["refine#1/start"]?.generation).toBe(2);
      expect(view.executions["refine#1/done"]?.generation).toBe(2);
    },
  );

  it("keeps branch decisions and skips local to their round", async () => {
    const { store, engine, input } = setup();
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("choose", "gate", {
          branches: [
            { id: "first", when: "loop.iteration = 1" },
            { id: "later", otherwise: true },
          ],
        }),
        node("a", "gate", { branches: [{ id: "go", otherwise: true }] }),
        node("b", "gate", { branches: [{ id: "go", otherwise: true }] }),
        node("merge", "join", { mode: "first", inputs: ["a", "b"] }),
        node("done", "end", { status: "success", result: "merge" }),
      ],
      [
        ["start", "choose"],
        ["choose.first", "a"],
        ["choose.later", "b"],
        ["a.go", "merge.a"],
        ["b.go", "merge.b"],
        ["merge", "done"],
      ],
    );
    const result = await engine.run(input(snapshot({ body, until: "loop.iteration >= 2" })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions["refine#1/a"]?.status).toBe("succeeded");
    expect(view.executions["refine#1/b"]?.status).toBe("skipped");
    expect(view.executions["refine#2/a"]?.status).toBe("skipped");
    expect(view.executions["refine#2/b"]?.status).toBe("succeeded");
  });

  it("requests a separate approval for each round and resumes the controller", async () => {
    const { store, engine, input } = setup();
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("review", "approval", {
          message: "Approve round {{loop.iteration}}",
          irreversible: false,
        }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "review"],
        ["review", "done"],
      ],
    );
    const launched = await engine.launch(input(snapshot({ body, until: "loop.iteration >= 2" })));
    if (!launched.ok) throw launched.error;
    await launched.value.completion;
    const runId = launched.value.runId as never;
    const requestIds: string[] = [];
    for (let iteration = 1; iteration <= 2; iteration++) {
      await vi.waitFor(() => expect(store.approvals.listPending({ runId })).toHaveLength(1));
      const pending = store.approvals.listPending({ runId })[0];
      if (!pending) throw new Error("Expected an approval request");
      expect(pending.path).toBe(`refine#${iteration}/review`);
      requestIds.push(pending.requestId);
      const execution = store.executions.get(runId, pending.path);
      if (!execution) throw new Error("Expected an approval execution");
      store.approvals.resolve({
        identity: {
          runId,
          path: pending.path,
          attempt: execution.attempt,
          generation: execution.generation,
        },
        requestId: pending.requestId,
        decision: "approve",
        by: "test",
      });
    }
    await vi.waitFor(() => expect(store.view.get(runId).status).toBe("succeeded"));
    expect(new Set(requestIds).size).toBe(2);
  });

  it("cancels a parked loop and all nonterminal children", async () => {
    const { store, engine, input } = setup();
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("review", "approval", { message: "Approve", irreversible: false }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "review"],
        ["review", "done"],
      ],
    );
    const launched = await engine.launch(input(snapshot({ body })));
    if (!launched.ok) throw launched.error;
    await launched.value.completion;
    const conflicting = await engine.launch(input(snapshot()));
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error.code).toBe("E_LOCKED");
    const cancelled = await engine.cancel(launched.value.runId);
    expect(cancelled.ok).toBe(true);
    const view = store.view.get(launched.value.runId as never);
    expect(view.status).toBe("cancelled");
    expect(view.executions.refine?.status).toBe("cancelled");
    expect(view.executions["refine#1/review"]?.status).toBe("cancelled");
    expect(view.executions["refine#2/start"]).toBeUndefined();
    const released = await engine.run(input(snapshot({ until: "true" })));
    if (!released.ok) throw released.error;
    expect(released.value.status).toBe("succeeded");
  });

  it("captures parent parameters once and exposes them through loop.parent", async () => {
    const { store, engine, input } = setup();
    const snap = snapshot({
      initialState: '{"value":start.topic}',
      result: '{"topic":loop.parent.start.topic,"bodyInputs":start}',
      until: "true",
      body: graph(
        [
          node("entry", "start", { params: [] }),
          node("done", "end", { status: "success", result: "{}" }),
        ],
        [["entry", "done"]],
      ),
    });
    snap.graph.nodes[0] = node("start", "start", {
      params: [{ name: "topic", type: "string", required: true }],
    });
    const result = await engine.run({ ...input(snap), params: { topic: "captured" } });
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const output = store.outputs.get({
      runId: result.value.runId as never,
      path: "refine" as Path,
      attempt: 1,
    });
    expect(output?.json).toEqual({
      result: { topic: "captured", bodyInputs: {} },
      iterations: 1,
      outcome: "condition_met",
    });
  });

  it("cancels a running native shell before any next round is created", async () => {
    const { store, engine, input } = setup();
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("wait", "shell", {
          command: 'node -e "setTimeout(()=>{},60000)"',
          timeoutMin: 2,
          workspace: { mode: "scratch" },
        }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "wait"],
        ["wait", "done"],
      ],
    );
    const launched = await engine.launch(input(snapshot({ body })));
    if (!launched.ok) throw launched.error;
    const runId = launched.value.runId as never;
    await vi.waitFor(
      () => expect(store.view.get(runId).executions["refine#1/wait"]?.processSpawned).toBeTruthy(),
      { timeout: 10000 },
    );
    expect((await engine.cancel(launched.value.runId)).ok).toBe(true);
    await launched.value.completion;
    const view = store.view.get(runId);
    expect(view.status).toBe("cancelled");
    expect(view.executions.refine?.status).toBe("cancelled");
    expect(view.executions["refine#1/wait"]?.processStopped).toBeTruthy();
    expect(view.executions["refine#1/wait"]?.workspaceFinalized).toBeTruthy();
    expect(view.executions["refine#2/start"]).toBeUndefined();
  }, 20000);

  it("requires approval to retry an interrupted shell within the same round", async () => {
    const { store, engine, deps, input, project } = setup();
    const body = graph(
      [
        node("start", "start", { params: [] }),
        node("work", "shell", {
          command: `node -e "const fs=require('fs');if(fs.existsSync('started.txt')){fs.appendFileSync('started.txt','x')}else{fs.writeFileSync('started.txt','x');setTimeout(()=>{},60000)}"`,
          timeoutMin: 2,
          workspace: { mode: "scratch" },
        }),
        node("done", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "work"],
        ["work", "done"],
      ],
    );
    const launched = await engine.launch(input(snapshot({ body, until: "true" })));
    if (!launched.ok) throw launched.error;
    await vi.waitFor(() => expect(existsSync(join(project, "started.txt"))).toBe(true), {
      timeout: 10000,
    });
    await engine.stop();
    const paused = await launched.value.completion;
    expect(paused.status).toBe("paused");
    const resumedEngine = createEngine(deps);
    cleanups.push(() => resumedEngine.stop());
    const denied = await resumedEngine.resume(launched.value.runId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("E_CONFLICT");
    const resumed = await resumedEngine.resume(launched.value.runId, {
      allowUncertainSideEffectRetry: true,
      approvedBy: "tester",
    });
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(readFileSync(join(project, "started.txt"), "utf8")).toBe("xx");
    const view = store.view.get(launched.value.runId as never);
    expect(view.executions.refine?.loop?.rounds).toHaveLength(1);
    expect(view.executions["refine#1/work"]?.generation).toBeGreaterThan(2);
    expect(view.executions["refine#2/start"]).toBeUndefined();
  }, 45000);
});
