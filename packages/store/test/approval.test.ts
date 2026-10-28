import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevChestraError, FakeClock, FakeIdGen, type Path } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";

function harness(snapshot?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-approval-"));
  const file = join(dir, "devchestra.db");
  const clock = new FakeClock(1_700_000_000_000);
  const store = openStore({ file, clock, idGen: new FakeIdGen("t") });
  store.projects.ensure({ id: "proj", name: "P", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "wf",
    workflowHash: "h",
    snapshot: (snapshot as never) ?? {
      graph: { nodes: [{ id: "a", type: "approval" }], edges: [] },
    },
    snapshotRaw: JSON.stringify(snapshot ?? {}),
    params: {},
    budgets: {},
  });
  store.executions.ensure({ runId: run.runId, path: "a" as Path, nodeId: "a", kind: "approval" });
  const id = store.executions.beginInvocation({
    runId: run.runId,
    path: "a" as Path,
    attempt: 1,
    resolvedConfigHash: "cfg",
  });
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir,
    file,
    clock,
    store,
    runId: run.runId,
    id,
    markClosed: () => {
      closed = true;
    },
    cleanup,
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (fn) fn();
  }
});

describe("approval store", () => {
  it("duplicate request idempotent vs conflict", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const r1 = h.store.approvals.request({
      identity: h.id,
      message: "hi",
      irreversible: false,
      criteria: ["c1"],
    });
    expect(r1.duplicate).toBe(false);
    const r2 = h.store.approvals.request({
      identity: h.id,
      message: "hi",
      irreversible: false,
      criteria: ["c1"],
    });
    expect(r2.duplicate).toBe(true);
    expect(r2.requestId).toBe(r1.requestId);
    expect(h.store.events.list(h.runId).filter((e) => e.type === "approval.requested").length).toBe(
      1,
    );
    expect(() => h.store.approvals.request({ identity: h.id, message: "different" })).toThrow(
      DevChestraError,
    );
  });

  it("secret in message rejected before insert", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const sentinel = "sentinel-SECRET-999";
    h.store.security.registerSecret(sentinel, "s");
    const before = h.store.events.list(h.runId).length;
    expect(() =>
      h.store.approvals.request({ identity: h.id, message: `prefix ${sentinel} suffix` }),
    ).toThrow(DevChestraError);
    expect(h.store.events.list(h.runId).length).toBe(before);
    expect(h.store.approvals.listPending({ runId: h.runId }).length).toBe(0);
  });

  it("secret in criteria/note rolls back no pending", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const sentinel = "sentinel-CRIT-111";
    h.store.security.registerSecret(sentinel, "s");
    expect(() =>
      h.store.approvals.request({ identity: h.id, message: "m", criteria: [sentinel] }),
    ).toThrow(DevChestraError);
    expect(h.store.approvals.listPending({ runId: h.runId }).length).toBe(0);
    const req = h.store.approvals.request({ identity: h.id, message: "clean" });
    expect(() =>
      h.store.approvals.resolve({
        identity: h.id,
        requestId: req.requestId,
        decision: "approve",
        by: "u",
        note: sentinel,
      }),
    ).toThrow(DevChestraError);
    expect(h.store.view.get(h.runId).executions["a"]?.status).toBe("waiting_approval");
  });

  it("resolve duplicate returns original ids even after terminal, conflict on note", () => {
    const snap = {
      graph: { nodes: [{ id: "a", type: "approval" }], edges: [{ id: "e1", from: "a", to: "b" }] },
    };
    const h = harness(snap);
    cleanups.push(h.cleanup);
    const req = h.store.approvals.request({ identity: h.id, message: "m" });
    const res = h.store.approvals.resolve({
      identity: h.id,
      requestId: req.requestId,
      decision: "reject",
      by: "u",
    });
    expect(res.runCompletedEventId).not.toBeNull();
    expect(h.store.view.get(h.runId).status).toBe("rejected");
    const dup = h.store.approvals.resolve({
      identity: h.id,
      requestId: req.requestId,
      decision: "reject",
      by: "u",
    });
    expect(dup.duplicate).toBe(true);
    expect(dup.resolvedEventId).toBe(res.resolvedEventId);
    expect(() =>
      h.store.approvals.resolve({
        identity: h.id,
        requestId: req.requestId,
        decision: "reject",
        by: "u",
        note: "x",
      }),
    ).toThrow(DevChestraError);
  });

  it("stale requestId and legacy null not resolvable", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const _req = h.store.approvals.request({ identity: h.id, message: "m" });
    void _req;
    expect(() =>
      h.store.approvals.resolve({
        identity: h.id,
        requestId: "fake",
        decision: "approve",
        by: "u",
      }),
    ).toThrow(DevChestraError);
    const dir = mkdtempSync(join(tmpdir(), "devchestra-legacy-"));
    const file = join(dir, "devchestra.db");
    const clock = new FakeClock(1_700_000_000_000);
    const store = openStore({ file, clock, idGen: new FakeIdGen("t") });
    const runStoreCleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    cleanups.push(runStoreCleanup);
    store.projects.ensure({ id: "proj", name: "P", path: dir, kind: "folder" });
    const run = store.runs.create({
      projectId: "proj",
      workflowId: "wf",
      workflowHash: "h",
      snapshot: {},
      snapshotRaw: "{}",
      params: {},
      budgets: {},
    });
    store.executions.ensure({ runId: run.runId, path: "a" as Path, nodeId: "a", kind: "approval" });
    const id = store.executions.beginInvocation({
      runId: run.runId,
      path: "a" as Path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    store.events.append(run.runId, [
      {
        runId: run.runId,
        path: "a" as Path,
        type: "approval.requested",
        actor: "engine",
        payload: { message: "legacy", irreversible: false, autoApprove: false },
      } as never,
      {
        runId: run.runId,
        path: "a" as Path,
        type: "node.state",
        actor: "engine",
        payload: { from: "running", to: "waiting_approval", attempt: 1, generation: 2 },
      } as never,
    ]);
    const view = store.view.get(run.runId);
    expect(view.executions["a"]?.approvalRequest?.requestId).toBeNull();
    expect(() =>
      store.approvals.resolve({
        identity: id,
        requestId: "fabricated",
        decision: "approve",
        by: "u",
      }),
    ).toThrow(DevChestraError);
  });

  it("wake survives crash until atomically consumed with next step", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const req = h.store.approvals.request({ identity: h.id, message: "m" });
    h.store.approvals.resolve({
      identity: h.id,
      requestId: req.requestId,
      decision: "approve",
      by: "u",
    });
    expect(h.store.approvals.listOutstandingWakes(h.runId).length).toBe(1);
    h.store.close();
    h.markClosed();
    const reopened = openStore({ file: h.file, clock: h.clock, idGen: new FakeIdGen("t2") });
    cleanups.push(() => {
      reopened.close();
      rmSync(h.dir, { recursive: true, force: true });
    });
    expect(reopened.approvals.listOutstandingWakes(h.runId).length).toBe(1);
    reopened.tx(() => {
      const ok = reopened.approvals.consumeWake(h.id, req.requestId);
      expect(ok).toBe(true);
      reopened.events.append(h.runId, [
        {
          runId: h.runId,
          path: "b" as Path,
          type: "node.state",
          actor: "engine",
          payload: {
            from: "pending",
            to: "ready",
            attempt: 1,
            generation: 1,
            init: { kind: "agent", requireSubmission: true },
          },
        } as never,
      ]);
    });
    expect(reopened.approvals.listOutstandingWakes(h.runId).length).toBe(0);
    reopened.close();
    // need to prevent double cleanup of h.dir already scheduled; remove last cleanup and recreate
    cleanups.pop();
    const r2 = openStore({ file: h.file, clock: h.clock, idGen: new FakeIdGen("t3") });
    expect(r2.approvals.listOutstandingWakes(h.runId).length).toBe(0);
    r2.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("rejected without edge leaves no wake (terminal)", () => {
    const snap = {
      graph: { nodes: [{ id: "a", type: "approval" }], edges: [{ id: "e1", from: "a", to: "b" }] },
    };
    const h = harness(snap);
    cleanups.push(h.cleanup);
    const req = h.store.approvals.request({ identity: h.id, message: "m" });
    const res = h.store.approvals.resolve({
      identity: h.id,
      requestId: req.requestId,
      decision: "reject",
      by: "u",
    });
    expect(res.runCompletedEventId).not.toBeNull();
    expect(h.store.view.get(h.runId).status).toBe("rejected");
    expect(h.store.approvals.listOutstandingWakes(h.runId).length).toBe(0);
    h.store.close();
    h.markClosed();
    const reopened = openStore({ file: h.file, clock: h.clock, idGen: new FakeIdGen("t2") });
    expect(reopened.approvals.listOutstandingWakes(h.runId).length).toBe(0);
    reopened.close();
    rmSync(h.dir, { recursive: true, force: true });
    cleanups.pop();
  });

  it("stale old request after new attempt is E_CONFLICT, new request works and rebuild matches", () => {
    const snap = {
      graph: {
        nodes: [{ id: "a", type: "approval" }],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "a.rejected", to: "c" },
        ],
      },
    };
    const h = harness(snap);
    cleanups.push(h.cleanup);
    const id1 = h.id;
    const req1 = h.store.approvals.request({ identity: id1, message: "first" });
    h.store.approvals.resolve({
      identity: id1,
      requestId: req1.requestId,
      decision: "approve",
      by: "u",
    });
    // new logical attempt
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "a" as Path,
        type: "node.state",
        actor: "engine",
        payload: { from: "succeeded", to: "pending", attempt: 2, generation: 1 },
      } as never,
    ]);
    const id2 = h.store.executions.beginInvocation({
      runId: h.runId,
      path: "a" as Path,
      attempt: 2,
      resolvedConfigHash: "cfg",
    });
    const req2 = h.store.approvals.request({ identity: id2, message: "second" });
    expect(req2.requestId).not.toBe(req1.requestId);
    expect(() =>
      h.store.approvals.resolve({
        identity: id2,
        requestId: req1.requestId,
        decision: "approve",
        by: "u",
      }),
    ).toThrow(DevChestraError);
    const res2 = h.store.approvals.resolve({
      identity: id2,
      requestId: req2.requestId,
      decision: "reject",
      by: "u",
      note: "n",
    });
    expect(res2.duplicate).toBe(false);
    // stale old identity cannot resolve new attempt
    expect(() =>
      h.store.approvals.resolve({
        identity: id1,
        requestId: req1.requestId,
        decision: "approve",
        by: "u",
      }),
    ).toThrow(DevChestraError);
    // exact replay after terminal of attempt2 still duplicate (same identity)
    const dup = h.store.approvals.resolve({
      identity: id2,
      requestId: req2.requestId,
      decision: "reject",
      by: "u",
      note: "n",
    });
    expect(dup.duplicate).toBe(true);
    expect(dup.resolvedEventId).toBe(res2.resolvedEventId);
    // rebuild matches
    const view = h.store.view.get(h.runId);
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt).toEqual(view);
    expect(rebuilt.executions["a"]?.approvalRequest?.requestId).toBe(req2.requestId);
    expect(rebuilt.executions["a"]?.approvalDecision?.requestId).toBe(req2.requestId);
  });

  it("cancel blocks resolve", () => {
    const h = harness();
    cleanups.push(h.cleanup);
    const req = h.store.approvals.request({ identity: h.id, message: "m" });
    h.store.events.append(h.runId, [
      {
        runId: h.runId,
        path: "" as Path,
        type: "run.cancelled",
        actor: "user",
        payload: { by: "t" },
      } as never,
    ]);
    expect(() =>
      h.store.approvals.resolve({
        identity: h.id,
        requestId: req.requestId,
        decision: "approve",
        by: "u",
      }),
    ).toThrow(DevChestraError);
  });
});
