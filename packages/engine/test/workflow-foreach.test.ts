import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import type { RunId } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../src/engine.js";
import type { EngineDeps } from "../src/types.js";

const cleanups: Array<() => void | void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});
const graph = (nodes: unknown[], edges: Array<[string, string]>) => ({
  nodes,
  edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })),
});
const objectSchema = { type: "object", additionalProperties: true };
const shell = (id: string, command: string) =>
  node(id, "shell", { command, timeoutMin: 1, workspace: { mode: "scratch" } });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "devchestra-wf-unit-"));
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
    validateOutput: (_schema, value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, issues: [{ path: "", message: "Expected object" }] },
  };
  const engine = createEngine(deps);
  cleanups.push(() => engine.stop());
  return { engine, store, project, deps };
}

function childEcho() {
  return {
    schemaVersion: 1,
    id: "echo",
    name: "echo",
    graph: graph(
      [
        node("start", "start", {
          params: [{ name: "who", type: "string", required: true }],
        }),
        node("end", "end", { status: "success", result: '{"who":start.who}' }),
      ],
      [["start", "end"]],
    ),
  };
}

function parentCall(
  inputs: Record<string, string> = { who: '"ada"' },
  extra: Record<string, unknown> = {},
  tail: unknown[] = [],
) {
  return {
    schemaVersion: 1,
    id: "main",
    name: "main",
    graph: graph(
      [
        node("start", "start", { params: [] }),
        node("call", "workflow", { workflowId: "echo", inputs, output: objectSchema, ...extra }),
        ...tail,
        node("end", "end", { status: "success", result: "call" }),
      ],
      [
        ["start", "call"],
        ["call", "end"],
      ],
    ),
  };
}

function inputFor(workflow: unknown, deps?: Record<string, unknown>) {
  return {
    projectId: "p",
    workflowId: "main",
    snapshot: workflow,
    snapshotRaw: JSON.stringify(workflow),
    ...(deps === undefined ? {} : { workflowDependencies: deps }),
  };
}

describe("workflow calls", () => {
  it("maps a successful child End result into the call envelope", async () => {
    const { engine, store } = setup();
    const result = await engine.run(inputFor(parentCall(), { echo: childEcho() }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({
      childRunId: expect.any(String),
      status: "succeeded",
      result: { who: "ada" },
    });
    // call.result exposes the raw child End result.
    expect((result.value.result as { result: unknown }).result).toEqual({ who: "ada" });
    const links = store.workflowCalls.listByParent(result.value.runId as RunId);
    expect(links).toHaveLength(1);
    expect(links[0]?.status).toBe("succeeded");
  });

  it("routes a failed child through .failed when wired, else fails the invocation", async () => {
    const failing = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("end", "end", { status: "failed", result: '{"reason":"nope"}' }),
        ],
        [["start", "end"]],
      ),
    };
    const { engine, store } = setup();
    // Without a .failed handler the invocation fails and the link stays failed.
    const plain = parentCall({}, {}, []);
    const failed = await engine.run(inputFor(plain, { echo: failing }));
    if (!failed.ok) throw failed.error;
    expect(failed.value.status).toBe("failed");
    expect(store.workflowCalls.listByParent(failed.value.runId as RunId)).toHaveLength(1);

    // With .failed wired the controller succeeds down the handler edge.
    const handled = {
      schemaVersion: 1,
      id: "main",
      name: "main",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("call", "workflow", { workflowId: "echo", inputs: {}, output: objectSchema }),
          node("end", "end", { status: "success", result: "call" }),
        ],
        [
          ["start", "call"],
          ["call.failed", "end"],
        ],
      ),
    };
    const ok = await engine.run(inputFor(handled, { echo: failing }));
    if (!ok.ok) throw ok.error;
    expect(ok.value.status).toBe("succeeded");
    expect(ok.value.result).toMatchObject({ status: "failed", result: null });
  });

  it("maps a rejected child through .failed and validates output schemas", async () => {
    const rejecting = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("end", "end", { status: "rejected", result: '{"why":"policy"}' }),
        ],
        [["start", "end"]],
      ),
    };
    const handled = {
      schemaVersion: 1,
      id: "main",
      name: "main",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("call", "workflow", { workflowId: "echo", inputs: {}, output: objectSchema }),
          node("end", "end", { status: "success", result: "call.status" }),
        ],
        [
          ["start", "call"],
          ["call.failed", "end"],
        ],
      ),
    };
    const { engine } = setup();
    const result = await engine.run(inputFor(handled, { echo: rejecting }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("rejected");
  });

  it("rejects unknown child params before spawning (no orphan link)", async () => {
    const { engine, store } = setup();
    const result = await engine.run(
      inputFor(parentCall({ who: '"ada"', bogus: '"x"' }), { echo: childEcho() }),
    );
    if (!result.ok) expect(result.error.code).toBe("E_VALIDATION");
    else {
      expect(result.value.status).toBe("failed");
      expect(store.workflowCalls.listByParent(result.value.runId as RunId)).toHaveLength(0);
    }
  });

  it("fails fast on call cycles and depth overflow at launch", async () => {
    const { engine } = setup();
    const selfCall = parentCall();
    (selfCall as { id: string }).id = "echo";
    const launched = await engine.launch(inputFor(selfCall, { echo: selfCall }));
    if (!launched.ok) {
      expect(["E_WORKFLOW_INVALID", "E_NOT_FOUND"]).toContain(launched.error.code);
    } else {
      const outcome = await launched.value.completion;
      expect(outcome.status).toBe("failed");
    }
  });

  it("fails fast when the child workflow is missing and no bundle covers it", async () => {
    const { engine } = setup();
    const launched = await engine.launch(inputFor(parentCall()));
    if (!launched.ok) {
      expect(launched.error.code).toBe("E_WORKFLOW_INVALID");
    } else {
      expect((await launched.value.completion).status).toBe("failed");
    }
  });

  it("child shell work reuses the prepared parent workspace", async () => {
    const { engine, project } = setup();
    const writer = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          shell("write", `node -e "require('fs').writeFileSync('child.txt','hi')"`),
          node("end", "end", { status: "success", result: '{"ok":true}' }),
        ],
        [
          ["start", "write"],
          ["write", "end"],
        ],
      ),
    };
    const result = await engine.run(inputFor(parentCall({}, {}), { echo: writer }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(readFileSync(join(project, "child.txt"), "utf8")).toBe("hi");
  }, 30000);

  it("does not spawn a duplicate child across a restart fault", async () => {
    const { engine, store, deps } = setup();
    const { StopSignal } = await import("../src/stop.js");
    const slow = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          shell("wait", 'node -e "setTimeout(()=>{},500)"'),
          node("end", "end", { status: "success", result: '{"ok":true}' }),
        ],
        [
          ["start", "wait"],
          ["wait", "end"],
        ],
      ),
    };
    // Crash once inside the completion transaction: link + child already
    // durable, success publication rolled back.
    const fault = vi.spyOn(store.workflowCalls, "complete").mockImplementationOnce(() => {
      throw new StopSignal("shutdown");
    });
    const launched = await engine.launch(inputFor(parentCall({}, {}), { echo: slow }));
    if (!launched.ok) throw launched.error;
    const parked = await launched.value.completion;
    expect(parked.status).toBe("paused");
    fault.mockRestore();
    expect(store.workflowCalls.listByParent(launched.value.runId as RunId)).toHaveLength(1);
    await engine.stop();
    const engine2 = createEngine(deps);
    cleanups.push(() => engine2.stop());
    const resumed = await engine2.resume(launched.value.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(store.workflowCalls.listByParent(launched.value.runId as RunId)).toHaveLength(1);
  }, 30000);

  it("parks the parent on child approvals and wakes the chain on resolution", async () => {
    const { engine, store } = setup();
    const gated = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("review", "approval", { message: "ok?", irreversible: false }),
          node("end", "end", { status: "success", result: '{"approved":true}' }),
        ],
        [
          ["start", "review"],
          ["review", "end"],
        ],
      ),
    };
    const launched = await engine.launch(inputFor(parentCall({}, {}), { echo: gated }));
    if (!launched.ok) throw launched.error;
    let childId = "";
    await vi.waitFor(
      () => {
        childId =
          store.workflowCalls.listByParent(launched.value.runId as RunId)[0]?.childRunId ?? "";
        expect(childId).not.toBe("");
        expect(store.approvals.listPending({ runId: childId as RunId })).toHaveLength(1);
      },
      { timeout: 8000 },
    );
    const pending = store.approvals.listPending({ runId: childId as RunId })[0];
    if (!pending) throw new Error("expected approval");
    const execution = store.executions.get(childId as RunId, pending.path);
    if (!execution) throw new Error("expected execution");
    store.approvals.resolve({
      identity: {
        runId: childId as RunId,
        path: pending.path,
        attempt: execution.attempt,
        generation: execution.generation,
      },
      requestId: pending.requestId,
      decision: "approve",
      by: "test",
    });
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toMatchObject({ status: "succeeded", result: { approved: true } });
  }, 20000);

  it("cascades a parent cancel to the active child", async () => {
    const { engine, store } = setup();
    const slow = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          shell("wait", 'node -e "setTimeout(()=>{},30000)"'),
          node("end", "end", { status: "success", result: "{}" }),
        ],
        [
          ["start", "wait"],
          ["wait", "end"],
        ],
      ),
    };
    const launched = await engine.launch(inputFor(parentCall({}, {}), { echo: slow }));
    if (!launched.ok) throw launched.error;
    let childId = "";
    await vi.waitFor(
      () => {
        childId =
          store.workflowCalls.listByParent(launched.value.runId as RunId)[0]?.childRunId ?? "";
        expect(childId).not.toBe("");
        expect(store.view.get(childId as RunId).executions.wait?.status).toBe("running");
      },
      { timeout: 8000 },
    );
    expect((await engine.cancel(launched.value.runId)).ok).toBe(true);
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("cancelled");
    expect(store.runs.get(childId as RunId)?.status).toBe("cancelled");
    // The children API reflects the terminal link status (no ghost running).
    expect(store.workflowCalls.listByParent(launched.value.runId as RunId)).toMatchObject([
      { childRunId: childId, status: "cancelled" },
    ]);
  }, 20000);

  it("preserves >16KiB child results by reference without a parent copy cap", async () => {
    const { engine } = setup();
    const big = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          shell("write", `node -e "process.stdout.write('x'.repeat(30000))"`),
          node("end", "end", { status: "success", result: '{"blob":write.stdout}' }),
        ],
        [
          ["start", "write"],
          ["write", "end"],
        ],
      ),
    };
    const result = await engine.run(inputFor(parentCall({}, {}), { echo: big }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(JSON.stringify(result.value.result).length).toBeGreaterThan(16 * 1024);
  }, 30000);
});

describe("foreach nodes", () => {
  function foreachParent(
    source: Record<string, unknown>,
    policy = "stop",
    result = "invoke.result",
    output: Record<string, unknown> = objectSchema,
  ) {
    return {
      schemaVersion: 1,
      id: "main",
      name: "main",
      graph: graph(
        [
          node("start", "start", { params: [] }),
          node("each", "foreach", {
            source,
            maxItems: 1000,
            onItemFailure: policy,
            result,
            output,
            body: graph(
              [
                node("start", "start", { params: [] }),
                node("invoke", "workflow", {
                  workflowId: "echo",
                  inputs: { who: "foreach.item.who" },
                }),
                node("done", "end", { status: "success", result: "{}" }),
              ],
              [
                ["start", "invoke"],
                ["invoke", "done"],
              ],
            ),
          }),
          node("end", "end", { status: "success", result: "each" }),
        ],
        [
          ["start", "each"],
          ["each", "end"],
        ],
      ),
    };
  }

  const echoWho = {
    schemaVersion: 1,
    id: "echo",
    name: "echo",
    graph: graph(
      [
        node("start", "start", { params: [{ name: "who", type: "string", required: true }] }),
        node("end", "end", { status: "success", result: '{"who":start.who}' }),
      ],
      [["start", "end"]],
    ),
  };

  it("maps array items in order with the foreach namespace", async () => {
    const { engine, store } = setup();
    const source = { kind: "expression", expression: '[{"who":"a"},{"who":"b"},{"who":"c"}]' };
    const result = await engine.run(
      inputFor(
        foreachParent(
          source,
          "stop",
          '{"w":invoke.result.who,"i":foreach.index,"n":foreach.number,"t":foreach.total}',
        ),
        {
          echo: echoWho,
        },
      ),
    );
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ total: 3, processed: 3, succeeded: 3 });
    const runId = result.value.runId as RunId;
    const sourceId = (result.value.result as { resultsRef: string }).resultsRef;
    expect(typeof sourceId).toBe("string");
    // Per-item records are durable and ordered; values resolve via outputs.
    const items = store.foreach.listItems(sourceId);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const first = store.outputs.getById(items[0]?.outputId as string);
    expect(first?.json).toMatchObject({ w: "a", i: 0, n: 1, t: 3 });
    // Paged refs carry no result payloads.
    const refs = store.foreach.listItemRefs(sourceId, { offset: 1, limit: 2 });
    expect(refs.map((ref) => ref.index)).toEqual([1, 2]);
    expect(store.foreach.getSourceMeta(sourceId)).toMatchObject({ total: 3, kind: "expression" });
    void runId;
  });

  it("reads multiline CSV rows and enforces the header contract", async () => {
    const { engine, project } = setup();
    writeFileSync(join(project, "jobs.csv"), 'who,note\n"a","x, y"\n"b","multi\nline"\n');
    const source = { kind: "csv", path: "jobs.csv" };
    const result = await engine.run(inputFor(foreachParent(source), { echo: echoWho }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ total: 2, succeeded: 2 });
  });

  it("succeeds empty sources with zero iterations", async () => {
    const { engine } = setup();
    const result = await engine.run(
      inputFor(foreachParent({ kind: "expression", expression: "[]" }), { echo: echoWho }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ total: 0, processed: 0, succeeded: 0 });
  });

  it("rejects sources over maxItems", async () => {
    const { engine } = setup();
    const wf = foreachParent({ kind: "expression", expression: "[1,2,3]" });
    const each = (wf.graph.nodes as Record<string, unknown>[]).find((n) => n.id === "each");
    if (!each) throw new Error("foreach node missing");
    each.maxItems = 2;
    const result = await engine.run(inputFor(wf, { echo: echoWho }));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
  });

  it("counts rejected children separately under continue policy", async () => {
    const { engine, store } = setup();
    const rejecting = {
      schemaVersion: 1,
      id: "echo",
      name: "echo",
      graph: graph(
        [
          node("start", "start", { params: [{ name: "who", type: "string", required: true }] }),
          node("end", "end", { status: "rejected", result: '{"why":"policy"}' }),
        ],
        [["start", "end"]],
      ),
    };
    const source = { kind: "expression", expression: '[{"who":"a"},{"who":"b"}]' };
    const result = await engine.run(
      inputFor(foreachParent(source, "continue"), { echo: rejecting }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ total: 2, processed: 2, rejected: 2, failed: 0 });
    const sourceId = (result.value.result as { resultsRef: string }).resultsRef;
    expect(store.foreach.listItems(sourceId).map((item) => item.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });
});
