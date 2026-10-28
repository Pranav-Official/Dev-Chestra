import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeIdGen, type Path, type RunId } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-cleanup-"));
  const file = join(dir, "db.sqlite");
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new FakeIdGen("cleanup");
  let store = openStore({ file, clock, idGen: ids });
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = { id: "p1", name: "One", path: join(dir, "repository"), kind: "folder" as const };
  store.projects.ensure(project);
  const create = (workflowId = "old", projectId = "p1") =>
    store.runs.create({
      projectId,
      workflowId,
      workflowHash: "hash",
      snapshot: { name: workflowId },
      snapshotRaw: "{}",
    }).runId;
  const finish = (runId: RunId) =>
    store.events.append(runId, [
      { runId, path: "" as Path, type: "run.cancelled", actor: "user", payload: {} },
    ]);
  return {
    get store() {
      return store;
    },
    project,
    create,
    finish,
    reopen() {
      store.close();
      store = openStore({ file, clock, idGen: ids });
    },
  };
}

describe("workspace cleanup", () => {
  it("removes only idle projects, persists hiding, and restores the same history and numbering", () => {
    const h = harness();
    const id = h.create();
    expect(() => h.store.projects.remove("p1")).toThrow(/active/);
    expect(() => h.store.runs.setArchived(id, true)).toThrow(/completed/);
    expect(h.store.projects.list()).toHaveLength(1);
    h.finish(id);
    h.store.projects.remove("p1");
    h.reopen();
    expect(h.store.projects.list()).toEqual([]);
    expect(h.store.runs.list().items).toEqual([]);
    expect(h.store.runs.get(id)?.status).toBe("cancelled");
    expect(h.store.view.snapshot(id).run.id).toBe(id);
    expect(() => h.create()).toThrow();
    h.store.projects.ensure(h.project);
    expect(h.store.projects.list()).toHaveLength(1);
    expect(h.store.runs.list().items[0]?.id).toBe(id);
    expect(h.store.runs.get(h.create())?.runNumber).toBe(2);
  });

  it("keeps paused runs visible and accepts rejected terminal runs", () => {
    const h = harness();
    const paused = h.create();
    h.store.events.append(paused, [
      {
        runId: paused,
        path: "" as Path,
        type: "run.paused",
        actor: "system",
        payload: { reason: "shutdown" },
      },
    ]);
    expect(() => h.store.projects.remove("p1")).toThrow(/active/);
    expect(() => h.store.runs.setArchived(paused, true)).toThrow(/completed/);
    const rejected = h.create();
    h.store.events.append(rejected, [
      {
        runId: rejected,
        path: "" as Path,
        type: "run.completed",
        actor: "engine",
        payload: { status: "rejected" },
      },
    ]);
    h.store.runs.archiveWorkflow("p1", "old");
    expect(h.store.runs.list().items.map((r) => r.id)).toEqual([paused]);
    expect(h.store.runs.list({ archived: true }).items.map((r) => r.id)).toEqual([rejected]);
  });

  it("archives only completed runs, preserves status/events, and restores after restart", () => {
    const h = harness();
    const completed = h.create();
    h.finish(completed);
    const active = h.create();
    const other = h.create("other");
    h.finish(other);
    const before = h.store.events.list(completed);
    h.store.runs.archiveWorkflow("p1", "old");
    h.reopen();
    expect(h.store.runs.list().items.map((r) => r.id)).toEqual([other, active]);
    expect(h.store.runs.list({ archived: true }).items.map((r) => r.id)).toEqual([completed]);
    expect(h.store.runs.get(completed)).toMatchObject({
      status: "cancelled",
      archivedAt: expect.any(Number),
    });
    expect(h.store.events.list(completed)).toEqual(before);
    expect(() => h.store.runs.setArchived(active, true)).toThrow(/completed/);
    h.store.runs.setArchived(completed, false);
    expect(h.store.runs.list({ archived: true }).items).toEqual([]);
    expect(h.store.runs.list().items).toHaveLength(3);
  });

  it("paginates archived history without duplicates and rejects cross-filter cursors", () => {
    const h = harness();
    for (let i = 0; i < 7; i++) {
      const id = h.create();
      h.finish(id);
      h.store.runs.setArchived(id, true);
    }
    const first = h.store.runs.list({ archived: true, limit: 2 });
    expect(() => h.store.runs.list({ cursor: first.nextCursor ?? "", limit: 2 })).toThrow(/query/);
    const ids = first.items.map((r) => r.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = h.store.runs.list({ archived: true, cursor, limit: 2 });
      ids.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it("returns three visible runs per historical workflow despite 100+ newer runs elsewhere", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.create("old");
    h.create("other");
    h.store.projects.ensure({ ...h.project, id: "p2", path: "/another-project" });
    for (let i = 0; i < 105; i++) h.create("busy", "p2");
    const summaries = h.store.runs.workflowSummaries("p1");
    expect(summaries.map((r) => r.runNumber)).toEqual([6, 5, 4, 7]);
    const newest = summaries[0];
    if (!newest) throw new Error("Expected a summary");
    h.finish(newest.id);
    h.store.runs.setArchived(newest.id, true);
    expect(h.store.runs.workflowSummaries("p1").map((r) => r.runNumber)).toEqual([5, 4, 3, 7]);
  });
});
