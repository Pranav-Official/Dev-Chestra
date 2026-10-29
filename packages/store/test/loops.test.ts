import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevChestraError,
  type ExecutionIdentity,
  FakeClock,
  FakeIdGen,
  type Path,
  type RunId,
} from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

interface Harness {
  dir: string;
  store: Store;
  runId: RunId;
  close(): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-loops-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "loops",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    params: {},
    budgets: {},
  });
  const h: Harness = { dir, store, runId: run.runId, close: () => store.close() };
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

function beginLoop(h: Harness, nodeId = "refine"): ExecutionIdentity {
  const path = nodeId as Path;
  h.store.executions.ensure({
    runId: h.runId,
    path,
    nodeId,
    kind: "loop",
    requireSubmission: false,
  });
  return h.store.executions.beginInvocation({
    runId: h.runId,
    path,
    attempt: 1,
    resolvedConfigHash: "cfg",
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DevChestraError);
    expect((error as DevChestraError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DevChestraError ${code}`);
}

describe("durable loop controller", () => {
  it("starts iteration 1 once and projects parent/state", () => {
    const h = harness();
    const identity = beginLoop(h);
    const started = h.store.loops.start({ identity, parent: { a: 1 }, state: { n: 0 } });
    expect(started.duplicate).toBe(false);
    expect(started.loop.iteration).toBe(1);
    expect(started.loop.parent).toEqual({ a: 1 });
    expect(started.loop.state).toEqual({ n: 0 });
    expect(started.loop.rounds).toEqual([]);
    const view = h.store.view.get(h.runId).executions.refine?.loop;
    expect(view?.iteration).toBe(1);
    expect(h.store.events.list(h.runId).map((e) => e.type)).toContain("loop.started");
  });

  it("duplicate identical start is a no-op; conflicting start rejects", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: { a: 1 }, state: { n: 0 } });
    const before = h.store.events.list(h.runId).length;
    const dup = h.store.loops.start({ identity, parent: { a: 1 }, state: { n: 0 } });
    expect(dup.duplicate).toBe(true);
    expect(h.store.events.list(h.runId).length).toBe(before);
    expectCode(
      () => h.store.loops.start({ identity, parent: { a: 2 }, state: { n: 0 } }),
      "E_CONFLICT",
    );
  });

  it("decide continues by advancing iteration and state; done stays", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: {}, state: { n: 0 } });
    const first = h.store.loops.decide({
      identity,
      iteration: 1,
      result: { ok: false },
      done: false,
      nextState: { n: 1 },
    });
    expect(first.duplicate).toBe(false);
    expect(first.loop.iteration).toBe(2);
    expect(first.loop.state).toEqual({ n: 1 });
    expect(first.loop.rounds).toHaveLength(1);
    const second = h.store.loops.decide({
      identity,
      iteration: 2,
      result: { ok: true },
      done: true,
    });
    expect(second.loop.iteration).toBe(2);
    expect(second.loop.state).toEqual({ n: 1 });
    expect(second.loop.rounds.at(-1)?.done).toBe(true);
  });

  it("duplicate identical decide is a no-op; conflicting/stale rejects; no decisions after done", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: {}, state: {} });
    h.store.loops.decide({ identity, iteration: 1, result: 1, done: false });
    const before = h.store.events.list(h.runId).length;
    const dup = h.store.loops.decide({ identity, iteration: 1, result: 1, done: false });
    expect(dup.duplicate).toBe(true);
    expect(h.store.events.list(h.runId).length).toBe(before);
    expectCode(
      () => h.store.loops.decide({ identity, iteration: 1, result: 2, done: false }),
      "E_CONFLICT",
    );
    expectCode(
      () => h.store.loops.decide({ identity, iteration: 3, result: 1, done: false }),
      "E_CONFLICT",
    );
    h.store.loops.decide({ identity, iteration: 2, result: 1, done: true });
    expectCode(
      () => h.store.loops.decide({ identity, iteration: 2, result: 2, done: true }),
      "E_CONFLICT",
    );
    expectCode(
      () => h.store.loops.decide({ identity, iteration: 3, result: 1, done: false }),
      "E_CONFLICT",
    );
  });

  it("rolls back the whole decide when the outer transaction fails and replays", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: {}, state: {} });
    const before = h.store.events.list(h.runId).length;
    expect(() =>
      h.store.tx(() => {
        h.store.loops.decide({ identity, iteration: 1, result: 1, done: false });
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");
    expect(h.store.events.list(h.runId).length).toBe(before);
    expect(h.store.view.get(h.runId).executions.refine?.loop?.rounds).toHaveLength(0);
    h.store.loops.decide({ identity, iteration: 1, result: 1, done: false });
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt.executions.refine?.loop?.iteration).toBe(2);
    expect(rebuilt.executions.refine?.loop?.rounds).toHaveLength(1);
  });

  it("rejects stale invocation, non-loop kind, and terminal runs", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: {}, state: {} });
    expectCode(
      () =>
        h.store.loops.decide({
          identity: { ...identity, generation: 99 },
          iteration: 1,
          result: 1,
          done: false,
        }),
      "E_CONFLICT",
    );
    const other = "other" as Path;
    h.store.executions.ensure({
      runId: h.runId,
      path: other,
      nodeId: "other",
      kind: "gate",
      requireSubmission: false,
    });
    const gateIdentity = h.store.executions.beginInvocation({
      runId: h.runId,
      path: other,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    expectCode(
      () => h.store.loops.start({ identity: gateIdentity, parent: {}, state: {} }),
      "E_CONFLICT",
    );
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "run.cancelled",
        actor: "user",
        payload: { by: "t" },
      } as never,
    ]);
    expectCode(
      () => h.store.loops.decide({ identity, iteration: 1, result: 1, done: false }),
      "E_CONFLICT",
    );
  });

  it("rejects oversize and secret-bearing inputs without redaction", () => {
    const h = harness();
    const secretStore = harness();
    try {
      const identity = beginLoop(h);
      expectCode(
        () =>
          h.store.loops.decide({
            identity,
            iteration: 1,
            result: { x: "a".repeat(20 * 1024) },
            done: false,
          }),
        "E_VALIDATION",
      );
      const unregister = secretStore.store.security.registerSecret("s3cr3t-loop", "test");
      const sid = beginLoop(secretStore);
      expectCode(
        () =>
          secretStore.store.loops.start({ identity: sid, parent: {}, state: { v: "s3cr3t-loop" } }),
        "E_VALIDATION",
      );
      unregister();
    } finally {
      secretStore.close();
    }
  });

  it("requires done decision plus recorded output before completing the controller", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: {}, state: {} });
    expectCode(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.loops.decide({ identity, iteration: 1, result: 1, done: false });
    expectCode(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.loops.decide({ identity, iteration: 2, result: 2, done: true });
    expectCode(() => h.store.executions.complete({ identity }), "E_CONFLICT");
    h.store.outputs.recordDeterministic({ identity, output: { result: 2, iterations: 2 } });
    const done = h.store.executions.complete({ identity });
    expect(done.status).toBe("succeeded");
  });

  it("retains loop state across generation increment and parks during child approval", () => {
    const h = harness();
    const identity = beginLoop(h);
    h.store.loops.start({ identity, parent: { p: 1 }, state: { n: 0 } });
    h.store.loops.decide({ identity, iteration: 1, result: 1, done: false, nextState: { n: 1 } });
    // Simulate crash recovery: running controller interrupts, then resumes with a new generation.
    h.store.recovery.recover(h.runId);
    const resumed = h.store.executions.beginInvocation({
      runId: h.runId,
      path: "refine" as Path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    const loop = h.store.view.get(h.runId).executions.refine?.loop;
    expect(loop?.iteration).toBe(2);
    expect(loop?.state).toEqual({ n: 1 });
    // Child waiting_approval parks the running controller instead of interrupting it.
    const child = "refine#2/approval" as Path;
    h.store.executions.ensure({
      runId: h.runId,
      path: child,
      nodeId: "approval",
      kind: "approval",
      requireSubmission: false,
    });
    const childId = h.store.executions.beginInvocation({
      runId: h.runId,
      path: child,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    h.store.approvals.request({ identity: childId, message: "ok?" });
    const report = h.store.recovery.recover(h.runId);
    const controller = report.executions.find((e) => String(e.path) === "refine");
    expect(controller?.to).toBe("running");
    expect(controller?.applied).toBe(false);
    expect(resumed.generation).toBeGreaterThan(identity.generation);
  });
});
