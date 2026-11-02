import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@devchestra/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, POLL_DEDUPE_RETENTION_MS, type Store } from "../src/index.js";
import { MIGRATIONS } from "../src/migrate.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-poll-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function open(file: string, clock: FakeClock): Store {
  const store = openStore({ file, clock });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

function setup(): { store: Store; clock: FakeClock; dir: string } {
  const dir = tempDir();
  const clock = new FakeClock(1_700_000_000_000);
  const store = open(join(dir, "devchestra.db"), clock);
  store.projects.ensure({ id: "p", name: "Project", path: join(dir, "repo"), kind: "git" });
  return { store, clock, dir };
}

const SNAPSHOT = { schemaVersion: 1, id: "wf", name: "wf", graph: { nodes: [], edges: [] } };

function armInput(revision: string, intervalSeconds = 60) {
  return {
    armedRevision: revision,
    snapshot: SNAPSHOT,
    snapshotRaw: JSON.stringify(SNAPSHOT),
    bundle: { child: { ...SNAPSHOT, id: "child" } },
    intervalSeconds,
  };
}

function create(store: Store, pollerId = "pol_1", workflowId = "wf"): void {
  store.pollTriggers.create({ pollerId, projectId: "p", workflowId });
}

describe("schema migration 0014", () => {
  it("is registered and applied with the poller and dedupe tables", () => {
    const { store, dir } = setup();
    expect(MIGRATIONS.at(-1)?.version).toBe(14);
    store.close();
    const db = new Database(join(dir, "devchestra.db"), { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(14);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(["workflow_pollers", "poll_dedupe_claims"]));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining(["poll_dedupe_claims_created", "workflow_pollers_due"]),
      );
    } finally {
      db.close();
    }
  });
});

describe("poll triggers", () => {
  it("creates off, arms with interval and first due date, then compares and swaps", () => {
    const { store, clock } = setup();
    create(store);
    expect(store.pollTriggers.trigger("p", "wf")).toMatchObject({
      armed: false,
      intervalSeconds: null,
      nextDueAt: null,
    });

    store.pollTriggers.arm("pol_1", armInput("rev-1", 30));
    const armed = store.pollTriggers.runtimeFor("pol_1");
    expect(armed).toMatchObject({
      armed: true,
      intervalSeconds: 30,
      armedRevision: "rev-1",
      nextDueAt: clock.now() + 30_000,
      consecutiveFailures: 0,
    });
    expect(armed?.bundle).toEqual({ child: { ...SNAPSHOT, id: "child" } });

    expect(store.pollTriggers.replaceRevision("pol_1", "stale", armInput("rev-2"))).toBe(false);
    expect(store.pollTriggers.replaceRevision("pol_1", "rev-1", armInput("rev-2"))).toBe(true);
    expect(store.pollTriggers.runtimeFor("pol_1")?.armedRevision).toBe("rev-2");
    // The schedule survives a revision swap.
    expect(store.pollTriggers.runtimeFor("pol_1")?.nextDueAt).toBe(clock.now() + 30_000);
  });

  it("disarms idempotently and keeps the interval for the next arm", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev-1", 120));
    store.pollTriggers.disarm("pol_1");
    store.pollTriggers.disarm("pol_1");
    expect(store.pollTriggers.trigger("p", "wf")).toMatchObject({
      armed: false,
      intervalSeconds: 120,
      nextDueAt: null,
    });
  });

  it("removes the poller row", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev-1"));
    store.pollTriggers.remove("pol_1");
    expect(store.pollTriggers.trigger("p", "wf")).toBeNull();
  });

  it("records a refresh error", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev-1"));
    store.pollTriggers.setRefreshError("pol_1", "child invalid");
    expect(store.pollTriggers.trigger("p", "wf")?.refreshError).toBe("child invalid");
    store.pollTriggers.setRefreshError("pol_1", null);
    expect(store.pollTriggers.trigger("p", "wf")?.refreshError).toBeNull();
  });

  it("disarms when its project is relinked or removed", () => {
    const { store, dir } = setup();
    create(store, "pol_a", "wf-a");
    create(store, "pol_b", "wf-b");
    store.pollTriggers.arm("pol_a", armInput("rev"));
    store.pollTriggers.arm("pol_b", armInput("rev"));
    store.projects.relink({ projectId: "p", path: join(dir, "moved") });
    expect(store.pollTriggers.trigger("p", "wf-a")?.armed).toBe(false);
    expect(store.pollTriggers.trigger("p", "wf-b")?.armed).toBe(false);

    store.pollTriggers.arm("pol_a", armInput("rev"));
    store.projects.remove("p");
    // Removal is a soft delete: the poller row stays, but disarmed.
    expect(store.pollTriggers.trigger("p", "wf-a")?.armed).toBe(false);
  });
});

describe("listDue", () => {
  it("returns armed pollers whose probe is due, earliest first", () => {
    const { store, clock } = setup();
    create(store, "pol_soon", "wf-soon");
    create(store, "pol_later", "wf-later");
    create(store, "pol_off", "wf-off");
    store.pollTriggers.arm("pol_soon", armInput("rev", 10));
    store.pollTriggers.arm("pol_later", armInput("rev", 60));
    store.pollTriggers.arm("pol_off", armInput("rev", 10));
    store.pollTriggers.disarm("pol_off");

    expect(store.pollTriggers.listDue(clock.now())).toEqual([]);
    clock.advance(10_000);
    expect(store.pollTriggers.listDue(clock.now()).map((poller) => poller.pollerId)).toEqual([
      "pol_soon",
    ]);
    clock.advance(50_000);
    expect(store.pollTriggers.listDue(clock.now()).map((poller) => poller.pollerId)).toEqual([
      "pol_soon",
      "pol_later",
    ]);
  });
});

describe("recordTick", () => {
  it("resets the failure streak on success and moves the next due date", () => {
    const { store, clock } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev", 30));
    store.pollTriggers.recordTick("pol_1", { outcome: "failed", error: "boom" }, 5);
    const ticked = store.pollTriggers.recordTick(
      "pol_1",
      { outcome: "triggered", runId: "run-1" },
      5,
    );
    expect(ticked).toMatchObject({
      lastOutcome: "triggered",
      lastRunId: "run-1",
      consecutiveFailures: 0,
      lastError: null,
      nextDueAt: clock.now() + 30_000,
      lastTickAt: clock.now(),
      armed: true,
    });
  });

  it("keeps the last run on nothing and duplicate ticks", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.recordTick("pol_1", { outcome: "triggered", runId: "run-1" }, 5);
    const nothing = store.pollTriggers.recordTick("pol_1", { outcome: "nothing" }, 5);
    expect(nothing.lastRunId).toBe("run-1");
    expect(nothing.lastOutcome).toBe("nothing");
    const duplicate = store.pollTriggers.recordTick("pol_1", { outcome: "duplicate" }, 5);
    expect(duplicate.lastRunId).toBe("run-1");
    expect(duplicate.consecutiveFailures).toBe(0);
  });

  it("leaves the streak alone on skipped ticks", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.recordTick("pol_1", { outcome: "failed", error: "boom" }, 5);
    const skipped = store.pollTriggers.recordTick("pol_1", { outcome: "skipped" }, 5);
    expect(skipped).toMatchObject({
      lastOutcome: "skipped",
      consecutiveFailures: 1,
      lastError: "boom",
      armed: true,
    });
  });

  it("counts failures and auto-disarms at the limit, keeping the reason", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    for (let i = 1; i <= 4; i++) {
      const ticked = store.pollTriggers.recordTick(
        "pol_1",
        { outcome: "failed", error: `e${i}` },
        5,
      );
      expect(ticked.armed).toBe(true);
      expect(ticked.consecutiveFailures).toBe(i);
    }
    const last = store.pollTriggers.recordTick("pol_1", { outcome: "failed", error: "e5" }, 5);
    expect(last).toMatchObject({
      armed: false,
      consecutiveFailures: 5,
      lastError: "e5",
      lastOutcome: "failed",
      nextDueAt: null,
    });
  });
});

describe("poll dedupe claims", () => {
  it("claims a key once and reports the bound run on a repeat", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    expect(store.pollTriggers.claimDedupe("pol_1", "k-1")).toEqual({ kind: "claimed" });
    store.pollTriggers.bindDedupe("pol_1", "k-1", "run-1");
    expect(store.pollTriggers.claimDedupe("pol_1", "k-1")).toEqual({
      kind: "duplicate",
      runId: "run-1",
    });
    expect(store.pollTriggers.dedupeRunFor("pol_1", "k-1")).toBe("run-1");
    expect(store.pollTriggers.dedupeRunFor("pol_1", "missing")).toBeNull();
  });

  it("lets an unbound claim be claimed again after a crashed tick", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    expect(store.pollTriggers.claimDedupe("pol_1", "k-1")).toEqual({ kind: "claimed" });
    expect(store.pollTriggers.claimDedupe("pol_1", "k-1")).toEqual({ kind: "claimed" });
    expect(store.pollTriggers.dedupeRunFor("pol_1", "k-1")).toBeNull();
  });

  it("scopes keys per poller", () => {
    const { store } = setup();
    create(store, "pol_1", "wf-1");
    create(store, "pol_2", "wf-2");
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.arm("pol_2", armInput("rev"));
    store.pollTriggers.claimDedupe("pol_1", "same");
    store.pollTriggers.bindDedupe("pol_1", "same", "run-1");
    expect(store.pollTriggers.claimDedupe("pol_2", "same")).toEqual({ kind: "claimed" });
  });

  it("reclaims an expired claim and prunes expired rows in bounded batches", () => {
    const { store, clock } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.claimDedupe("pol_1", "old-1");
    store.pollTriggers.bindDedupe("pol_1", "old-1", "run-1");
    store.pollTriggers.claimDedupe("pol_1", "old-2");
    clock.advance(POLL_DEDUPE_RETENTION_MS + 1);

    expect(store.pollTriggers.pruneExpiredDedupe(1)).toBe(1);
    expect(store.pollTriggers.pruneExpiredDedupe(10)).toBe(1);
    expect(store.pollTriggers.claimDedupe("pol_1", "old-1")).toEqual({ kind: "claimed" });
    expect(store.pollTriggers.dedupeRunFor("pol_1", "old-1")).toBeNull();
  });

  it("keeps a claim that is still inside the retention window", () => {
    const { store, clock } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.claimDedupe("pol_1", "recent");
    store.pollTriggers.bindDedupe("pol_1", "recent", "run-1");
    clock.advance(POLL_DEDUPE_RETENTION_MS - 1000);
    expect(store.pollTriggers.pruneExpiredDedupe(10)).toBe(0);
    expect(store.pollTriggers.claimDedupe("pol_1", "recent")).toEqual({
      kind: "duplicate",
      runId: "run-1",
    });
  });

  it("drops claims with the poller row", () => {
    const { store } = setup();
    create(store);
    store.pollTriggers.arm("pol_1", armInput("rev"));
    store.pollTriggers.claimDedupe("pol_1", "k-1");
    store.pollTriggers.bindDedupe("pol_1", "k-1", "run-1");
    store.pollTriggers.remove("pol_1");
    create(store, "pol_1");
    store.pollTriggers.arm("pol_1", armInput("rev"));
    expect(store.pollTriggers.claimDedupe("pol_1", "k-1")).toEqual({ kind: "claimed" });
  });
});
