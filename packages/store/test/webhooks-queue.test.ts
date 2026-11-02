import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@devchestra/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store, WEBHOOK_DELIVERY_RETENTION_MS } from "../src/index.js";
import { MIGRATIONS } from "../src/migrate.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-webhooks-store-"));
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

function setup(): { store: Store; clock: FakeClock; project: string; dir: string } {
  const dir = tempDir();
  const clock = new FakeClock(1_700_000_000_000);
  const store = open(join(dir, "devchestra.db"), clock);
  const project = join(dir, "repo");
  store.projects.ensure({ id: "p", name: "Project", path: project, kind: "git" });
  return { store, clock, project, dir };
}

const SNAPSHOT = { schemaVersion: 1, id: "wf", name: "wf", graph: { nodes: [], edges: [] } };

function runInput(workflowId = "wf") {
  return {
    projectId: "p",
    workflowId,
    workflowHash: "hash",
    snapshot: SNAPSHOT,
    snapshotRaw: JSON.stringify(SNAPSHOT),
  };
}

/** The error code a call throws, or undefined when it does not throw. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function armInput(revision: string) {
  return {
    armedRevision: revision,
    snapshot: SNAPSHOT,
    snapshotRaw: JSON.stringify(SNAPSHOT),
    bundle: { child: { ...SNAPSHOT, id: "child" } },
  };
}

describe("schema migration 0014", () => {
  it("is registered and applied with the webhook tables and queue index", () => {
    const { store, dir } = setup();
    expect(MIGRATIONS.at(-1)?.version).toBe(14);
    store.close();
    const db = new Database(join(dir, "devchestra.db"), { readonly: true });
    try {
      const version = db.pragma("user_version", { simple: true });
      expect(version).toBe(14);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(["workflow_triggers", "webhook_deliveries"]));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toContain("webhook_deliveries_fingerprint");
    } finally {
      db.close();
    }
  });

  it("restricts the database file and its WAL to the owner on POSIX", () => {
    if (process.platform === "win32") return;
    const { dir, store } = setup();
    const file = join(dir, "devchestra.db");
    // The WAL exists while the store is open, after configuration and migrations have written.
    const wal = statSync(`${file}-wal`).mode & 0o777;
    store.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(wal).toBe(0o600);
  });
});

describe("execution settings", () => {
  it("falls back to the documented defaults and round-trips valid values", () => {
    const { store } = setup();
    expect(store.executionSettings.get()).toEqual({ maxConcurrentRuns: 2, maxQueueDepth: 100 });
    expect(store.executionSettings.set({ maxConcurrentRuns: 4, maxQueueDepth: 25 })).toEqual({
      maxConcurrentRuns: 4,
      maxQueueDepth: 25,
    });
    expect(store.executionSettings.get()).toEqual({ maxConcurrentRuns: 4, maxQueueDepth: 25 });
  });

  it.each([
    { maxConcurrentRuns: 0, maxQueueDepth: 100 },
    { maxConcurrentRuns: 33, maxQueueDepth: 100 },
    { maxConcurrentRuns: 2.5, maxQueueDepth: 100 },
    { maxConcurrentRuns: 2, maxQueueDepth: 9 },
    { maxConcurrentRuns: 2, maxQueueDepth: 1001 },
  ])("rejects out-of-range values %j", (input) => {
    const { store } = setup();
    expect(() => store.executionSettings.set(input)).toThrow(/whole number/);
    expect(store.executionSettings.get()).toEqual({ maxConcurrentRuns: 2, maxQueueDepth: 100 });
  });

  it("uses defaults when the stored value is corrupt", () => {
    const { store, dir } = setup();
    store.close();
    const raw = new Database(join(dir, "devchestra.db"));
    raw
      .prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
      .run("settings:execution", "{not json");
    raw.close();
    const reopened = open(join(dir, "devchestra.db"), new FakeClock(1_700_000_000_000));
    expect(reopened.executionSettings.get()).toEqual({ maxConcurrentRuns: 2, maxQueueDepth: 100 });
  });
});

describe("webhook settings", () => {
  it("normalizes a public base URL and rejects unsafe forms", () => {
    const { store } = setup();
    expect(store.webhookSettings.get()).toEqual({ publicBaseUrl: null });
    expect(
      store.webhookSettings.set({ publicBaseUrl: "https://Hooks.example.com/devchestra/" }),
    ).toEqual({ publicBaseUrl: "https://hooks.example.com/devchestra" });
    for (const bad of [
      "ftp://example.com",
      "https://user:pw@example.com",
      "https://example.com/?token=1",
      "https://example.com/#x",
      "not a url",
    ]) {
      expect(() => store.webhookSettings.set({ publicBaseUrl: bad })).toThrow();
    }
  });
});

describe("workflow triggers", () => {
  it("arms with a frozen revision, then compares and swaps it", () => {
    const { store } = setup();
    store.webhooks.create({
      hookId: "whk_1",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "sec",
    });
    expect(store.webhooks.trigger("p", "wf")?.armed).toBe(false);

    store.webhooks.arm("whk_1", armInput("rev-1"));
    const armed = store.webhooks.runtimeFor("whk_1");
    expect(armed?.armed).toBe(true);
    expect(armed?.armedRevision).toBe("rev-1");
    expect(armed?.bundle).toEqual({ child: { ...SNAPSHOT, id: "child" } });

    expect(store.webhooks.replaceRevision("whk_1", "stale", armInput("rev-2"))).toBe(false);
    expect(store.webhooks.replaceRevision("whk_1", "rev-1", armInput("rev-2"))).toBe(true);
    expect(store.webhooks.runtimeFor("whk_1")?.armedRevision).toBe("rev-2");
  });

  it("refuses delivery checks once disarmed or when the revision moved", () => {
    const { store } = setup();
    store.webhooks.create({
      hookId: "whk_2",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "sec",
    });
    store.webhooks.arm("whk_2", armInput("rev-1"));
    expect(codeOf(() => store.webhooks.assertArmedRevision("whk_2", "rev-1"))).toBeUndefined();
    expect(codeOf(() => store.webhooks.assertArmedRevision("whk_2", "rev-0"))).toBe("E_CONFLICT");
    store.webhooks.disarm("whk_2");
    expect(codeOf(() => store.webhooks.assertArmedRevision("whk_2", "rev-1"))).toBe("E_CONFLICT");
  });

  it("disarms when its project is relinked or removed", () => {
    const { store, dir } = setup();
    for (const [hookId, workflowId] of [
      ["whk_r", "wf-r"],
      ["whk_x", "wf-x"],
    ] as const) {
      store.webhooks.create({
        hookId,
        projectId: "p",
        workflowId,
        signingSecret: "s",
      });
      store.webhooks.arm(hookId, armInput("rev"));
    }
    store.projects.relink({ projectId: "p", path: join(dir, "moved") });
    expect(store.webhooks.trigger("p", "wf-r")?.armed).toBe(false);
    expect(store.webhooks.trigger("p", "wf-x")?.armed).toBe(false);
  });

  it("records a refresh error and rotates credentials without touching the revision", () => {
    const { store } = setup();
    store.webhooks.create({
      hookId: "whk_3",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "old-secret",
    });
    store.webhooks.arm("whk_3", armInput("rev-1"));
    store.webhooks.setRefreshError("whk_3", "child invalid");
    expect(store.webhooks.trigger("p", "wf")?.refreshError).toBe("child invalid");
    store.webhooks.rotateCredentials("whk_3", "new-secret");
    const runtime = store.webhooks.runtimeFor("whk_3");
    expect(runtime?.signingSecret).toBe("new-secret");
    expect(runtime?.armedRevision).toBe("rev-1");
    expect(store.webhooks.signingSecrets()).toContain("new-secret");
  });
});

describe("webhook delivery claims", () => {
  function armed(store: Store): void {
    store.webhooks.create({
      hookId: "whk_d",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "s",
    });
    store.webhooks.arm("whk_d", armInput("rev-1"));
  }

  it("claims a delivery once and reports the bound run on a repeat", () => {
    const { store } = setup();
    armed(store);
    const first = store.webhooks.claimDelivery({
      hookId: "whk_d",
      deliveryId: "d-1",
      fingerprint: "fp",
    });
    expect(first).toEqual({ kind: "claimed", key: "d-1" });
    const run = store.runs.enqueue(runInput());
    store.webhooks.bindDelivery("whk_d", "d-1", run.runId);

    expect(
      store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "d-1", fingerprint: "fp" }),
    ).toEqual({ kind: "duplicate", runId: run.runId });
  });

  it("rejects a reused delivery ID with a different payload", () => {
    const { store } = setup();
    armed(store);
    store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "d-2", fingerprint: "fp-a" });
    expect(
      codeOf(() =>
        store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "d-2", fingerprint: "fp-b" }),
      ),
    ).toBe("E_CONFLICT");
  });

  it("reclaims an expired claim and prunes expired rows in bounded batches", () => {
    const { store, clock } = setup();
    armed(store);
    store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "old", fingerprint: "a" });
    store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "older", fingerprint: "b" });
    clock.advance(WEBHOOK_DELIVERY_RETENTION_MS + 1);

    expect(store.webhooks.pruneExpiredDeliveries(1)).toBe(1);
    expect(store.webhooks.pruneExpiredDeliveries(10)).toBe(1);
    expect(
      store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "old", fingerprint: "other" }),
    ).toEqual({ kind: "claimed", key: "old" });
  });

  it("keeps a claim that is still inside the retention window", () => {
    const { store, clock } = setup();
    armed(store);
    store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "recent", fingerprint: "a" });
    const run = store.runs.enqueue(runInput());
    store.webhooks.bindDelivery("whk_d", "recent", run.runId);
    clock.advance(WEBHOOK_DELIVERY_RETENTION_MS - 1000);
    expect(store.webhooks.pruneExpiredDeliveries(10)).toBe(0);
    expect(
      store.webhooks.claimDelivery({ hookId: "whk_d", deliveryId: "recent", fingerprint: "a" }),
    ).toEqual({ kind: "duplicate", runId: run.runId });
  });
});

describe("bounded retention of delivery claims", () => {
  it("sweeps expired claims as new deliveries arrive, so the table does not grow forever", () => {
    const { store, clock } = setup();
    store.webhooks.create({
      hookId: "whk_s",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "s",
    });
    store.webhooks.arm("whk_s", armInput("rev-1"));
    for (const id of ["old-1", "old-2", "old-3"]) {
      store.webhooks.claimDelivery({ hookId: "whk_s", deliveryId: id, fingerprint: id });
    }
    clock.advance(WEBHOOK_DELIVERY_RETENTION_MS + 1);

    store.webhooks.claimDelivery({ hookId: "whk_s", deliveryId: "fresh", fingerprint: "f" });
    expect(store.webhooks.pruneExpiredDeliveries(10)).toBe(0);
  });
});

describe("delivery claims and the disarm cutoff", () => {
  it("rolls a claim back with its transaction when the armed check refuses the delivery", () => {
    const { store } = setup();
    store.webhooks.create({
      hookId: "whk_t",
      projectId: "p",
      workflowId: "wf",
      signingSecret: "s",
    });
    store.webhooks.arm("whk_t", armInput("rev-1"));
    store.webhooks.disarm("whk_t");

    const refused = codeOf(() =>
      store.tx(() => {
        store.webhooks.claimDelivery({ hookId: "whk_t", deliveryId: "late", fingerprint: "fp" });
        store.webhooks.assertArmedRevision("whk_t", "rev-1");
      }),
    );
    expect(refused).toBe("E_CONFLICT");

    store.webhooks.arm("whk_t", armInput("rev-1"));
    expect(
      store.webhooks.claimDelivery({ hookId: "whk_t", deliveryId: "late", fingerprint: "fp" }),
    ).toEqual({ kind: "claimed", key: "late" });
  });
});

describe("run queue", () => {
  it("enqueues runs as queued without a run.started event, oldest first", () => {
    const { store, clock } = setup();
    const first = store.runs.enqueue(runInput());
    clock.advance(10);
    const second = store.runs.enqueue(runInput());

    expect(store.runs.get(first.runId)?.status).toBe("queued");
    expect(store.view.get(first.runId).status).toBe("queued");
    const ids = store.runs.listQueued().map((run) => run.id);
    expect(ids).toEqual([first.runId, second.runId]);
    const types = store.events.list(first.runId).map((event) => event.type);
    expect(types).toContain("run.created");
    expect(types).not.toContain("run.started");
  });

  it("starts immediately through create, as child runs do", () => {
    const { store } = setup();
    const child = store.runs.create(runInput("child"));
    expect(store.runs.get(child.runId)?.status).toBe("running");
    expect(store.runs.listQueued().map((run) => run.id)).not.toContain(child.runId);
  });

  it("rejects an enqueue with E_QUEUE_FULL once the queue holds maxQueueDepth runs", () => {
    const { store } = setup();
    store.executionSettings.set({ maxConcurrentRuns: 2, maxQueueDepth: 10 });
    for (let i = 0; i < 10; i++) store.runs.enqueue(runInput());
    expect(codeOf(() => store.runs.enqueue(runInput()))).toBe("E_QUEUE_FULL");
    expect(store.runs.listQueued()).toHaveLength(10);
  });

  it("a duplicate idempotency key returns the original queued run before the depth check", () => {
    const { store } = setup();
    store.executionSettings.set({ maxConcurrentRuns: 2, maxQueueDepth: 10 });
    const idempotency = { key: "k-1", fingerprint: "fp" };
    const original = store.runs.enqueue({ ...runInput(), idempotency });
    for (let i = 0; i < 9; i++) store.runs.enqueue(runInput());
    const repeat = store.runs.enqueue({ ...runInput(), idempotency });
    expect(repeat).toEqual({
      runId: original.runId,
      runNumber: original.runNumber,
      duplicate: true,
    });
  });
});
