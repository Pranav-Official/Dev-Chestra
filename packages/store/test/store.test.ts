import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DevChestraError,
  type ExecutionIdentity,
  FakeClock,
  FakeIdGen,
  type NodeKind,
  type Path,
  project,
  type RunId,
} from "@devchestra/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSqliteDriver } from "../src/driver-node-sqlite.js";
import { openStore, type Store } from "../src/index.js";
import { MIGRATIONS } from "../src/migrate.js";

interface Harness {
  dir: string;
  file: string;
  clock: FakeClock;
  store: Store;
  runId: RunId;
  path: Path;
  close(): void;
  reopen(): Store;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(options: { validationLimit?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-store-"));
  const file = join(dir, "devchestra.db");
  const clock = new FakeClock(1_700_000_000_000);
  const store = openStore({ file, clock, idGen: new FakeIdGen("t") });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "flow",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    params: {},
    budgets: {},
  });
  const path = "work" as Path;
  store.executions.ensure({
    runId: run.runId,
    path,
    nodeId: "work",
    kind: "agent",
    validationLimit: options.validationLimit ?? 3,
  });

  const h: Harness = {
    dir,
    file,
    clock,
    store,
    runId: run.runId,
    path,
    close() {
      store.close();
    },
    reopen() {
      return openStore({ file, clock, idGen: new FakeIdGen("t2") });
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

function begin(h: Harness, attempt = 1): ExecutionIdentity {
  return h.store.executions.beginInvocation({
    runId: h.runId,
    path: h.path,
    attempt,
    pid: 4242,
    lstart: "start",
    resolvedConfigHash: "cfg",
  });
}

function valid(identity: ExecutionIdentity, callId: string, value: unknown) {
  return h_submit(identity, callId, value);
}

function h_submit(identity: ExecutionIdentity, callId: string, value: unknown) {
  return {
    identity,
    callId,
    request: { name: "submit_result", arguments: { value } },
    ok: true as const,
    output: { value },
  };
}

function expectDevChestraError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DevChestraError);
    expect((error as DevChestraError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DevChestraError ${code}`);
}

describe("store durability", () => {
  it("creates runs with monotonic numbers and persists across reopen", () => {
    const h = harness();
    const second = h.store.runs.create({
      projectId: "proj",
      workflowId: "flow",
      workflowHash: "hash2",
      snapshot: {},
      snapshotRaw: "{}",
      params: {},
      budgets: {},
    });
    expect(second.runNumber).toBe(2);
    expect(h.store.view.get(h.runId).status).toBe("running");
    expect(h.store.events.list(h.runId).map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "node.state",
    ]);

    h.close();
    const reopened = h.reopen();
    expect(reopened.view.get(h.runId).status).toBe("running");
    expect(reopened.events.list(h.runId)).toHaveLength(3);
    reopened.close();
  });

  it("poisons the outer transaction when a nested failure is caught", () => {
    const h = harness();
    const identity = begin(h);
    const beforeEvents = h.store.events.list(h.runId).length;
    const beforeView = h.store.view.get(h.runId);
    let published = 0;
    h.store.bus.subscribe(() => {
      published += 1;
    });

    expect(() =>
      h.store.tx(() => {
        try {
          h.store.events.append(h.runId, [
            {
              runId: h.runId,
              path: h.path,
              type: "node.state",
              actor: "engine",
              payload: {
                from: "ready",
                to: "running",
                attempt: 1,
                generation: identity.generation,
              },
            },
          ]);
        } catch {
          // Deliberately swallowed: the outer transaction must still roll back.
        }
      }),
    ).toThrow();

    expect(h.store.events.list(h.runId)).toHaveLength(beforeEvents);
    expect(h.store.view.get(h.runId)).toEqual(beforeView);
    expect(published).toBe(0);
  });

  it("rejects a promise-returning callback at the type and runtime boundary", () => {
    const h = harness();
    const asyncBody = async () => {
      h.store.events.append(h.runId, []);
    };
    const call = () =>
      // @ts-expect-error store.tx is synchronous and rejects promise-returning callbacks
      h.store.tx(asyncBody);
    expect(call).toThrow(/synchronous/i);
  });

  it("rejects a thenable tx callback before committing partial writes", () => {
    const h = harness();
    const before = h.store.events.list(h.runId).length;
    let published = 0;
    h.store.bus.subscribe(() => {
      published += 1;
    });
    expect(() =>
      // @ts-expect-error async callbacks are rejected at the type boundary too
      h.store.tx(async (store) => {
        store.events.append(h.runId, [
          {
            runId: h.runId,
            path: "" as Path,
            type: "error.logged",
            actor: "system",
            payload: { code: "E_INTERNAL", message: "async rollback" },
          },
        ]);
      }),
    ).toThrow(/synchronous/i);
    expect(h.store.events.list(h.runId)).toHaveLength(before);
    expect(published).toBe(0);
  });

  it("uses WAL and enforces foreign keys", () => {
    const h = harness();
    h.close();
    const db = new Database(h.file);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    const keys = db.pragma("foreign_key_list(events)") as unknown[];
    expect(keys.length).toBeGreaterThan(0);
    db.pragma("foreign_keys = ON");
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (run_id, ts, path, type, actor, v, payload)
           VALUES ('missing-run', 1, '', 'error.logged', 'system', 1, '{}')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY|constraint/i);
    db.close();
  });

  it("runs on the node:sqlite fallback driver", () => {
    const dir = mkdtempSync(join(tmpdir(), "devchestra-store-node-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "devchestra.db");
    const store = openStore({ file, driver: nodeSqliteDriver, clock: new FakeClock(1) });
    store.projects.ensure({ id: "p", name: "P", path: dir, kind: "folder" });
    const run = store.runs.create({
      projectId: "p",
      workflowId: "w",
      workflowHash: "h",
      snapshot: {},
      snapshotRaw: "{}",
    });
    expect(store.view.get(run.runId).runNumber).toBe(1);
    store.close();
  });

  it("rolls back events, projections and the post-commit bus together", () => {
    const h = harness();
    const before = h.store.events.list(h.runId).length;
    let published = 0;
    h.store.bus.subscribe(() => {
      published += 1;
    });

    expect(() =>
      h.store.tx(() => {
        h.store.events.append(h.runId, [
          {
            runId: h.runId,
            path: "" as Path,
            type: "error.logged",
            actor: "system",
            payload: { code: "E_INTERNAL", message: "rollback me" },
          },
        ]);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(h.store.events.list(h.runId)).toHaveLength(before);
    expect(published).toBe(0);
  });
});

describe("migrations", () => {
  it("upgrades a real P0 database through 0003 without rewriting events", () => {
    const dir = mkdtempSync(join(tmpdir(), "devchestra-store-p0-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "devchestra.db");
    const p0Sql = readFileSync(
      fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)),
      "utf8",
    );
    const db = new Database(file);
    db.exec(p0Sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)").run();
    db.exec("PRAGMA user_version = 1");
    db.prepare(
      `INSERT INTO projects (id, name, path, kind, added_at)
       VALUES ('p0', 'P0', ?, 'folder', 1)`,
    ).run(dir);
    db.prepare(
      `INSERT INTO runs
         (id, project_id, workflow_id, run_number, kind, status, workflow_hash,
          snapshot_json, snapshot_raw, params_json, budgets_json, created_at)
       VALUES ('p0-run', 'p0', 'w', 1, 'run', 'running', 'h', '{"nodes":[]}', '{}', '{}', '{}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO events (run_id, ts, path, type, actor, v, payload)
       VALUES ('p0-run', 1, '', 'run.started', 'engine', 1, '{}')`,
    ).run();
    db.close();

    const store = openStore({ file, clock: new FakeClock(2) });
    expect(store.runs.get("p0-run" as RunId)?.snapshot).toEqual({ nodes: [] });
    expect(store.runs.get("p0-run" as RunId)?.workspace).toBeNull();
    expect(store.events.list("p0-run" as RunId)).toHaveLength(1);
    store.close();

    const upgraded = new Database(file, { readonly: true });
    expect(upgraded.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const generationColumns = (
      upgraded.pragma("table_info(process_generations)") as { name: string }[]
    ).map((column) => column.name);
    expect(generationColumns).toEqual(expect.arrayContaining(["pid_start", "binary", "cwd"]));
    const executionColumns = (upgraded.pragma("table_info(executions)") as { name: string }[]).map(
      (column) => column.name,
    );
    expect(executionColumns).toContain("kind");
    const runColumns = (upgraded.pragma("table_info(runs)") as { name: string }[]).map(
      (column) => column.name,
    );
    expect(runColumns).toContain("workspace_json");
    expect(
      upgraded.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number },
    ).toEqual({ count: 1 });
    upgraded.close();
  });
});

describe("invocation fencing", () => {
  it("advances an interrupted execution through ready before running", () => {
    const h = harness();
    const identity = begin(h);
    h.store.recovery.recover(h.runId);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("interrupted");
    const next = h.store.executions.beginInvocation({
      runId: h.runId,
      path: h.path,
      attempt: 1,
      resolvedConfigHash: "cfg2",
    });
    expect(next.generation).toBe(identity.generation + 1);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("running");
    const transitions = h.store.events
      .list(h.runId, { types: ["node.state"] })
      .filter((event) => event.path === h.path)
      .map((event) => {
        const payload = event.payload as { from: string; to: string };
        return `${payload.from}->${payload.to}`;
      });
    expect(transitions).toEqual([
      "pending->ready",
      "ready->running",
      "running->interrupted",
      "interrupted->ready",
      "ready->running",
    ]);
  });

  it("rejects stale, future and mismatched generations exactly", () => {
    const h = harness();
    const identity = begin(h);
    expect(identity.generation).toBe(2);

    const submission = valid(identity, "c1", 1);
    // Future generation must not be treated as merely "not stale".
    expectDevChestraError(
      () => h.store.submissions.submit({ ...submission, identity: { ...identity, generation: 3 } }),
      "E_CONFLICT",
    );
    // Older generation.
    expectDevChestraError(
      () => h.store.submissions.submit({ ...submission, identity: { ...identity, generation: 1 } }),
      "E_CONFLICT",
    );
    // Wrong attempt.
    expectDevChestraError(
      () => h.store.submissions.submit({ ...submission, identity: { ...identity, attempt: 2 } }),
      "E_CONFLICT",
    );
    // Wrong path.
    expectDevChestraError(
      () =>
        h.store.submissions.submit({
          ...submission,
          identity: { ...identity, path: "other" as Path },
        }),
      "E_NOT_FOUND",
    );
  });
});

describe("secret guard", () => {
  it("rejects a secret in the run snapshot before allocating a run number", () => {
    const h = harness();
    const sentinel = "sentinel-SNAPSHOT-24680";
    h.store.security.registerSecret(sentinel, "exec-token");
    expectDevChestraError(
      () =>
        h.store.runs.create({
          projectId: "proj",
          workflowId: "leaky",
          workflowHash: "h",
          snapshot: { prompt: sentinel },
          snapshotRaw: "{}",
          params: {},
          budgets: {},
        }),
      "E_VALIDATION",
    );
    const next = h.store.runs.create({
      projectId: "proj",
      workflowId: "clean",
      workflowHash: "h2",
      snapshot: {},
      snapshotRaw: "{}",
      params: {},
      budgets: {},
    });
    expect(next.runNumber).toBe(2);
  });
});

describe("submissions", () => {
  it("counts committed E_NO_SUBMIT receipts without double counting or cross-scope bleed", () => {
    const h = harness({ validationLimit: 4 });
    const identity = begin(h);
    const noSubmit = (callId: string) => ({
      identity,
      callId,
      request: { name: "submit_result", arguments: {} },
      ok: false as const,
      errorCode: "E_NO_SUBMIT",
      errors: [{ path: "/", message: "no submit" }],
    });
    expect(h.store.submissions.countNoSubmit(identity)).toBe(0);
    h.store.submissions.submit(noSubmit("ns-1"));
    h.store.submissions.submit(noSubmit("ns-1"));
    expect(h.store.submissions.countNoSubmit(identity)).toBe(1);

    h.store.submissions.submit({
      identity,
      callId: "other-code",
      request: { name: "submit_result", arguments: { x: 1 } },
      ok: false,
      errorCode: "E_OUTPUT_INVALID",
      errors: [{ path: "/x", message: "bad" }],
    });
    expect(h.store.submissions.countNoSubmit(identity)).toBe(1);

    h.store.submissions.submit(noSubmit("ns-2"));
    expect(h.store.submissions.countNoSubmit(identity)).toBe(2);
    expect(
      h.store.submissions.countNoSubmit({
        runId: h.runId,
        path: h.path,
        attempt: 2,
      }),
    ).toBe(0);

    const second = h.store.runs.create({
      projectId: "proj",
      workflowId: "second",
      workflowHash: "h2",
      snapshot: {},
      snapshotRaw: "{}",
    });
    h.store.executions.ensure({
      runId: second.runId,
      path: h.path,
      nodeId: "work",
      kind: "agent",
    });
    const secondIdentity = h.store.executions.beginInvocation({
      runId: second.runId,
      path: h.path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.submissions.submit({ ...noSubmit("ns-other"), identity: secondIdentity });
    expect(h.store.submissions.countNoSubmit(secondIdentity)).toBe(1);
    expect(h.store.submissions.countNoSubmit(identity)).toBe(2);

    h.close();
    const reopened = h.reopen();
    expect(reopened.submissions.countNoSubmit(identity)).toBe(2);
    expect(
      reopened.submissions.countNoSubmit({ runId: second.runId, path: h.path, attempt: 1 }),
    ).toBe(1);
    reopened.close();
  });

  it("commits accepted output, event and receipt atomically; replays safely", () => {
    const h = harness();
    const identity = begin(h);
    const input = valid(identity, "call-1", 42);

    const first = h.store.submissions.submit(input);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") throw new Error("unreachable");
    expect(first.duplicate).toBe(false);
    expect(first.output.json).toEqual({ value: 42 });
    expect(first.receipt.eventId).toBe(first.eventId);

    const view = h.store.view.get(h.runId);
    const exec = view.executions[h.path];
    expect(exec?.status).toBe("validating");
    expect(exec?.acceptedResult?.outputId).toBe(first.output.id);
    expect(view.status).not.toBe("succeeded");

    const replay = h.store.submissions.submit(input);
    expect(replay.kind).toBe("accepted");
    if (replay.kind !== "accepted") throw new Error("unreachable");
    expect(replay.duplicate).toBe(true);
    expect(replay.output.id).toBe(first.output.id);
    expect(replay.eventId).toBe(first.eventId);
    expect(h.store.events.list(h.runId, { types: ["node.output.validated"] })).toHaveLength(1);

    expectDevChestraError(
      () =>
        h.store.submissions.submit({
          ...input,
          request: { name: "submit_result", arguments: { value: 43 } },
        }),
      "E_CONFLICT",
    );

    const second = h.store.submissions.submit(valid(identity, "call-2", 42));
    expect(second.kind).toBe("already_accepted");
    if (second.kind !== "already_accepted") throw new Error("unreachable");
    expect(second.output.id).toBe(first.output.id);
    expect(h.store.events.list(h.runId, { types: ["node.output.validated"] })).toHaveLength(1);
  });

  it("records invalid receipts exactly once and enforces the durable budget", () => {
    const h = harness({ validationLimit: 2 });
    const identity = begin(h);
    const request = { name: "submit_result", arguments: { bad: true } };
    const invalid = (callId: string, validationAttempt?: number) => ({
      identity,
      callId,
      request,
      ok: false as const,
      errors: [{ path: "/value", message: "Required" }],
      ...(validationAttempt === undefined ? {} : { validationAttempt }),
    });

    const first = h.store.submissions.submit(invalid("bad-1"));
    expect(first.kind).toBe("rejected");
    if (first.kind !== "rejected") throw new Error("unreachable");
    expect(first.validationAttempt).toBe(1);
    expect(first.validationAttemptsLeft).toBe(1);
    expect(h.store.submissions.validationLeft(identity)).toBe(1);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("running");

    const replay = h.store.submissions.submit(invalid("bad-1"));
    expect(replay.kind).toBe("rejected");
    if (replay.kind !== "rejected") throw new Error("unreachable");
    expect(replay.duplicate).toBe(true);
    expect(replay.receipt.validationAttemptsAfter).toBe(1);
    expect(h.store.submissions.validationLeft(identity)).toBe(1);
    expect(h.store.events.list(h.runId, { types: ["node.output.rejected"] })).toHaveLength(1);

    expectDevChestraError(() => h.store.submissions.submit(invalid("bad-wrong", 9)), "E_CONFLICT");
    const second = h.store.submissions.submit(invalid("bad-2"));
    if (second.kind !== "rejected") throw new Error("unreachable");
    expect(second.validationAttemptsLeft).toBe(0);

    expectDevChestraError(
      () => h.store.submissions.submit(invalid("bad-3")),
      "E_ATTEMPTS_EXHAUSTED",
    );

    // A committed receipt replays after exhaustion without consuming more budget.
    const exhaustedReplay = h.store.submissions.submit(invalid("bad-1"));
    expect(exhaustedReplay.kind).toBe("rejected");
    expect(h.store.submissions.validationLeft(identity)).toBe(0);

    expectDevChestraError(
      () =>
        h.store.submissions.submit({
          ...invalid("bad-2"),
          request: { name: "submit_result", arguments: { changed: true } },
        }),
      "E_CONFLICT",
    );
  });
});

describe("secret guard", () => {
  function diskText(h: Harness): string {
    return [h.file, `${h.file}-wal`, `${h.file}-shm`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("\n");
  }

  it("rejects pattern and registered secrets in outputs without writing them", () => {
    const h = harness();
    const identity = begin(h);
    const sentinel = "sentinel-UNIT-123456789";
    const unregister = h.store.security.registerSecret(sentinel, "exec-token");
    expect(h.store.security.scan({ nested: [`x ${sentinel}`] })?.source).toBe("registered");

    expectDevChestraError(
      () => h.store.submissions.submit(valid(identity, "leak-1", { note: sentinel })),
      "E_VALIDATION",
    );
    expectDevChestraError(
      () => h.store.submissions.submit(valid(identity, "leak-2", { note: "sk-abcdefgh12345678" })),
      "E_VALIDATION",
    );
    expectDevChestraError(
      () => h.store.submissions.submit(valid(identity, "leak-3", sentinel)),
      "E_VALIDATION",
    );
    expect(h.store.submissions.accepted({ runId: h.runId, path: h.path, attempt: 1 })).toBeNull();
    expect(h.store.events.list(h.runId, { types: ["node.output.validated"] })).toHaveLength(0);

    const text = diskText(h);
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("sk-abcdefgh12345678");
    unregister();
  });

  it("redacts receipts and events, and refuses a secret-bearing callId", () => {
    const h = harness();
    const identity = begin(h);
    const sentinel = "sentinel-EVENT-987654321";
    h.store.security.registerSecret(sentinel, "exec-token");

    expectDevChestraError(
      () =>
        h.store.submissions.submit({
          ...valid(identity, sentinel, 1),
        }),
      "E_VALIDATION",
    );

    const rejected = h.store.submissions.submit({
      identity,
      callId: "bad-secret-error",
      request: { name: "submit_result", arguments: { x: 1 } },
      ok: false,
      errors: [{ path: "/x", message: `payload was ${sentinel}` }],
    });
    if (rejected.kind !== "rejected") throw new Error("unreachable");
    expect(rejected.receipt.errorMessage).toContain("[redacted:exec-token]");
    expect(rejected.receipt.errorMessage).not.toContain(sentinel);

    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "error.logged",
        actor: "system",
        payload: { code: "E_INTERNAL", message: `debug ${sentinel}` },
      },
    ]);
    const errorEvent = h.store.events
      .list(h.runId, { types: ["error.logged"] })
      .find((event) => event.type === "error.logged");
    expect(JSON.stringify(errorEvent)).not.toContain(sentinel);
    expect(JSON.stringify(h.store.events.list(h.runId))).not.toContain(sentinel);
    expect(diskText(h)).not.toContain(sentinel);
  });
});

describe("acceptance is not success", () => {
  it("requires independent process-stop and workspace evidence before success", () => {
    const h = harness();
    const identity = begin(h);
    const accepted = h.store.submissions.submit(valid(identity, "ok", 7));
    expect(accepted.kind).toBe("accepted");

    expectDevChestraError(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    expectDevChestraError(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("validating");

    h.store.executions.recordWorkspaceFinalized({ identity, dir: "/tmp/ws", commitSha: "abc" });
    const completion = h.store.executions.complete({ identity });
    expect(completion.status).toBe("succeeded");
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("succeeded");

    // Idempotent evidence and completion.
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    expect(h.store.executions.complete({ identity }).status).toBe("succeeded");
    expect(h.store.events.list(h.runId, { types: ["node.process.stopped"] })).toHaveLength(1);
    expect(h.store.events.list(h.runId, { types: ["node.workspace.finalized"] })).toHaveLength(1);

    expectDevChestraError(
      () => h.store.executions.recordProcessStopped({ identity, reason: "killed", exitCode: 137 }),
      "E_CONFLICT",
    );
  });

  it("stays unfinished across restart when accepted but not finalized, then adopts same generation", () => {
    const h = harness();
    const identity = begin(h);
    const accepted = h.store.submissions.submit(valid(identity, "ok", 8));
    if (accepted.kind !== "accepted") throw new Error("unreachable");

    h.close();
    const reopened = h.reopen();
    const before = reopened.view.get(h.runId);
    expect(before.executions[h.path]?.status).toBe("validating");
    expect(before.executions[h.path]?.acceptedResult?.outputId).toBe(accepted.output.id);
    expect(before.status).not.toBe("succeeded");

    expectDevChestraError(() => reopened.executions.complete({ identity }), "E_CONFLICT");
    // No re-submit and no new generation: finish the original accepted attempt.
    expectDevChestraError(
      () => reopened.executions.beginInvocation({ runId: h.runId, path: h.path, attempt: 1 }),
      "E_CONFLICT",
    );
    const completion = reopened.executions.completeAcceptedAfterRecovery({
      identity,
      processStop: { reason: "crash", exitCode: null },
      workspace: { dir: "/tmp/ws" },
    });
    expect(completion.status).toBe("succeeded");
    expect(reopened.executions.get(h.runId, h.path)?.generation).toBe(identity.generation);
    expect(reopened.submissions.accepted({ runId: h.runId, path: h.path, attempt: 1 })?.id).toBe(
      accepted.output.id,
    );
    reopened.close();
  });

  it("refuses a new generation while an accepted result still awaits finalization", () => {
    const h = harness();
    const identity = begin(h);
    h.store.submissions.submit(valid(identity, "ok", 11));
    h.store.recovery.recover(h.runId);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("interrupted");
    h.store.recovery.recover(h.runId);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("interrupted");

    expectDevChestraError(
      () => h.store.executions.beginInvocation({ runId: h.runId, path: h.path, attempt: 1 }),
      "E_CONFLICT",
    );
    const done = h.store.executions.completeAcceptedAfterRecovery({
      identity,
      processStop: { reason: "crash", exitCode: null },
      workspace: { dir: "/tmp/ws" },
    });
    expect(done.status).toBe("succeeded");
    expect(h.store.executions.get(h.runId, h.path)?.generation).toBe(identity.generation);
  });

  it("attributes already_accepted to the matching attempt's validated event", () => {
    const h = harness();
    const firstIdentity = begin(h);
    const first = h.store.submissions.submit(valid(firstIdentity, "a1", 1));
    if (first.kind !== "accepted") throw new Error("unreachable");
    h.store.executions.recordProcessStopped({
      identity: firstIdentity,
      reason: "exited",
      exitCode: 0,
    });
    h.store.executions.recordWorkspaceFinalized({ identity: firstIdentity, dir: "/tmp/ws" });
    h.store.executions.complete({ identity: firstIdentity });

    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: h.path,
        type: "node.state",
        actor: "engine",
        payload: {
          from: "succeeded",
          to: "pending",
          reason: "retry",
          attempt: 2,
          generation: 1,
        },
      },
    ]);
    const secondIdentity = begin(h, 2);
    const second = h.store.submissions.submit(valid(secondIdentity, "a2", 2));
    if (second.kind !== "accepted") throw new Error("unreachable");
    expect(second.eventId).not.toBe(first.eventId);

    const already = h.store.submissions.submit(valid(secondIdentity, "a3", 2));
    expect(already.kind).toBe("already_accepted");
    if (already.kind !== "already_accepted") throw new Error("unreachable");
    expect(already.acceptedEventId).toBe(second.eventId);
    expect(already.acceptedEventId).not.toBe(first.eventId);
  });

  it("never treats an input row as an accepted output and enforces one output per attempt", () => {
    const h = harness();
    const identity = begin(h);
    h.close();

    const db = new Database(h.file);
    db.pragma("foreign_keys = ON");
    const insert = db.prepare(
      `INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'h', 2, '{}', 1)`,
    );
    insert.run("input-1", h.runId, h.path, 1, identity.generation, "input");
    insert.run("output-1", h.runId, h.path, 1, identity.generation, "output");
    expect(() => insert.run("output-2", h.runId, h.path, 1, identity.generation, "output")).toThrow(
      /UNIQUE|constraint/i,
    );
    db.close();

    const reopened = h.reopen();
    const accepted = reopened.submissions.accepted({
      runId: h.runId,
      path: h.path,
      attempt: 1,
    });
    expect(accepted?.id).toBe("output-1");
    expect(reopened.submissions.accepted({ runId: h.runId, path: h.path, attempt: 2 })).toBeNull();
    reopened.close();
  });
});

describe("terminal run fencing", () => {
  it("replays receipts but refuses new submits, invocations, markers and recovery", () => {
    const h = harness();
    const identity = begin(h);
    const committed = h.store.submissions.submit(valid(identity, "done", 5));
    if (committed.kind !== "accepted") throw new Error("unreachable");
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "run.cancelled",
        actor: "user",
        payload: { by: "test" },
      },
    ]);
    expect(h.store.view.get(h.runId).status).toBe("cancelled");

    const replay = h.store.submissions.submit(valid(identity, "done", 5));
    expect(replay.kind).toBe("accepted");
    if (replay.kind !== "accepted") throw new Error("unreachable");
    expect(replay.duplicate).toBe(true);

    const readOnly = h.store.submissions.submit(valid(identity, "new", 6));
    expect(readOnly.kind).toBe("already_accepted");
    expectDevChestraError(
      () => h.store.executions.beginInvocation({ runId: h.runId, path: h.path, attempt: 1 }),
      "E_CONFLICT",
    );
    expectDevChestraError(
      () =>
        h.store.executions.recordProcessStopped({
          identity,
          reason: "exited",
          exitCode: 0,
        }),
      "E_CONFLICT",
    );
    expectDevChestraError(
      () => h.store.executions.recordWorkspaceFinalized({ identity, dir: "/tmp/ws" }),
      "E_CONFLICT",
    );
    expectDevChestraError(() => h.store.executions.complete({ identity }), "E_CONFLICT");

    const before = h.store.events.list(h.runId).length;
    const report = h.store.recovery.recover(h.runId);
    expect(report.rebuilt).toBe(false);
    expect(h.store.events.list(h.runId)).toHaveLength(before);
  });

  it("does not move ended_at when rebuilding after a later audit event", () => {
    const h = harness();
    const identity = begin(h);
    h.store.submissions.submit(valid(identity, "ok", 1));
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    h.store.executions.recordWorkspaceFinalized({ identity, dir: "/tmp/ws" });
    h.store.executions.complete({ identity });
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "run.completed",
        actor: "engine",
        payload: { status: "success", result: { ok: true } },
      },
    ]);
    h.close();

    const readEnded = (): number | null => {
      const db = new Database(h.file, { readonly: true });
      const row = db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(h.runId) as
        | { ended_at: number | null }
        | undefined;
      db.close();
      return row?.ended_at ?? null;
    };
    const first = readEnded();
    expect(first).not.toBeNull();

    const reopened = h.reopen();
    h.clock.advance(10_000);
    reopened.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "error.logged",
        actor: "system",
        payload: { code: "E_INTERNAL", message: "late audit" },
      },
    ]);
    reopened.view.rebuild(h.runId);
    reopened.close();
    expect(readEnded()).toBe(first);
  });
});

describe("projection", () => {
  it("incremental projection equals a full replay, rebuild and reopen", () => {
    const h = harness();
    const identity = begin(h);
    h.store.submissions.submit({
      identity,
      callId: "bad",
      request: { name: "submit_result", arguments: { x: 1 } },
      ok: false,
      errors: [{ path: "/x", message: "bad" }],
    });
    h.store.submissions.submit(valid(identity, "good", 1));
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    h.store.executions.recordWorkspaceFinalized({ identity, dir: "/tmp/ws" });
    h.store.executions.complete({ identity });

    const incremental = h.store.view.get(h.runId);
    const fromLog = project(h.store.events.list(h.runId));
    expect(incremental).toEqual(fromLog);

    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt).toEqual(incremental);
    expect(h.store.view.get(h.runId)).toEqual(incremental);

    h.close();
    const reopened = h.reopen();
    expect(reopened.view.get(h.runId)).toEqual(incremental);
    reopened.close();
  });
});

describe("P1 read ports and lifecycle", () => {
  function addExecution(h: Harness, path: string, kind: NodeKind) {
    const p = path as Path;
    h.store.executions.ensure({ runId: h.runId, path: p, nodeId: path, kind });
    return p;
  }
  function beginAt(h: Harness, path: Path, attempt = 1): ExecutionIdentity {
    return h.store.executions.beginInvocation({
      runId: h.runId,
      path,
      attempt,
      resolvedConfigHash: "cfg",
    });
  }

  it("returns frozen run snapshots and active runs; rejects unsupported budgets", () => {
    const h = harness();
    const run = h.store.runs.get(h.runId);
    expect(run?.snapshot).toEqual({ nodes: [] });
    expect(run?.snapshotRaw).toBe('{"nodes":[]}');
    expect(run?.project).toMatchObject({ id: "proj", name: "Project", kind: "folder" });
    expect(h.store.runs.listActive().map((entry) => entry.id)).toContain(h.runId);

    // Mutating a returned snapshot must not change the stored snapshot.
    if (!run) throw new Error("missing run");
    (run.snapshot as { nodes: unknown[] }).nodes.push({ hacked: true });
    expect(h.store.runs.get(h.runId)?.snapshot).toEqual({ nodes: [] });

    expectDevChestraError(
      () =>
        h.store.runs.create({
          projectId: "proj",
          workflowId: "b",
          workflowHash: "h",
          snapshot: {},
          snapshotRaw: "{}",
          budgets: { maxUsd: 5 },
        }),
      "E_VALIDATION",
    );
    expectDevChestraError(
      () =>
        h.store.runs.create({
          projectId: "proj",
          workflowId: "b",
          workflowHash: "h",
          snapshot: {},
          snapshotRaw: "{}",
          budgets: { maxActiveMinutes: 30 },
        }),
      "E_VALIDATION",
    );
    const allowed = h.store.runs.create({
      projectId: "proj",
      workflowId: "b",
      workflowHash: "h",
      snapshot: {},
      snapshotRaw: "{}",
      budgets: { maxTokens: 1000 },
    });
    expect(allowed.runNumber).toBe(2);

    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "run.cancelled",
        actor: "user",
        payload: { by: "test" },
      },
    ]);
    expect(h.store.runs.listActive().map((entry) => entry.id)).not.toContain(h.runId);
  });

  it("persists spawn evidence, lists active processes and distinguishes reused PIDs", () => {
    const h = harness();
    const identity = beginAt(h, h.path);
    const process = h.store.executions.recordSpawned({
      identity,
      pid: 111,
      pidStart: "Mon Oct 26 10:00:00 2026",
      binary: "/usr/bin/agent",
      cwd: "/tmp/ws-a",
    });
    expect(process.pid).toBe(111);
    expect(process.pidStart).toBe("Mon Oct 26 10:00:00 2026");
    expect(h.store.processes.active()).toEqual([
      expect.objectContaining({
        identity,
        pid: 111,
        binary: "/usr/bin/agent",
        cwd: "/tmp/ws-a",
        status: "running",
      }),
    ]);

    h.store.executions.recordSpawned({
      identity,
      pid: 111,
      pidStart: "Mon Oct 26 10:00:00 2026",
      binary: "/usr/bin/agent",
      cwd: "/tmp/ws-a",
    });
    expect(h.store.events.list(h.runId, { types: ["node.process.spawned"] })).toHaveLength(1);
    expectDevChestraError(
      () =>
        h.store.executions.recordSpawned({
          identity,
          pid: 112,
          pidStart: "Mon Oct 26 10:00:00 2026",
          binary: "/usr/bin/agent",
          cwd: "/tmp/ws-a",
        }),
      "E_CONFLICT",
    );
    expectDevChestraError(
      () =>
        h.store.executions.recordSpawned({
          identity: { ...identity, generation: identity.generation - 1 },
          pid: 111,
          pidStart: "x",
          binary: "x",
          cwd: "x",
        }),
      "E_CONFLICT",
    );

    const shellPath = addExecution(h, "shell", "shell");
    const shellIdentity = beginAt(h, shellPath);
    expectDevChestraError(
      () =>
        h.store.executions.recordSpawned({
          identity: shellIdentity,
          pid: 0,
          pidStart: "x",
          binary: "/bin/sh",
          cwd: "/tmp/ws-b",
        }),
      "E_VALIDATION",
    );
    expectDevChestraError(
      () =>
        h.store.executions.recordSpawned({
          identity: shellIdentity,
          pid: 111,
          pidStart: "x",
          binary: "/bin/sh\n",
          cwd: "/tmp/ws-b",
        }),
      "E_VALIDATION",
    );
    const reused = h.store.executions.recordSpawned({
      identity: shellIdentity,
      pid: 111,
      pidStart: "Tue Oct 27 11:00:00 2026",
      binary: "/bin/sh",
      cwd: "/tmp/ws-b",
    });
    expect(reused.pid).toBe(111);
    expect(reused.identity.path).toBe(shellPath);
    expect(h.store.processes.active()).toHaveLength(2);
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    const active = h.store.processes.active();
    expect(active).toHaveLength(1);
    expect(active[0]?.identity.path).toBe(shellPath);

    h.close();
    const reopened = h.reopen();
    expect(reopened.executions.getProcess(shellIdentity)?.pidStart).toBe(
      "Tue Oct 27 11:00:00 2026",
    );
    reopened.close();
  });

  it("records deterministic outputs without accepted-result or receipt semantics", () => {
    const h = harness();
    const shellPath = addExecution(h, "shell", "shell");
    const identity = beginAt(h, shellPath);
    const first = h.store.outputs.recordDeterministic({
      identity,
      output: { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 },
    });
    expect(first.duplicate).toBe(false);
    expect(h.store.view.get(h.runId).executions[shellPath]?.acceptedResult).toBeNull();
    expect(h.store.submissions.accepted({ runId: h.runId, path: shellPath, attempt: 1 })?.id).toBe(
      first.output.id,
    );
    expect(h.store.events.list(h.runId, { types: ["node.output.recorded"] })).toHaveLength(1);

    const replay = h.store.outputs.recordDeterministic({
      identity,
      output: { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 },
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.eventId).toBe(first.eventId);
    expect(h.store.events.list(h.runId, { types: ["node.output.recorded"] })).toHaveLength(1);
    expectDevChestraError(
      () =>
        h.store.outputs.recordDeterministic({
          identity,
          output: { exitCode: 1 },
        }),
      "E_CONFLICT",
    );

    expectDevChestraError(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.executions.recordProcessStopped({ identity, reason: "exited", exitCode: 0 });
    expectDevChestraError(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.executions.recordWorkspaceFinalized({ identity, dir: "/tmp/ws" });
    expect(h.store.executions.complete({ identity }).status).toBe("succeeded");

    const startPath = addExecution(h, "start", "start");
    const startIdentity = beginAt(h, startPath);
    h.store.outputs.recordDeterministic({
      identity: startIdentity,
      output: { params: {} },
    });
    expect(h.store.executions.complete({ identity: startIdentity }).status).toBe("succeeded");
  });

  it("pauses interrupted shells and requires audited user approval to retry", () => {
    const h = harness();
    const shellPath = addExecution(h, "shell", "shell");
    const identity = beginAt(h, shellPath);
    const recovered = h.store.recovery.recover(h.runId);
    expect(recovered.executions.find((entry) => entry.path === shellPath)?.decision).toBe(
      "pause_uncertain_side_effect",
    );
    expect(h.store.view.get(h.runId).executions[shellPath]?.status).toBe("interrupted");
    expect(h.store.view.get(h.runId).status).toBe("paused");
    expect(h.store.view.get(h.runId).pauseReason).toBe("uncertain_side_effect");

    expectDevChestraError(
      () =>
        h.store.executions.beginInvocation({
          runId: h.runId,
          path: shellPath,
          attempt: 1,
        }),
      "E_CONFLICT",
    );
    expectDevChestraError(
      () =>
        h.store.executions.beginInvocation({
          runId: h.runId,
          path: shellPath,
          attempt: 1,
          allowUncertainSideEffectRetry: true,
        }),
      "E_VALIDATION",
    );
    const approved = h.store.executions.beginInvocation({
      runId: h.runId,
      path: shellPath,
      attempt: 1,
      allowUncertainSideEffectRetry: true,
      approvedBy: "user-1",
    });
    expect(approved.generation).toBe(identity.generation + 1);
    expect(h.store.view.get(h.runId).executions[shellPath]?.status).toBe("running");
    expect(h.store.view.get(h.runId).status).toBe("running");
    const db = new Database(h.file, { readonly: true });
    const audit = db
      .prepare("SELECT approved_by FROM uncertain_retries WHERE run_id = ? AND path = ?")
      .get(h.runId, shellPath) as { approved_by: string } | undefined;
    db.close();
    expect(audit?.approved_by).toBe("user-1");
  });

  it("persists crash counters across reopen and does not count shutdown kills", () => {
    const h = harness();
    const identity = begin(h);
    h.store.executions.recordProcessStopped({ identity, reason: "crash", exitCode: null });
    expect(h.store.executions.get(h.runId, h.path)?.crashAttempts).toBe(1);
    h.store.recovery.recover(h.runId);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("interrupted");
    h.store.recovery.recover(h.runId);
    expect(h.store.view.get(h.runId).executions[h.path]?.status).toBe("ready");

    const second = h.store.executions.beginInvocation({
      runId: h.runId,
      path: h.path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.executions.recordProcessStopped({ identity: second, reason: "killed", exitCode: 137 });
    expect(h.store.executions.get(h.runId, h.path)?.crashAttempts).toBe(1);
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: h.path,
        type: "node.state",
        actor: "engine",
        payload: {
          from: "running",
          to: "interrupted",
          reason: "shutdown",
          attempt: 1,
          generation: second.generation,
        },
      },
    ]);
    h.store.recovery.recover(h.runId);
    expect(h.store.executions.get(h.runId, h.path)?.crashAttempts).toBe(1);

    h.close();
    const reopened = h.reopen();
    expect(reopened.executions.get(h.runId, h.path)?.crashAttempts).toBe(1);
    reopened.close();
  });
});

describe("process kill boundary", () => {
  it("reopens a gap-free committed prefix and rebuilds the same projection", async () => {
    const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    if (!existsSync(dist)) return; // build first; this signals "skipped" by returning
    const h = harness();
    h.close();

    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./child-append.mjs", import.meta.url)),
      h.file,
      h.runId,
    ]);
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        reject(new Error(`child exited before ready: ${exitCode ?? signal}: ${errors}`));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe("SIGKILL");
    expect(code).toBeNull();
    expect(errors).toBe("");

    const reopened = h.reopen();
    const events = reopened.events.list(h.runId);
    expect(events.length).toBeGreaterThan(3);
    for (let index = 1; index < events.length; index += 1) {
      const current = events[index];
      const previous = events[index - 1];
      expect(current?.id).toBe((previous?.id ?? -1) + 1);
    }
    const view = reopened.view.get(h.runId);
    expect(view).toEqual(project(events));
    expect(reopened.view.rebuild(h.runId)).toEqual(view);
    reopened.close();
  }, 20_000);
});
