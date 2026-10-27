import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeIdGen, type Path, RelayError, type RunId } from "@relay/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCursor, queryFingerprint } from "../src/cursor.js";
import { openStore, type Store } from "../src/index.js";

interface Harness {
  dir: string;
  file: string;
  clock: FakeClock;
  store: Store;
  close(): void;
  reopen(): Store;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(clockStart = 1_700_000_000_000): Harness {
  const dir = mkdtempSync(join(tmpdir(), "relay-store-read-"));
  const file = join(dir, "relay.db");
  const clock = new FakeClock(clockStart);
  const store = openStore({ file, clock, idGen: new FakeIdGen("rp") });
  store.projects.ensure({ id: "p1", name: "One", path: join(dir, "one"), kind: "folder" });
  store.projects.ensure({ id: "p2", name: "Two", path: join(dir, "two"), kind: "folder" });
  const h: Harness = {
    dir,
    file,
    clock,
    store,
    close() {
      store.close();
    },
    reopen() {
      return openStore({ file, clock, idGen: new FakeIdGen("rr") });
    },
  };
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

function createRun(
  h: Harness,
  options: {
    projectId?: string;
    workflowId?: string;
    idempotency?: { key: string; fingerprint: string; scope?: string };
  } = {},
) {
  return h.store.runs.create({
    projectId: options.projectId ?? "p1",
    workflowId: options.workflowId ?? "w1",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    ...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
  });
}

function append(
  h: Harness,
  runId: RunId,
  path: string,
  type: string,
  payload: Record<string, unknown> = {},
): number {
  const [event] = h.store.events.append(runId, [
    {
      runId,
      path: path as Path,
      type,
      actor: "system",
      payload,
    } as never,
  ]);
  return event?.id ?? -1;
}

function expectRelayError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected RelayError ${code}`);
}

function walkRunPages(
  h: Harness,
  filters: Parameters<Store["runs"]["list"]>[0],
  limit: number,
): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = h.store.runs.list({
      ...filters,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
}

function walkEventPages(h: Harness, runId: RunId, limit: number): number[] {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = h.store.events.page(runId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
}

describe("projects registration and relink", () => {
  it("lists, gets and finds registration metadata", () => {
    const h = harness();
    const projects = h.store.projects.list();
    expect(projects.map((project) => project.id)).toEqual(["p1", "p2"]);
    expect(h.store.projects.get("p1")).toMatchObject({
      id: "p1",
      name: "One",
      kind: "folder",
      missing: false,
      nextRunNumber: 1,
    });
    expect(h.store.projects.get("missing")).toBeNull();
    expect(h.store.projects.findByPath(join(h.dir, "one"))?.id).toBe("p1");
    expect(h.store.projects.findByPath(join(h.dir, "nope"))).toBeNull();
  });

  it("relinks without changing id, run association or workspace provenance", () => {
    const h = harness();
    const run = createRun(h);
    const path = "work" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "work", kind: "agent" });
    const identity = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.executions.recordWorkspaceFinalized({ identity, dir: "/ws/original" });

    const before = h.store.projects.get("p1");
    const moved = join(h.dir, "moved");
    const relinked = h.store.projects.relink({
      projectId: "p1",
      path: moved,
      name: "Moved",
      kind: "git",
      missing: false,
    });
    expect(relinked).toEqual({
      id: "p1",
      name: "Moved",
      path: moved,
      kind: "git",
      addedAt: before?.addedAt,
      nextRunNumber: before?.nextRunNumber,
      missing: false,
    });
    expect(h.store.projects.list()).toHaveLength(2);
    expect(h.store.projects.findByPath(join(h.dir, "one"))).toBeNull();
    expect(h.store.projects.findByPath(moved)?.id).toBe("p1");

    const record = h.store.runs.get(run.runId);
    expect(record?.project).toMatchObject({ id: "p1", name: "Moved", path: moved });
    expect(h.store.executions.get(run.runId, path)?.workspaceDir).toBe("/ws/original");
  });

  it("detects duplicate paths, keeps next_run_number and rejects unknown projects", () => {
    const h = harness();
    const before = h.store.projects.get("p1");
    createRun(h);

    expectRelayError(
      () =>
        h.store.projects.relink({
          projectId: "p1",
          path: join(h.dir, "two"),
        }),
      "E_CONFLICT",
    );
    expectRelayError(
      () => h.store.projects.relink({ projectId: "nope", path: join(h.dir, "x") }),
      "E_NOT_FOUND",
    );

    const same = h.store.projects.relink({ projectId: "p1", path: join(h.dir, "one") });
    expect(same.nextRunNumber).toBe(2);
    expect(same.addedAt).toBe(before?.addedAt);
    expect(same.missing).toBe(false);

    const missing = h.store.projects.relink({
      projectId: "p1",
      path: join(h.dir, "one"),
      missing: true,
    });
    expect(missing.missing).toBe(true);
  });
});

describe("run list keyset pagination", () => {
  it("pages active and terminal runs stably across tied timestamps", () => {
    const h = harness();
    const created = [
      createRun(h, { workflowId: "w1" }),
      createRun(h, { workflowId: "w1" }),
      createRun(h, { workflowId: "w2" }),
      createRun(h, { projectId: "p2", workflowId: "w1" }),
      createRun(h, { workflowId: "w1" }),
      createRun(h, { workflowId: "w2" }),
      createRun(h, { workflowId: "w1" }),
    ];
    const cancelOne = created[1];
    const cancelTwo = created[4];
    if (!cancelOne || !cancelTwo) throw new Error("missing runs to cancel");
    append(h, cancelOne.runId, "", "run.cancelled", { by: "test" });
    append(h, cancelTwo.runId, "", "run.cancelled", { by: "test" });

    const all = h.store.runs.list({ limit: 500 });
    expect(all.items).toHaveLength(7);
    expect(all.nextCursor).toBeNull();
    expect(h.store.runs.list({ limit: 2 }).items[0]?.createdAt).toBe(
      h.store.runs.list({ limit: 2 }).items[1]?.createdAt,
    );

    expect(new Set(walkRunPages(h, {}, 2)).size).toBe(7);
    expect(walkRunPages(h, {}, 2)).toEqual(all.items.map((item) => item.id));

    expect(h.store.runs.list({ projectId: "p1" }).items).toHaveLength(6);
    expect(h.store.runs.list({ projectId: "p2" }).items).toHaveLength(1);
    expect(h.store.runs.list({ workflowId: "w2" }).items).toHaveLength(2);
    expect(h.store.runs.list({ status: "cancelled" }).items.map((item) => item.id)).toHaveLength(2);
    expect(
      h.store.runs.list({ status: ["cancelled", "running"] }).items.map((item) => item.id),
    ).toHaveLength(7);
    expect(h.store.runs.list({ status: ["succeeded"] }).items).toHaveLength(0);
  });

  it("rejects foreign, malformed, stale and future cursors", () => {
    const h = harness();
    createRun(h);
    createRun(h);
    createRun(h, { projectId: "p2" });
    const page = h.store.runs.list({ projectId: "p1", limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    const cursor = page.nextCursor ?? "";

    expectRelayError(
      () => h.store.runs.list({ projectId: "p2", limit: 1, cursor }),
      "E_VALIDATION",
    );
    expectRelayError(() => h.store.runs.list({ cursor: "not-a-cursor" }), "E_VALIDATION");

    const fingerprint = queryFingerprint({
      kind: "runs",
      projectId: null,
      workflowId: null,
      status: null,
    });
    expectRelayError(
      () =>
        h.store.runs.list({
          cursor: encodeCursor({
            v: 1,
            k: "runs",
            q: fingerprint,
            c: 0,
            i: "missing-run",
          }),
        }),
      "E_CONFLICT",
    );
    expectRelayError(
      () =>
        h.store.runs.list({
          cursor: encodeCursor({
            v: 1,
            k: "runs",
            q: fingerprint,
            c: Number.MAX_SAFE_INTEGER - 1,
            i: "future-run",
          }),
        }),
      "E_CONFLICT",
    );
  });
});

describe("event paging and replay", () => {
  it("walks run-scoped pages without gaps or duplicates", () => {
    const h = harness();
    const run = createRun(h);
    for (let index = 0; index < 12; index += 1) {
      append(h, run.runId, index % 2 === 0 ? "even" : "odd", "error.logged", {
        code: "E_INTERNAL",
        message: `event ${index}`,
      });
    }
    const direct = h.store.events.list(run.runId).map((event) => event.id);
    expect(walkEventPages(h, run.runId, 5)).toEqual(direct);

    const typed = h.store.events.page(run.runId, {
      types: ["error.logged"],
      limit: 500,
    });
    expect(typed.items).toHaveLength(12);
    expect(typed.watermark).toBe(direct[direct.length - 1]);
    expect(typed.nextAfter).toBe(direct[direct.length - 1]);
    expect(typed.nextCursor).toBeNull();

    const many = createRun(h, { workflowId: "many" });
    h.store.events.append(
      many.runId,
      Array.from({ length: 505 }, (_, index) => ({
        runId: many.runId,
        path: "" as Path,
        type: "error.logged",
        actor: "system",
        payload: { code: "E_INTERNAL", message: `bulk ${index}` },
      })) as never,
    );
    const capped = h.store.events.page(many.runId, { limit: 9999 });
    expect(capped.items).toHaveLength(500);
    expect(capped.nextCursor).not.toBeNull();
    expect(h.store.events.page(many.runId, { after: 0, limit: 1 }).items).toHaveLength(1);
  });

  it("treats pathPrefix literally for % and _", () => {
    const h = harness();
    const run = createRun(h);
    append(h, run.runId, "a%b", "error.logged", { code: "E_INTERNAL", message: "percent" });
    append(h, run.runId, "a_b", "error.logged", { code: "E_INTERNAL", message: "underscore" });
    append(h, run.runId, "aAb", "error.logged", { code: "E_INTERNAL", message: "plain" });

    expect(
      h.store.events
        .page(run.runId, { pathPrefix: "a%", limit: 100 })
        .items.map((event) => event.path),
    ).toEqual(["a%b"]);
    expect(
      h.store.events
        .page(run.runId, { pathPrefix: "a_", limit: 100 })
        .items.map((event) => event.path),
    ).toEqual(["a_b"]);
    expect(
      h.store.events
        .page(run.runId, { pathPrefix: "a", limit: 100 })
        .items.map((event) => event.path),
    ).toEqual(["a%b", "a_b", "aAb"]);
  });

  it("pins a page to upTo and rejects foreign, stale and future positions", () => {
    const h = harness();
    const run = createRun(h);
    append(h, run.runId, "", "error.logged", { code: "E_INTERNAL", message: "one" });
    const snapshot = h.store.view.snapshot(run.runId);
    append(h, run.runId, "", "error.logged", { code: "E_INTERNAL", message: "two" });

    const pinned = h.store.events.page(run.runId, { upTo: snapshot.watermark, limit: 100 });
    expect(pinned.items.map((event) => event.id)).not.toContain(
      Math.max(...h.store.events.list(run.runId).map((event) => event.id)),
    );
    expect(pinned.watermark).toBeGreaterThan(snapshot.watermark);

    const other = createRun(h, { projectId: "p2" });
    append(h, other.runId, "", "error.logged", { code: "E_INTERNAL", message: "other" });
    append(h, run.runId, "", "error.logged", { code: "E_INTERNAL", message: "three" });
    const foreignId = h.store.events.list(other.runId)[0]?.id;
    if (foreignId === undefined) throw new Error("missing foreign event");

    expectRelayError(
      () => h.store.events.page(run.runId, { after: foreignId, limit: 10 }),
      "E_CONFLICT",
    );
    expectRelayError(
      () =>
        h.store.events.page(run.runId, {
          after: (h.store.events.page(run.runId, { limit: 1 }).watermark ?? 0) + 100,
        }),
      "E_CONFLICT",
    );
    expectRelayError(
      () =>
        h.store.events.page(other.runId, {
          cursor: h.store.events.page(run.runId, { limit: 1 }).nextCursor ?? "",
        }),
      "E_VALIDATION",
    );
  });
});

describe("atomic snapshot and live race", () => {
  it("normalizes a pre-P4 cached view on the snapshot fastpath", () => {
    const h = harness();
    const run = createRun(h);
    const path = "legacy" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "legacy", kind: "agent" });
    const watermark = Math.max(...h.store.events.list(run.runId).map((event) => event.id));
    h.close();

    const raw = new Database(h.file);
    try {
      const row = raw
        .prepare("SELECT view_json, last_event_id FROM run_views WHERE run_id = ?")
        .get(run.runId) as { view_json: string; last_event_id: number };
      expect(row.last_event_id).toBe(watermark);
      const cached = JSON.parse(row.view_json) as {
        executions: Record<string, Record<string, unknown>>;
      };
      for (const execution of Object.values(cached.executions)) {
        delete execution.gateDecision;
        delete execution.joinResolution;
      }
      raw
        .prepare("UPDATE run_views SET view_json = ? WHERE run_id = ?")
        .run(JSON.stringify(cached), run.runId);
    } finally {
      raw.close();
    }

    const reopened = h.reopen();
    try {
      const snapshot = reopened.view.snapshot(run.runId);
      expect(snapshot.watermark).toBe(watermark);
      expect(snapshot.view.lastEventId).toBe(watermark);
      const execution = snapshot.view.executions[path] as unknown as Record<string, unknown>;
      expect(Object.hasOwn(execution, "gateDecision")).toBe(true);
      expect(Object.hasOwn(execution, "joinResolution")).toBe(true);
      expect(execution.gateDecision).toBeNull();
      expect(execution.joinResolution).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("returns run, view and watermark from one read and never includes later events", () => {
    const h = harness();
    const run = createRun(h);
    const before = h.store.view.snapshot(run.runId);
    expect(before.run.id).toBe(run.runId);
    expect(before.view.lastEventId).toBe(before.watermark);
    expect(before.watermark).toBe(Math.max(...h.store.events.list(run.runId).map((e) => e.id)));

    append(h, run.runId, "", "error.logged", { code: "E_INTERNAL", message: "later" });
    expect(before.view.lastEventId).toBe(before.watermark);
    expect(before.view.errors).toHaveLength(0);

    const after = h.store.view.snapshot(run.runId);
    expect(after.watermark).toBeGreaterThan(before.watermark);
    expect(after.view.errors).toHaveLength(1);
    expect(after.view).toEqual(h.store.view.get(run.runId));

    h.store.tx(() => {
      const nested = h.store.view.snapshot(run.runId);
      expect(nested.watermark).toBe(after.watermark);
    });
  });
});

describe("output provenance", () => {
  it("reads historical outputs and inputs by run/path/attempt/generation/kind", () => {
    const h = harness();
    const run = createRun(h, { workflowId: "prov" });
    const path = "work" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "work", kind: "shell" });
    const first = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.outputs.recordDeterministic({ identity: first, output: { attempt: 1 } });
    h.store.executions.recordProcessStopped({ identity: first, reason: "exited", exitCode: 0 });
    h.store.executions.recordWorkspaceFinalized({ identity: first, dir: "/ws" });
    h.store.executions.complete({ identity: first });

    append(h, run.runId, path, "node.state", {
      from: "succeeded",
      to: "pending",
      reason: "retry",
      attempt: 2,
      generation: 1,
    });
    const second = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 2,
      resolvedConfigHash: "cfg",
    });
    h.store.outputs.recordDeterministic({ identity: second, output: { attempt: 2 } });

    h.close();
    const db = new Database(h.file);
    db.prepare(
      `INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at)
       VALUES (?, ?, ?, ?, ?, 'input', 'input-hash', 2, '{"input":true}', 1)`,
    ).run("input-hist", run.runId, path, 2, second.generation);
    db.close();

    const reopened = h.reopen();
    const all = reopened.outputs.listByProvenance({ runId: run.runId, path, limit: 500 });
    expect(all.items).toHaveLength(3);
    expect(all.items.map((item) => item.kind).sort()).toEqual(["input", "output", "output"]);
    expect(
      reopened.outputs.listByProvenance({ runId: run.runId, path, kind: "output" }).items,
    ).toHaveLength(2);
    expect(
      reopened.outputs.listByProvenance({ runId: run.runId, path, attempt: 2 }).items,
    ).toHaveLength(2);
    expect(
      reopened.outputs.listByProvenance({ runId: run.runId, path, kind: "input" }).items[0]?.id,
    ).toBe("input-hist");
    expect(reopened.outputs.getById("input-hist")?.json).toEqual({ input: true });
    expect(reopened.outputs.getById("missing")).toBeNull();

    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = reopened.outputs.listByProvenance({
        runId: run.runId,
        path,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(all.items.map((item) => item.id));

    const firstPage = reopened.outputs.listByProvenance({
      runId: run.runId,
      path,
      limit: 1,
    });
    expect(firstPage.nextCursor).not.toBeNull();
    expectRelayError(
      () =>
        reopened.outputs.listByProvenance({
          runId: run.runId,
          path,
          kind: "input",
          limit: 1,
          cursor: firstPage.nextCursor ?? "",
        }),
      "E_VALIDATION",
    );
    expectRelayError(
      () =>
        reopened.outputs.listByProvenance({
          runId: run.runId,
          path,
          cursor: "not-a-cursor",
        }),
      "E_VALIDATION",
    );
    expectRelayError(
      () => reopened.outputs.listByProvenance({ runId: "missing-run" as RunId, path }),
      "E_NOT_FOUND",
    );
    reopened.close();
  });
});

describe("execution history from immutable events", () => {
  it("extracts attempts, generations, process evidence and transcript refs", () => {
    const h = harness();
    const run = createRun(h);
    const path = "work" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "work", kind: "agent" });
    const first = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    append(h, run.runId, path, "node.session.captured", {
      attempt: 1,
      generation: first.generation,
      cli: "claude",
      sessionId: "session-1",
      cwd: "/ws",
      model: "m1",
    });
    h.store.executions.recordSpawned({
      identity: first,
      pid: 111,
      pidStart: "start-1",
      binary: "/bin/agent",
      cwd: "/ws",
    });
    append(h, run.runId, path, "node.transcript.ref", {
      attempt: 1,
      generation: first.generation,
      file: "transcripts/a.jsonl",
      bytes: 12,
    });
    append(h, run.runId, path, "node.output.rejected", {
      attempt: 1,
      generation: first.generation,
      validationAttempt: 2,
      errors: [],
    });
    h.store.executions.recordProcessStopped({ identity: first, reason: "exited", exitCode: 0 });

    h.store.recovery.recover(run.runId);
    const second = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.executions.recordSpawned({
      identity: second,
      pid: 222,
      pidStart: "start-2",
      binary: "/bin/agent",
      cwd: "/ws",
    });
    append(h, run.runId, path, "node.transcript.ref", {
      attempt: 1,
      generation: second.generation,
      file: "transcripts/b.jsonl",
      bytes: 34,
    });
    h.store.executions.recordProcessStopped({ identity: second, reason: "killed", exitCode: 137 });

    const history = h.store.executions.history(run.runId, path);
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts.map((attempt) => attempt.generation)).toEqual([
      first.generation,
      second.generation,
    ]);
    expect(history.attempts[0]).toMatchObject({
      attempt: 1,
      generation: first.generation,
      mode: "fresh",
      cli: "claude",
      model: "m1",
      sessionId: "session-1",
      validationAttempts: 2,
      stopReason: "exited",
      exitCode: 0,
      process: {
        pid: 111,
        pidStart: "start-1",
        binary: "/bin/agent",
        cwd: "/ws",
        stopReason: "exited",
        exitCode: 0,
      },
    });
    expect(history.attempts[1]).toMatchObject({
      generation: second.generation,
      stopReason: "killed",
      exitCode: 137,
      process: { pid: 222, pidStart: "start-2" },
    });
    expect(history.transcripts.map((ref) => ref.file)).toEqual([
      "transcripts/b.jsonl",
      "transcripts/a.jsonl",
    ]);
    expect(history.latestTranscript).toMatchObject({
      attempt: 1,
      generation: second.generation,
      file: "transcripts/b.jsonl",
      bytes: 34,
    });

    expectRelayError(() => h.store.executions.history(run.runId, "missing" as Path), "E_NOT_FOUND");
  });

  it("returns stored INTEGER epoch-ms timestamps, not Date.parse fallbacks", () => {
    const h = harness();
    const run = createRun(h);
    const path = "work" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "work", kind: "agent" });

    const attemptAt = Date.parse("2026-10-26T19:05:00.000Z");
    h.clock.advanceTo(attemptAt);
    const identity = h.store.executions.beginInvocation({
      runId: run.runId,
      path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    const spawnedAt = Date.parse("2026-10-26T19:05:02.345Z");
    h.clock.advanceTo(spawnedAt);
    h.store.executions.recordSpawned({
      identity,
      pid: 4242,
      pidStart: "start-2026",
      binary: "/bin/agent",
      cwd: "/ws",
    });
    const transcriptAt = Date.parse("2026-10-26T19:05:03.500Z");
    h.clock.advanceTo(transcriptAt);
    append(h, run.runId, path, "node.transcript.ref", {
      attempt: 1,
      generation: identity.generation,
      file: "transcripts/a.jsonl",
      bytes: 12,
    });
    const stoppedAt = Date.parse("2026-10-26T19:05:04.900Z");
    h.clock.advanceTo(stoppedAt);
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });

    const history = h.store.executions.history(run.runId, path);
    expect(history.attempts).toHaveLength(1);
    expect(history.attempts[0]).toMatchObject({
      attempt: 1,
      generation: identity.generation,
      mode: "fresh",
      startedAt: attemptAt,
      stoppedAt,
      process: { startedAt: spawnedAt, stoppedAt },
    });
    expect(history.transcripts).toEqual([
      expect.objectContaining({
        attempt: 1,
        generation: identity.generation,
        file: "transcripts/a.jsonl",
        ts: transcriptAt,
      }),
    ]);
    expect(history.latestTranscript).toMatchObject({ ts: transcriptAt });
  });

  it("preserves a legitimate epoch-zero timestamp", () => {
    const h = harness(0);
    const run = createRun(h);
    const path = "epoch" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "epoch", kind: "shell" });
    h.store.executions.beginInvocation({ runId: run.runId, path, attempt: 1 });

    const history = h.store.executions.history(run.runId, path);
    expect(history.attempts[0]?.startedAt).toBe(0);
  });

  it("rejects corrupt stored timestamps instead of fabricating epoch zero", () => {
    const h = harness();
    const run = createRun(h);
    const path = "corrupt" as Path;
    h.store.executions.ensure({ runId: run.runId, path, nodeId: "corrupt", kind: "agent" });
    h.store.executions.beginInvocation({ runId: run.runId, path, attempt: 1 });
    h.close();

    const raw = new Database(h.file);
    try {
      const result = raw
        .prepare("UPDATE events SET ts = ? WHERE run_id = ? AND path = ? AND type = ?")
        .run("not-a-timestamp", run.runId, path, "node.attempt.started");
      expect(result.changes).toBe(1);
    } finally {
      raw.close();
    }

    const reopened = h.reopen();
    try {
      expectRelayError(() => reopened.executions.history(run.runId, path), "E_INTERNAL");
    } finally {
      reopened.close();
    }
  });
});

describe("durable start idempotency", () => {
  it("returns the original run and allocates nothing on a same-fingerprint retry", () => {
    const h = harness();
    const first = createRun(h, { idempotency: { key: "key-1", fingerprint: "fp-1" } });
    expect(first.duplicate).toBe(false);
    const events = h.store.events.list(first.runId).length;
    const nextNumber = h.store.projects.get("p1")?.nextRunNumber;

    const replay = createRun(h, { idempotency: { key: "key-1", fingerprint: "fp-1" } });
    expect(replay).toEqual({ ...first, duplicate: true });
    expect(h.store.events.list(first.runId)).toHaveLength(events);
    expect(h.store.projects.get("p1")?.nextRunNumber).toBe(nextNumber);
    expect(h.store.runs.list({ projectId: "p1" }).items).toHaveLength(1);

    append(h, first.runId, "", "run.cancelled", { by: "test" });
    expect(createRun(h, { idempotency: { key: "key-1", fingerprint: "fp-1" } })).toEqual({
      ...first,
      duplicate: true,
    });

    expectRelayError(
      () => createRun(h, { idempotency: { key: "key-1", fingerprint: "different" } }),
      "E_CONFLICT",
    );
    expectRelayError(
      () =>
        createRun(h, {
          idempotency: { key: "key-2", fingerprint: "fp-2", scope: "p2" },
        }),
      "E_VALIDATION",
    );
    expectRelayError(
      () => createRun(h, { idempotency: { key: "", fingerprint: "fp" } }),
      "E_VALIDATION",
    );
  });

  it("is restart-safe, project-scoped and expires after ten minutes", () => {
    const h = harness();
    const first = createRun(h, { idempotency: { key: "shared", fingerprint: "fp-1" } });
    const other = createRun(h, {
      projectId: "p2",
      idempotency: { key: "shared", fingerprint: "fp-other" },
    });
    expect(other.duplicate).toBe(false);
    expect(other.runId).not.toBe(first.runId);

    h.close();
    h.clock.advance(5 * 60 * 1000);
    const reopened = h.reopen();
    expect(
      reopened.runs.create({
        projectId: "p1",
        workflowId: "w1",
        workflowHash: "hash",
        snapshot: { nodes: [] },
        snapshotRaw: '{"nodes":[]}',
        idempotency: { key: "shared", fingerprint: "fp-1" },
      }),
    ).toEqual({ ...first, duplicate: true });

    h.clock.advance(10 * 60 * 1000);
    const expired = reopened.runs.create({
      projectId: "p1",
      workflowId: "w1",
      workflowHash: "hash",
      snapshot: { nodes: [] },
      snapshotRaw: '{"nodes":[]}',
      idempotency: { key: "shared", fingerprint: "fp-1" },
    });
    expect(expired.duplicate).toBe(false);
    expect(expired.runId).not.toBe(first.runId);
    reopened.close();
  });

  it("rolls back the claim and run together", () => {
    const h = harness();
    expect(() =>
      h.store.tx(() => {
        createRun(h, { idempotency: { key: "rollback", fingerprint: "fp" } });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(h.store.runs.list({ projectId: "p1" }).items).toHaveLength(0);

    const fresh = createRun(h, { idempotency: { key: "rollback", fingerprint: "fp" } });
    expect(fresh.duplicate).toBe(false);
    expect(fresh.runNumber).toBe(1);
  });

  it("keeps the no-key path unchanged", () => {
    const h = harness();
    const first = createRun(h);
    const second = createRun(h);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.runId).not.toBe(second.runId);
  });
});
