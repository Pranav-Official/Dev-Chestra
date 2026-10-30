import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionIdentity,
  FakeClock,
  FakeIdGen,
  type Path,
  type RunId,
} from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-wf-foreach-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "batch",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    params: {},
    budgets: {},
  });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, runId: run.runId };
}

function identity(store: Store, runId: RunId, nodeId: string): ExecutionIdentity {
  const path = nodeId as Path;
  store.executions.ensure({ runId, path, nodeId, kind: "workflow", requireSubmission: false });
  return store.executions.beginInvocation({ runId, path, attempt: 1, mode: "fresh" });
}

function childRun(store: Store, workflowId = "resume"): RunId {
  return store.runs.create({
    projectId: "proj",
    workflowId,
    workflowHash: "child-hash",
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
    params: {},
    budgets: {},
  }).runId;
}

describe("workflow child links", () => {
  it("links atomically and reattaches duplicates instead of respawning", () => {
    const { store, runId } = harness();
    const id = identity(store, runId, "call");
    const child = childRun(store);
    const first = store.workflowCalls.link({
      identity: id,
      childRunId: child as string,
      workflowId: "resume",
      workflowHash: "child-hash",
    });
    expect(first.duplicate).toBe(false);
    const second = store.workflowCalls.link({
      identity: id,
      childRunId: child as string,
      workflowId: "resume",
      workflowHash: "child-hash",
    });
    expect(second.duplicate).toBe(true);
    expect(store.workflowCalls.listByParent(runId)).toHaveLength(1);
    expect(store.workflowCalls.getParent(child as string)?.parentRunId).toBe(runId);
  });

  it("rejects a different child for the same parent attempt", () => {
    const { store, runId } = harness();
    const id = identity(store, runId, "call");
    store.workflowCalls.link({
      identity: id,
      childRunId: childRun(store) as string,
      workflowId: "resume",
      workflowHash: "h",
    });
    expect(() =>
      store.workflowCalls.link({
        identity: id,
        childRunId: childRun(store) as string,
        workflowId: "resume",
        workflowHash: "h",
      }),
    ).toThrow();
  });

  it("rejects cross-project children", () => {
    const { store, runId } = harness();
    store.projects.ensure({ id: "other", name: "Other", path: `${runId}-other`, kind: "folder" });
    const foreign = store.runs.create({
      projectId: "other",
      workflowId: "resume",
      workflowHash: "h",
      snapshot: {},
      snapshotRaw: "{}",
      params: {},
      budgets: {},
    }).runId;
    expect(() =>
      store.workflowCalls.link({
        identity: identity(store, runId, "call"),
        childRunId: foreign as string,
        workflowId: "resume",
        workflowHash: "h",
      }),
    ).toThrow();
  });

  it("round-trips the frozen bundle", () => {
    const { store, runId } = harness();
    store.workflowCalls.putBundle(runId, { resume: { nodes: [] } }, "bundle-hash");
    expect(store.workflowCalls.getBundle(runId)).toMatchObject({
      hash: "bundle-hash",
      bundle: { resume: { nodes: [] } },
    });
  });
});

describe("foreach sources and items", () => {
  function foreachIdentity(store: Store, runId: RunId): ExecutionIdentity {
    const path = "each" as Path;
    store.executions.ensure({
      runId,
      path,
      nodeId: "each",
      kind: "foreach",
      requireSubmission: false,
    });
    return store.executions.beginInvocation({ runId, path, attempt: 1, mode: "fresh" });
  }

  it("snapshots items immutably and reuses the attempt row", () => {
    const { store, runId } = harness();
    const id = foreachIdentity(store, runId);
    const first = store.foreach.createSource({
      identity: id,
      kind: "expression",
      items: [{ a: 1 }],
      maxItems: 10,
    });
    const second = store.foreach.createSource({
      identity: id,
      kind: "expression",
      items: [{ a: 1 }],
      maxItems: 10,
    });
    expect(second.duplicate).toBe(true);
    expect(second.source.id).toBe(first.source.id);
    expect(store.foreach.getSourceByAttempt(runId, "each" as Path, 1)?.items).toEqual([{ a: 1 }]);
  });

  it("enforces maxItems and the 64 KiB per-item bound", () => {
    const { store, runId } = harness();
    const id = foreachIdentity(store, runId);
    expect(() =>
      store.foreach.createSource({ identity: id, kind: "expression", items: [1, 2], maxItems: 1 }),
    ).toThrow();
    expect(() =>
      store.foreach.createSource({
        identity: id,
        kind: "expression",
        items: ["x".repeat(70 * 1024)],
        maxItems: 10,
      }),
    ).toThrow();
  });

  it("records ordered items with durable output rows resolvable via outputs", () => {
    const { store, runId } = harness();
    const id = foreachIdentity(store, runId);
    const { source } = store.foreach.createSource({
      identity: id,
      kind: "expression",
      items: [{ company: "A" }, { company: "B" }],
      maxItems: 10,
    });
    store.foreach.start({
      identity: id,
      total: 2,
      maxItems: 10,
      sourceId: source.id,
      sourceHash: source.sourceHash,
    });
    // Out-of-order index is rejected before the gap can form.
    expect(() =>
      store.foreach.decideItem({
        identity: id,
        sourceId: source.id,
        index: 1,
        status: "succeeded",
        result: {},
      }),
    ).toThrow();
    store.foreach.decideItem({
      identity: id,
      sourceId: source.id,
      index: 0,
      status: "succeeded",
      result: { company: "A" },
    });
    // Duplicate replay of an already-decided index is idempotent.
    expect(
      store.foreach.decideItem({
        identity: id,
        sourceId: source.id,
        index: 0,
        status: "succeeded",
        result: {},
      }),
    ).toMatchObject({ duplicate: true });
    store.foreach.decideItem({
      identity: id,
      sourceId: source.id,
      index: 1,
      status: "succeeded",
      result: { company: "B" },
    });
    const items = store.foreach.listItems(source.id);
    expect(items).toHaveLength(2);
    expect(items[0]?.outputId).toBeTypeOf("string");
    const output = store.outputs.getById(items[0]?.outputId as string);
    expect(output?.json).toEqual({ company: "A" });
  });

  it("exposes metadata-only reads without hydrating snapshots or results", () => {
    const { store, runId } = harness();
    const id = foreachIdentity(store, runId);
    const { source } = store.foreach.createSource({
      identity: id,
      kind: "csv",
      items: [{ c: "A" }, { c: "B" }, { c: "C" }],
      maxItems: 10,
    });
    store.foreach.start({
      identity: id,
      total: 3,
      maxItems: 10,
      sourceId: source.id,
      sourceHash: source.sourceHash,
    });
    for (let index = 0; index < 3; index++) {
      store.foreach.decideItem({
        identity: id,
        sourceId: source.id,
        index,
        status: "succeeded",
        result: { c: String(index) },
      });
    }
    const meta = store.foreach.getSourceMeta(source.id);
    expect(meta).toMatchObject({
      kind: "csv",
      total: 3,
      maxItems: 10,
      sourceHash: source.sourceHash,
    });
    expect(store.foreach.getSourceMeta("missing")).toBeNull();
    const page = store.foreach.listItemRefs(source.id, { offset: 1, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ index: 1, status: "succeeded" });
    expect(page[0]?.outputId).toBeTypeOf("string");
    expect(() => store.foreach.listItemRefs(source.id, { limit: 101 })).toThrow();
  });
});
