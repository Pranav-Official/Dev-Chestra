import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, EngineDeps, LaunchResult } from "../src/types.js";

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

function snapshot(id: string, nodes: unknown[], edges: Array<[string, string]>) {
  return { schemaVersion: 1, id, name: id, graph: graph(nodes, edges) };
}

/** Holds its run (and its queue slot) until `gate` exists on disk. */
function gatedWorkflow(gate: string) {
  const wait =
    `node -e "const f=require('fs');const t=setInterval(()=>{` +
    `if(f.existsSync('${gate}')){clearInterval(t);process.exit(0)}},20)"`;
  return snapshot(
    "gated",
    [
      node("start", "start", { params: [] }),
      node("hold", "shell", { command: wait, timeoutMin: 1 }),
      node("done", "end", { status: "success", result: "{}" }),
    ],
    [
      ["start", "hold"],
      ["hold", "done"],
    ],
  );
}

function gatedChild(gate: string) {
  return { ...gatedWorkflow(gate), id: "gated-child", name: "gated-child" };
}

function parentWorkflow() {
  return snapshot(
    "parent",
    [
      node("start", "start", { params: [] }),
      node("call", "workflow", {
        workflowId: "gated-child",
        inputs: {},
        output: { type: "object", additionalProperties: true },
      }),
      node("done", "end", { status: "success", result: "{}" }),
    ],
    [
      ["start", "call"],
      ["call", "done"],
    ],
  );
}

/** Parks at an approval, which must not hold a queue slot. */
function approvalWorkflow() {
  return snapshot(
    "approval",
    [
      node("start", "start", { params: [] }),
      node("review", "approval", { message: "Approve?", irreversible: false }),
      node("done", "end", { status: "success", result: "{}" }),
    ],
    [
      ["start", "review"],
      ["review", "done"],
    ],
  );
}

function touch(path: string): void {
  writeFileSync(path, "");
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Harness {
  root: string;
  dataDir: string;
  project: string;
  store: Store;
  engine: Engine;
  gate(name: string): string;
  launch(snap: unknown): Promise<LaunchResult>;
}

function depsFor(store: Store, dataDir: string): EngineDeps {
  return {
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
    validateOutput: (_schema, value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, issues: [{ path: "", message: "Expected object" }] },
  };
}

function mount(dataDir: string, project: string): { store: Store; engine: Engine } {
  const store = openStore({ file: join(dataDir, "store.db") });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // The restart test closes this store itself.
    }
  });
  store.projects.ensure({ id: "p", name: "Project", path: project, kind: "folder" });
  const engine = createEngine(depsFor(store, dataDir));
  cleanups.push(() => engine.stop());
  return { store, engine };
}

function setup(limits: { maxConcurrentRuns: number; maxQueueDepth: number }): Harness {
  const root = mkdtempSync(join(tmpdir(), "devchestra-queue-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const project = join(root, "project");
  mkdirSync(dataDir);
  mkdirSync(project);
  const { store, engine } = mount(dataDir, project);
  store.executionSettings.set(limits);
  const launch = async (snap: unknown): Promise<LaunchResult> => {
    const launched = await engine.launch({
      projectId: "p",
      workflowId: "queue",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
    });
    if (!launched.ok) throw launched.error;
    return launched.value;
  };
  return {
    root,
    dataDir,
    project,
    store,
    engine,
    gate: (name) => join(root, `${name}.gate`),
    launch,
  };
}

describe("execution queue", () => {
  it("queues a run behind the only slot and starts it when that slot frees", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const gateA = h.gate("a");
    const gateB = h.gate("b");
    const first = await h.launch(gatedWorkflow(gateA));
    expect(h.store.runs.get(first.runId as never)?.status).toBe("running");
    const second = await h.launch(gatedWorkflow(gateB));
    expect(h.store.runs.get(second.runId as never)?.status).toBe("queued");

    touch(gateA);
    expect((await first.completion).status).toBe("succeeded");
    expect(h.store.runs.get(second.runId as never)?.status).toBe("running");

    touch(gateB);
    expect((await second.completion).status).toBe("succeeded");
  });

  it("cancelling a queued run settles it without starting it", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const gateA = h.gate("a");
    const first = await h.launch(gatedWorkflow(gateA));
    const second = await h.launch(gatedWorkflow(h.gate("b")));

    const cancelled = await h.engine.cancel(second.runId);
    expect(cancelled.ok).toBe(true);
    expect((await second.completion).status).toBe("cancelled");
    expect(Object.keys(h.store.view.get(second.runId as never).executions)).toHaveLength(0);

    touch(gateA);
    expect((await first.completion).status).toBe("succeeded");
  });

  it("rejects a launch with E_QUEUE_FULL once the queue holds maxQueueDepth runs", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const gateA = h.gate("a");
    const first = await h.launch(gatedWorkflow(gateA));
    const queued: LaunchResult[] = [];
    for (let i = 0; i < 10; i++) queued.push(await h.launch(gatedWorkflow(h.gate(`q${i}`))));

    const overflow = await h.engine.launch({
      projectId: "p",
      workflowId: "queue",
      snapshot: gatedWorkflow(h.gate("overflow")),
      snapshotRaw: "{}",
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("E_QUEUE_FULL");

    for (const run of queued) await h.engine.cancel(run.runId);
    touch(gateA);
    expect((await first.completion).status).toBe("succeeded");
  });

  it("a parked approval releases its slot to the next run", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const parked = await h.launch(approvalWorkflow());
    expect((await parked.completion).status).toBe("waiting_approval");

    const gate = h.gate("runner");
    const runner = await h.launch(gatedWorkflow(gate));
    expect(h.store.runs.get(runner.runId as never)?.status).toBe("running");
    touch(gate);
    expect((await runner.completion).status).toBe("succeeded");
    await h.engine.cancel(parked.runId);
  });

  it("an approval resolved while the slot is busy waits for a slot before resuming", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const parked = await h.launch(approvalWorkflow());
    await parked.completion;
    const pending = h.store.approvals.listPending({ runId: parked.runId as never })[0];
    if (pending === undefined) throw new Error("expected a pending approval");
    const execution = h.store.executions.get(parked.runId as never, "review" as never);
    if (execution === null) throw new Error("expected the approval execution");

    const gate = h.gate("runner");
    const runner = await h.launch(gatedWorkflow(gate));
    h.store.approvals.resolve({
      identity: {
        runId: parked.runId as never,
        path: "review" as never,
        attempt: execution.attempt,
        generation: execution.generation,
      },
      requestId: pending.requestId,
      decision: "approve",
      by: "tester",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.store.view.get(parked.runId as never).executions.done).toBeUndefined();

    touch(gate);
    expect((await runner.completion).status).toBe("succeeded");
    await waitFor(
      () => h.store.runs.get(parked.runId as never)?.status === "succeeded",
      "the resumed approval run to finish",
    );
  });

  it("raising the limit and pumping the queue starts waiting runs", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const gateA = h.gate("a");
    const gateB = h.gate("b");
    const first = await h.launch(gatedWorkflow(gateA));
    const second = await h.launch(gatedWorkflow(gateB));
    expect(h.store.runs.get(second.runId as never)?.status).toBe("queued");

    h.store.executionSettings.set({ maxConcurrentRuns: 2, maxQueueDepth: 10 });
    h.engine.pumpQueue();
    expect(h.store.runs.get(second.runId as never)?.status).toBe("running");

    touch(gateA);
    touch(gateB);
    expect((await first.completion).status).toBe("succeeded");
    expect((await second.completion).status).toBe("succeeded");
  });

  it("a child workflow runs inside its parent's slot and an unrelated run queues behind the lineage", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const childGate = h.gate("child");
    const parent = await h.engine.launch({
      projectId: "p",
      workflowId: "parent",
      snapshot: parentWorkflow(),
      snapshotRaw: "{}",
      workflowDependencies: { "gated-child": gatedChild(childGate) },
    });
    if (!parent.ok) throw parent.error;
    const later = await h.launch(gatedWorkflow(h.gate("later")));

    // The child must start without a free slot of its own, or it would deadlock here.
    await waitFor(
      () =>
        h.store.workflowCalls
          .listByParent(parent.value.runId as never)
          .some((link) => h.store.runs.get(link.childRunId as never)?.status === "running"),
      "the child workflow to start inside the parent's slot",
    );
    expect(h.store.runs.get(later.runId as never)?.status).toBe("queued");

    touch(childGate);
    const parentOutcome = await parent.value.completion;
    expect(parentOutcome.error ?? null).toBeNull();
    expect(parentOutcome.status).toBe("succeeded");
    expect(h.store.runs.get(later.runId as never)?.status).toBe("running");
    touch(h.gate("later"));
    expect((await later.completion).status).toBe("succeeded");
  });

  it("a queued exclusive run does not block a running neighbour's child workflow", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const childGate = h.gate("child");
    const dependencies = { "gated-child": gatedChild(childGate) };
    const running = await h.engine.launch({
      projectId: "p",
      workflowId: "parent",
      snapshot: parentWorkflow(),
      snapshotRaw: "{}",
      workflowDependencies: dependencies,
    });
    if (!running.ok) throw running.error;
    const queued = await h.engine.launch({
      projectId: "p",
      workflowId: "parent-two",
      snapshot: parentWorkflow(),
      snapshotRaw: "{}",
      workflowDependencies: dependencies,
    });
    if (!queued.ok) throw queued.error;
    expect(h.store.runs.get(queued.value.runId as never)?.status).toBe("queued");

    await waitFor(
      () =>
        h.store.workflowCalls
          .listByParent(running.value.runId as never)
          .some((link) => h.store.runs.get(link.childRunId as never)?.status === "running"),
      "the running parent's child to start",
    );
    touch(childGate);
    expect((await running.value.completion).status).toBe("succeeded");
    expect((await queued.value.completion).status).toBe("succeeded");
  });

  it("queued runs survive a restart and start on the next engine without a new launch", async () => {
    const h = setup({ maxConcurrentRuns: 1, maxQueueDepth: 10 });
    const gateB = h.gate("b");
    await h.launch(gatedWorkflow(h.gate("a")));
    const second = await h.launch(gatedWorkflow(gateB));
    expect(h.store.runs.get(second.runId as never)?.status).toBe("queued");

    await h.engine.stop();
    h.store.close();

    const restarted = mount(h.dataDir, h.project);
    await restarted.engine.start();
    await waitFor(
      () => restarted.store.runs.get(second.runId as never)?.status === "running",
      "the queued run to start after restart",
    );
    touch(gateB);
    await waitFor(
      () => restarted.store.runs.get(second.runId as never)?.status === "succeeded",
      "the restarted run to finish",
    );
  });
});
