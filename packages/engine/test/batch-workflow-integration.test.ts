import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import type { Path, RunId } from "@devchestra/core";
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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});
function graph(nodes: unknown[], edges: Array<[string, string]>) {
  return { nodes, edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })) };
}
const objectSchema = { type: "object", additionalProperties: true };
function snapshot(id: string, nodes: unknown[], edges: Array<[string, string]>) {
  return { schemaVersion: 1, id, name: id, graph: graph(nodes, edges) };
}
function callChild(inputs: Record<string, string> = { company: "foreach.item.company" }) {
  return node("invoke", "workflow", { workflowId: "resume", inputs });
}
function resumeChild(extra: Record<string, unknown> = {}) {
  return snapshot(
    "resume",
    [
      node("start", "start", {
        params: [
          { name: "company", type: "string", required: true },
          { name: "tone", type: "string", required: false, default: "formal" },
        ],
      }),
      node("refine", "loop", {
        mode: "repeatUntil",
        maxIterations: 5,
        initialState: "{}",
        nextState: "{}",
        result: '{"attempt":loop.iteration}',
        until: "result.attempt >= 2",
        output: objectSchema,
        body: graph(
          [
            node("start", "start", { params: [] }),
            node("done", "end", { status: "success", result: "{}" }),
          ],
          [["start", "done"]],
        ),
        ...extra,
      }),
      node("end", "end", {
        status: "success",
        result: '{"company":start.company,"tone":start.tone,"attempts":refine.iterations}',
      }),
    ],
    [
      ["start", "refine"],
      ["refine", "end"],
    ],
  );
}
function batch(
  source: Record<string, unknown> = {
    kind: "expression",
    expression: '[{"company":"A"},{"company":"B"}]',
  },
  policy = "stop",
  bodyNode = callChild(),
) {
  return snapshot(
    "batch",
    [
      node("start", "start", { params: [] }),
      node("each", "foreach", {
        source,
        maxItems: 1000,
        onItemFailure: policy,
        result: "invoke.result",
        output: objectSchema,
        body: graph(
          [
            node("start", "start", { params: [] }),
            bodyNode,
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
  );
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "devchestra-batch-integration-"));
  const dataDir = join(root, "data"),
    project = join(root, "project");
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
  const input = (workflow: unknown, child = resumeChild()) => ({
    projectId: "p",
    workflowId: "batch",
    snapshot: workflow,
    snapshotRaw: JSON.stringify(workflow),
    workflowDependencies: { resume: child },
  });
  return { engine, store, project, deps, input };
}

describe("sequential batch calling a reusable retry workflow", () => {
  it("runs a separate five-attempt-cap loop per row, applies child defaults, and stores result references", async () => {
    const { engine, store, input } = setup();
    const result = await engine.run(input(batch()));
    if (!result.ok) throw result.error;
    expect(result.value.status, JSON.stringify(result.value)).toBe("succeeded");
    const runId = result.value.runId as RunId;
    const output = store.outputs.get({ runId, path: "each" as Path, attempt: 1 })?.json as Record<
      string,
      unknown
    >;
    expect(output).toMatchObject({ total: 2, processed: 2, succeeded: 2, failed: 0, rejected: 0 });
    expect(typeof output.resultsRef).toBe("string");
    const items = store.foreach.listItems(output.resultsRef as string);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.result)).toEqual([
      { company: "A", tone: "formal", attempts: 2 },
      { company: "B", tone: "formal", attempts: 2 },
    ]);
    for (const item of items) {
      expect(typeof item.outputId).toBe("string");
      expect(store.outputs.getById(item.outputId as string)?.json).toEqual(item.result);
    }
    const children = store.workflowCalls.listByParent(runId);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const record = store.runs.get(child.childRunId as RunId);
      expect(record?.status).toBe("succeeded");
      expect(record?.params).toMatchObject({ tone: "formal" });
      expect(
        store.view.get(child.childRunId as RunId).executions.refine?.loop?.rounds,
      ).toHaveLength(2);
    }
    expect(children.map((child) => child.parentPath)).toEqual(["each[0]/invoke", "each[1]/invoke"]);
    const events = store.events.list(runId, { limit: 1000 });
    expect(events.filter((event) => event.type === "foreach.item.decided")).toHaveLength(2);
  }, 15000);
  it("snapshots multiline CSV rows and exposes only the current row", async () => {
    const { engine, store, project, input } = setup();
    writeFileSync(
      join(project, "jobs.csv"),
      'company,description\nA,"first line\nsecond line"\nB,other\n',
    );
    const result = await engine.run(input(batch({ kind: "csv", path: "jobs.csv" })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    const children = store.workflowCalls.listByParent(result.value.runId as RunId);
    expect(
      children.map((child) => store.runs.get(child.childRunId as RunId)?.params.company),
    ).toEqual(["A", "B"]);
  });
  it("completes an empty collection without spawning child runs", async () => {
    const { engine, store, input } = setup();
    const result = await engine.run(input(batch({ kind: "expression", expression: "[]" })));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ total: 0, processed: 0, succeeded: 0 });
    expect(store.workflowCalls.listByParent(result.value.runId as RunId)).toHaveLength(0);
  });
  it("records unsuccessful children and advances only under continue policy", async () => {
    const { engine, store, input } = setup();
    const failing = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("end", "end", { status: "failed", result: '{"reason":"review exhausted"}' }),
      ],
      [["start", "end"]],
    );
    const continued = await engine.run(input(batch(undefined, "continue"), failing));
    if (!continued.ok) throw continued.error;
    expect(continued.value.status).toBe("succeeded");
    expect(continued.value.result).toMatchObject({ processed: 2, failed: 2 });
    const stopped = await engine.run(input(batch(undefined, "stop"), failing));
    if (!stopped.ok) throw stopped.error;
    expect(stopped.value.status).toBe("failed");
    expect(store.workflowCalls.listByParent(stopped.value.runId as RunId)).toHaveLength(1);
    expect(store.view.get(stopped.value.runId as RunId).executions.each?.foreach).toMatchObject({
      processed: 1,
      failed: 1,
    });
  }, 15000);
  it("counts rejected child runs separately when continuing a batch", async () => {
    const { engine, input } = setup();
    const child = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("end", "end", { status: "rejected", result: '{"reason":"not approved"}' }),
      ],
      [["start", "end"]],
    );
    const result = await engine.run(input(batch(undefined, "continue"), child));
    if (!result.ok) throw result.error;
    expect(result.value.status, JSON.stringify(result.value)).toBe("succeeded");
    expect(result.value.result).toMatchObject({ processed: 2, rejected: 2, failed: 0 });
  });

  it("freezes workflow calls found inside a loop body, not just top-level calls", async () => {
    const { engine, input } = setup();
    const root = snapshot(
      "batch",
      [
        node("start", "start", { params: [] }),
        node("outer", "loop", {
          mode: "repeatUntil",
          maxIterations: 1,
          initialState: "{}",
          result: "invoke.result",
          until: "true",
          output: objectSchema,
          body: graph(
            [
              node("start", "start", { params: [] }),
              callChild({ company: '"Nested"' }),
              node("done", "end", { status: "success", result: "{}" }),
            ],
            [
              ["start", "invoke"],
              ["invoke", "done"],
            ],
          ),
        }),
        node("end", "end", { status: "success", result: "outer.result" }),
      ],
      [
        ["start", "outer"],
        ["outer", "end"],
      ],
    );
    const result = await engine.run(input(root));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toMatchObject({ company: "Nested", attempts: 2 });
  }, 15000);
  it("child parameter validation rejects unknown mappings before child execution", async () => {
    const { engine, store, input } = setup();
    const result = await engine.run(
      input(
        batch(undefined, "stop", callChild({ company: "foreach.item.company", unknown: '"x"' })),
      ),
    );
    if (!result.ok) expect(result.error.code).toBe("E_VALIDATION");
    else {
      expect(result.value.status).toBe("failed");
      expect(store.workflowCalls.listByParent(result.value.runId as RunId)).toHaveLength(0);
    }
  });
  it("continues live when a child approval is resolved, without manually resuming the parent", async () => {
    const { engine, store, input } = setup();
    const child = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("approve", "approval", { message: "Approve this job", irreversible: false }),
        node("end", "end", { status: "success", result: '{"company":start.company}' }),
      ],
      [
        ["start", "approve"],
        ["approve", "end"],
      ],
    );
    const launched = await engine.launch(
      input(batch({ kind: "expression", expression: '[{"company":"A"}]' }), child),
    );
    if (!launched.ok) throw launched.error;
    let childId = "";
    await vi.waitFor(
      () => {
        childId =
          store.workflowCalls.listByParent(launched.value.runId as RunId)[0]?.childRunId ?? "";
        expect(store.approvals.listPending({ runId: childId as RunId })).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const approval = store.approvals.listPending({ runId: childId as RunId })[0];
    if (!approval) throw new Error("Missing pending child approval");
    store.approvals.resolve({
      identity: {
        runId: approval.runId,
        path: approval.path,
        attempt: approval.attempt,
        generation: approval.generation,
      },
      requestId: approval.requestId,
      decision: "approve",
      by: "test",
    });
    const outcome = await launched.value.completion;
    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome.result).toMatchObject({ processed: 1, succeeded: 1 });
  }, 10000);

  it("resumes the same child after shutdown and does not reread an edited CSV", async () => {
    const { engine, store, project, deps, input } = setup();
    writeFileSync(join(project, "jobs.csv"), "company\nOriginal\n");
    const child = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("approve", "approval", {
          message: "Approve {{ start.company }}",
          irreversible: false,
        }),
        node("end", "end", { status: "success", result: '{"company":start.company}' }),
      ],
      [
        ["start", "approve"],
        ["approve", "end"],
      ],
    );
    const launched = await engine.launch(input(batch({ kind: "csv", path: "jobs.csv" }), child));
    if (!launched.ok) throw launched.error;
    const rootId = launched.value.runId as RunId;
    let childId = "";
    await vi.waitFor(
      () => {
        childId = store.workflowCalls.listByParent(rootId)[0]?.childRunId ?? "";
        expect(childId).not.toBe("");
        expect(store.approvals.listPending({ runId: childId as RunId })).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    await engine.stop();
    writeFileSync(join(project, "jobs.csv"), "company\nChanged\nUnexpected second row\n");
    const resumed = createEngine(deps);
    cleanups.push(() => resumed.stop());
    const dispatch = await resumed.launchResume(rootId);
    if (!dispatch.ok) throw dispatch.error;
    const approval = store.approvals.listPending({ runId: childId as RunId })[0];
    if (!approval) throw new Error("Missing child approval");
    store.approvals.resolve({
      identity: {
        runId: approval.runId,
        path: approval.path,
        attempt: approval.attempt,
        generation: approval.generation,
      },
      requestId: approval.requestId,
      decision: "approve",
      by: "test",
    });
    const outcome = await dispatch.value.completion;
    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome.result).toMatchObject({ total: 1, processed: 1 });
    expect(store.workflowCalls.listByParent(rootId).map((link) => link.childRunId)).toEqual([
      childId,
    ]);
    expect(store.runs.get(childId as RunId)?.params.company).toBe("Original");
  }, 15000);

  it("inherits a new parent worktree instead of writing to the project or making another worktree", async () => {
    const { engine, store, project, input } = setup();
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
    writeFileSync(join(project, "base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync("git", ["commit", "-qm", "Initial"], { cwd: project });
    const child = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("write", "shell", {
          command: "node -e \"require('fs').writeFileSync('child-only.txt',process.cwd())\"",
          workspace: { mode: "scratch" },
          timeoutMin: 1,
        }),
        node("end", "end", { status: "success", result: '{"ok":true}' }),
      ],
      [
        ["start", "write"],
        ["write", "end"],
      ],
    );
    const result = await engine.run({
      ...input(batch({ kind: "expression", expression: '[{"company":"A"}]' }), child),
      workspace: { mode: "new-worktree" },
    });
    if (!result.ok) throw result.error;
    expect(result.value.status, JSON.stringify(result.value)).toBe("succeeded");
    const link = store.workflowCalls.listByParent(result.value.runId as RunId)[0];
    if (!link) throw new Error("Missing child link");
    const childRun = store.runs.get(link.childRunId as RunId);
    const selection = childRun?.workspace?.selection;
    expect(selection?.mode).toBe("existing-worktree");
    if (selection?.mode !== "existing-worktree") throw new Error("Child did not inherit worktree");
    expect(existsSync(join(project, "child-only.txt"))).toBe(false);
    expect(readFileSync(join(selection.path, "child-only.txt"), "utf8")).toBe(selection.path);
  }, 15000);

  it("does not hang if the active child is cancelled directly", async () => {
    const { engine, store, input } = setup();
    const child = snapshot(
      "resume",
      [
        node("start", "start", { params: [{ name: "company", type: "string", required: true }] }),
        node("wait", "shell", {
          command: `node -e "setTimeout(()=>{},30000)"`,
          timeoutMin: 1,
          workspace: { mode: "scratch" },
        }),
        node("end", "end", { status: "success", result: "{}" }),
      ],
      [
        ["start", "wait"],
        ["wait", "end"],
      ],
    );
    const launched = await engine.launch(input(batch(undefined, "continue"), child));
    if (!launched.ok) throw launched.error;
    let childId = "";
    await vi.waitFor(
      () => {
        childId =
          store.workflowCalls.listByParent(launched.value.runId as RunId)[0]?.childRunId ?? "";
        expect(childId).not.toBe("");
        expect(store.view.get(childId as RunId).executions.wait?.status).toBe("running");
      },
      { timeout: 5000 },
    );
    await engine.cancel(childId);
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("cancelled");
    expect(store.workflowCalls.listByParent(launched.value.runId as RunId)).toHaveLength(1);
  }, 10000);
});
