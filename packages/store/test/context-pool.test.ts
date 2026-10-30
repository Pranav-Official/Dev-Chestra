import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeIdGen, type RunId } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(): { store: Store; runId: RunId } {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-context-pool-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "ctx",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
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

describe("execution context pool", () => {
  it("upserts, gets and lists entries in key order", () => {
    const { store, runId } = harness();
    expect(store.contextPool.list(runId)).toEqual([]);
    store.contextPool.upsert({ runId, key: "b", value: "second", updatedByPath: "a" });
    store.contextPool.upsert({ runId, key: "a", value: "first", updatedByPath: "a" });
    expect(store.contextPool.get(runId, "a")?.value).toBe("first");
    expect(store.contextPool.list(runId).map((entry) => entry.key)).toEqual(["a", "b"]);
    const updated = store.contextPool.upsert({
      runId,
      key: "a",
      value: "edited",
      updatedByPath: "c",
    });
    expect(updated.version).toBe(2);
    expect(updated.updatedByPath).toBe("c");
    expect(store.contextPool.get(runId, "missing")).toBeNull();
  });

  it("appends with a newline and deletes tombstone-free", () => {
    const { store, runId } = harness();
    store.contextPool.upsert({ runId, key: "log", value: "one", updatedByPath: "a" });
    store.contextPool.upsert({
      runId,
      key: "log",
      value: "two",
      updatedByPath: "b",
      mode: "append",
    });
    expect(store.contextPool.get(runId, "log")?.value).toBe("one\ntwo");
    const deleted = store.contextPool.upsert({
      runId,
      key: "log",
      updatedByPath: "b",
      mode: "delete",
    });
    expect(deleted.version).toBe(3);
    expect(store.contextPool.get(runId, "log")).toBeNull();
    expect(store.contextPool.list(runId)).toEqual([]);
  });

  it("rejects bad keys, oversized values and unknown modes", () => {
    const { store, runId } = harness();
    for (const key of ["", "-bad", "has space", "x".repeat(65)]) {
      expect(() =>
        store.contextPool.upsert({ runId, key, value: "v", updatedByPath: "a" }),
      ).toThrow(/key/i);
    }
    expect(() =>
      store.contextPool.upsert({ runId, key: "big", value: "x".repeat(5000), updatedByPath: "a" }),
    ).toThrow(/4 KiB/);
    store.contextPool.upsert({ runId, key: "ok", value: "v", updatedByPath: "a" });
    expect(() =>
      store.contextPool.upsert({
        runId,
        key: "bad-mode",
        value: "v",
        updatedByPath: "a",
        mode: "x" as never,
      }),
    ).toThrow();
  });

  it("isolates entries per run", () => {
    const { store, runId } = harness();
    const other = store.runs.create({
      projectId: "proj",
      workflowId: "ctx",
      workflowHash: "hash",
      snapshot: { nodes: [] },
      snapshotRaw: "{}",
    });
    store.contextPool.upsert({ runId, key: "k", value: "one", updatedByPath: "a" });
    expect(store.contextPool.get(other.runId, "k")).toBeNull();
    expect(store.contextPool.list(other.runId)).toEqual([]);
  });
});
