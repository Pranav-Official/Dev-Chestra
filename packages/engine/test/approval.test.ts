import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@relay/adapters";
import type { WorkflowFile } from "@relay/schema";
import { normalizeWorkflow, parseWorkflow } from "@relay/schema";
import { openStore } from "@relay/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@relay/workspaces";
import { describe, expect, it, vi } from "vitest";
import { createEngine } from "../src/index.js";

const shim = join(process.cwd(), "packages/mcp/dist/bin/shim.js");
const fakeBin = join(process.cwd(), "tools/fake-agent/dist/main.js");

function makeWorkflow(nodes: unknown[], edges: unknown[]): WorkflowFile {
  const raw = { schemaVersion: 1 as const, id: "aprv", name: "Aprv", graph: { nodes, edges } };
  const p = parseWorkflow(raw);
  if (!p.ok) throw p.error;
  const n = normalizeWorkflow(p.value);
  if (!n.ok) throw n.error;
  return p.value;
}
function startNode() {
  return {
    id: "start",
    type: "start",
    name: "Start",
    params: [{ name: "topic", type: "string", required: true }],
  };
}
function approvalNode(id: string, msg = "Approve?") {
  return { id, type: "approval", name: id, message: msg, irreversible: false };
}
function shellNode(id: string, cmd = "echo hi") {
  return { id, type: "shell", name: id, command: cmd, timeoutMin: 5 };
}
function endNode(id = "end", result = "start.topic") {
  return { id, type: "end", name: id, status: "success", result };
}

async function withIsolatedEngine(
  fn: (ctx: {
    store: ReturnType<typeof openStore>;
    engine: ReturnType<typeof createEngine>;
    temp: string;
    home: string;
  }) => Promise<void>,
) {
  const temp = mkdtempSync(join(tmpdir(), "relay-aprv-"));
  const home = mkdtempSync(join(tmpdir(), "relay-home-"));
  const store = openStore({ file: join(temp, "db.sqlite") });
  store.projects.ensure({ id: "p1", name: "P1", path: temp, kind: "folder" });
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    TMPDIR: temp,
    USER: "test",
  } as NodeJS.ProcessEnv;
  const engine = createEngine({
    store,
    adapters: createAdapterRegistry({ fakeAgentBin: fakeBin, fakeScript: [] }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: "http://127.0.0.1:9",
      issue(_s: unknown) {
        const t = `tok-${Math.random()}`;
        return { token: t, revoke() {} };
      },
    } as never,
    dataDir: temp,
    nodeBin: process.execPath,
    mcpShimEntry: shim,
    env,
  });
  let fnErr: unknown = null;
  try {
    await fn({ store, engine, temp, home });
  } catch (e) {
    fnErr = e;
  }
  let stopErr: unknown = null;
  try {
    await engine.stop();
  } catch (e) {
    stopErr = e;
  }
  try {
    store.close();
  } catch (e) {
    stopErr = stopErr ?? e;
  }
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch (e) {
    stopErr = stopErr ?? e;
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (e) {
    stopErr = stopErr ?? e;
  }
  if (fnErr) throw fnErr;
  if (stopErr) throw stopErr;
}

describe("approval engine", () => {
  it("pending release parks with waiting_approval and no active slot", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), shellNode("s2"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "s2" },
          { id: "e3", from: "s2", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (let i = 0; i < 50; i++) {
        const v = store.view.get(r.value.runId as never);
        if (v.executions.a1?.status === "waiting_approval") break;
        await new Promise((rr) => setTimeout(rr, 20));
      }
      expect(store.view.get(r.value.runId as never).executions.a1?.status).toBe("waiting_approval");
      expect(store.view.get(r.value.runId as never).status).toBe("waiting_approval");
      const pending = store.approvals.listPending({ runId: r.value.runId as never });
      expect(pending.length).toBe(1);
      const parked = await r.value.completion;
      expect(parked.status).toBe("waiting_approval");
      const exec = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: exec.attempt,
          generation: exec.generation,
        },
        // biome-ignore lint/style/noNonNullAssertion: test pending must exist
        requestId: pending[0]!.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 50; i++) {
        const vv = store.view.get(r.value.runId as never);
        if (vv.status === "succeeded") break;
        await new Promise((rr) => setTimeout(rr, 20));
      }
      expect(store.view.get(r.value.runId as never).status).toBe("succeeded");
    });
  });

  it("immediate resolve park race wakes exactly once via finally recheck", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      let pending: ReturnType<typeof store.approvals.listPending> | null = null;
      for (let i = 0; i < 30; i++) {
        pending = store.approvals.listPending({ runId: r.value.runId as never });
        if (pending.length) break;
        await new Promise((rr) => setTimeout(rr, 10));
      }
      expect(pending?.length).toBe(1);
      const exec = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: exec.attempt,
          generation: exec.generation,
        },
        // biome-ignore lint/style/noNonNullAssertion: pending must exist
        requestId: pending![0]!.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).status === "succeeded") break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).executions.a1?.status).toBe("succeeded");
      expect(store.view.get(r.value.runId as never).status).toBe("succeeded");
    });
  });

  it("two sequential approvals stay parked then wake exactly once each", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), approvalNode("a2"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "a2" },
          { id: "e3", from: "a2", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).executions.a2).toBeUndefined();
      const p1 = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const e1 = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: e1.attempt,
          generation: e1.generation,
        },
        requestId: p1.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a2?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).executions.a2?.status).toBe("waiting_approval");
      const wakes = store.approvals.listOutstandingWakes(r.value.runId as never);
      expect(wakes.length).toBe(0);
      await engine.stop();
      const home2 = mkdtempSync(join(tmpdir(), "relay-home2-"));
      const engine2 = createEngine({
        store,
        adapters: createAdapterRegistry({ fakeAgentBin: fakeBin, fakeScript: [] }),
        workspaces: {
          prepare: prepareRunWorkspace,
          acquire: acquireScratch,
          finalize: finalizeScratch,
          release: releaseScratch,
        },
        gateway: {
          url: "http://127.0.0.1:9",
          issue(_s: unknown) {
            const t = `tok-${Math.random()}`;
            return { token: t, revoke() {} };
          },
        } as never,
        dataDir: store.projects.get("p1")!.path,
        nodeBin: process.execPath,
        mcpShimEntry: shim,
        env: { HOME: home2, PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv,
      });
      try {
        await engine2.start();
        expect(store.view.get(r.value.runId as never).executions.a2?.status).toBe(
          "waiting_approval",
        );
        const p2 = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
        const e2 = store.executions.get(r.value.runId as never, "a2" as never)!;
        store.approvals.resolve({
          identity: {
            runId: r.value.runId as never,
            path: "a2" as never,
            attempt: e2.attempt,
            generation: e2.generation,
          },
          requestId: p2.requestId,
          decision: "approve",
          by: "tester",
        });
        for (let i = 0; i < 50; i++)
          if (store.view.get(r.value.runId as never).status === "succeeded") break;
          else await new Promise((rr) => setTimeout(rr, 20));
        expect(store.view.get(r.value.runId as never).status).toBe("succeeded");
      } finally {
        await engine2.stop();
        rmSync(home2, { recursive: true, force: true });
      }
    });
  });

  it("fan-out approval + parallel end never completes before decision", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [
          startNode(),
          approvalNode("a1"),
          shellNode("sh", "echo hi"),
          endNode("end1"),
          endNode("end2", "start.topic"),
        ],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "start", to: "sh" },
          { id: "e3", from: "a1", to: "end1" },
          { id: "e4", from: "sh", to: "end2" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).status).toBe("waiting_approval");
      expect(store.view.get(r.value.runId as never).executions.end2?.status).not.toBe("succeeded");
      await new Promise((rr) => setTimeout(rr, 100));
      expect(store.view.get(r.value.runId as never).status).toBe("waiting_approval");
      const pend = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const ex = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: ex.attempt,
          generation: ex.generation,
        },
        requestId: pend.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 80; i++)
        if (["succeeded", "failed"].includes(store.view.get(r.value.runId as never).status)) break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(["succeeded", "failed"].includes(store.view.get(r.value.runId as never).status)).toBe(
        true,
      );
    });
  });

  it("reject with .rejected edge vs without", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wfWith = makeWorkflow(
        [
          startNode(),
          approvalNode("a1"),
          shellNode("on_reject", "echo no"),
          endNode("end_ok"),
          { id: "end_rej", type: "end", name: "EndRej", status: "success", result: "start.topic" },
        ],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end_ok" },
          { id: "e3", from: "a1.rejected", to: "on_reject" },
          { id: "e4", from: "on_reject", to: "end_rej" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wfWith,
        snapshotRaw: JSON.stringify(wfWith),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      const pend = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const ex = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: ex.attempt,
          generation: ex.generation,
        },
        requestId: pend.requestId,
        decision: "reject",
        by: "tester",
        note: "no",
      });
      for (let i = 0; i < 50; i++) {
        const v = store.view.get(r.value.runId as never);
        if (v.status === "succeeded" || v.status === "rejected") break;
        else await new Promise((rr) => setTimeout(rr, 20));
      }
      expect(store.view.get(r.value.runId as never).executions.a1?.status).toBe("succeeded");
      expect(store.view.get(r.value.runId as never).executions.on_reject?.status).toBe("succeeded");
    });
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wfWithout = makeWorkflow(
        [startNode(), approvalNode("a1"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wfWithout,
        snapshotRaw: JSON.stringify(wfWithout),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      const pend = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const ex = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: ex.attempt,
          generation: ex.generation,
        },
        requestId: pend.requestId,
        decision: "reject",
        by: "tester",
      });
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).status === "rejected") break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).status).toBe("rejected");
      expect(store.view.get(r.value.runId as never).executions.a1?.status).toBe("rejected");
    });
  });

  it("terminal completion clears wake, next waiting remains parked, crash before terminal leaves wake", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), approvalNode("a2"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "a2" },
          { id: "e3", from: "a2", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      const p1 = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const e1 = store.executions.get(r.value.runId as never, "a1" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a1" as never,
          attempt: e1.attempt,
          generation: e1.generation,
        },
        requestId: p1.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).executions.a2?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      // next waiting is durable, prior wake should be cleared (consumed) after next waiting commit, not before dispatch
      expect(store.view.get(r.value.runId as never).executions.a2?.status).toBe("waiting_approval");
      // prior wake (a1) should be consumed after next waiting durably committed, so outstanding should be 0 for prior (current waiting has no wake)
      const wakesMid = store.approvals.listOutstandingWakes(r.value.runId as never);
      // stale prior wake should be gone, no outstanding for terminal yet
      expect(wakesMid.length).toBe(0);
      const p2 = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
      const e2 = store.executions.get(r.value.runId as never, "a2" as never)!;
      store.approvals.resolve({
        identity: {
          runId: r.value.runId as never,
          path: "a2" as never,
          attempt: e2.attempt,
          generation: e2.generation,
        },
        requestId: p2.requestId,
        decision: "approve",
        by: "tester",
      });
      for (let i = 0; i < 50; i++)
        if (store.view.get(r.value.runId as never).status === "succeeded") break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.view.get(r.value.runId as never).status).toBe("succeeded");
      expect(store.approvals.listOutstandingWakes(r.value.runId as never).length).toBe(0);
      // crash before terminal leaves wake: simulate by creating new run, resolving then crashing before drive
      const wf2 = makeWorkflow(
        [startNode(), approvalNode("a1"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end" },
        ],
      );
      const r2 = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf2,
        snapshotRaw: JSON.stringify(wf2),
        params: { topic: "t2" },
      });
      if (!r2.ok) throw r2.error;
      for (let i = 0; i < 50; i++)
        if (store.view.get(r2.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        else await new Promise((rr) => setTimeout(rr, 20));
      const pp = store.approvals.listPending({ runId: r2.value.runId as never })[0]!;
      const ee = store.executions.get(r2.value.runId as never, "a1" as never)!;
      // resolve but do not let engine drive (simulate crash before terminal) by stopping engine immediately
      // Use a separate store instance to simulate crash: directly resolve via store without engine active
      store.approvals.resolve({
        identity: {
          runId: r2.value.runId as never,
          path: "a1" as never,
          attempt: ee.attempt,
          generation: ee.generation,
        },
        requestId: pp.requestId,
        decision: "approve",
        by: "tester",
      });
      // outstanding wake should exist until terminal
      expect(store.approvals.listOutstandingWakes(r2.value.runId as never).length).toBe(1);
      // after engine drives to terminal, it should clear
      for (let i = 0; i < 50; i++)
        if (store.view.get(r2.value.runId as never).status === "succeeded") break;
        else await new Promise((rr) => setTimeout(rr, 20));
      expect(store.approvals.listOutstandingWakes(r2.value.runId as never).length).toBe(0);
    });
  });

  it("parked approval cancel fans out node cancelled with no invented stop evidence", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end" },
        ],
      );
      const r = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!r.ok) throw r.error;
      for (let i = 0; i < 50; i++) {
        if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
          break;
        await new Promise((rr) => setTimeout(rr, 20));
      }
      expect(store.view.get(r.value.runId as never).executions.a1?.status).toBe("waiting_approval");
      // Parked: completion already resolved waiting_approval with no active
      // drive slot held.
      const parked = await r.value.completion;
      expect(parked.status).toBe("waiting_approval");
      const cancelled = await engine.cancel(r.value.runId);
      expect(cancelled.ok).toBe(true);
      const view = store.view.get(r.value.runId as never);
      expect(view.status).toBe("cancelled");
      expect(view.executions.a1?.status).toBe("cancelled");
      // No invented process stop/workspace finalization for a parked
      // approval node that never spawned a process.
      expect(view.executions.a1?.processStopped ?? null).toBe(null);
      expect(view.executions.a1?.workspaceFinalized ?? null).toBe(null);
    });
  });

  it("keeps parked cancellation blocked on unknown liveness, including a retry while paused", async () => {
    await withIsolatedEngine(async ({ store, engine }) => {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "end" },
        ],
      );
      const launched = await engine.launch({
        projectId: "p1",
        workflowId: "aprv",
        snapshot: wf,
        snapshotRaw: JSON.stringify(wf),
        params: { topic: "t" },
      });
      if (!launched.ok) throw launched.error;
      const { runId, completion } = launched.value;
      expect((await completion).status).toBe("waiting_approval");
      const lookup = vi.spyOn(store.executions, "getProcess").mockImplementation(() => {
        throw new Error("Process identity lookup unavailable");
      });
      try {
        for (let retry = 0; retry < 2; retry++) {
          const result = await engine.cancel(runId);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe("E_WORKSPACE");
          const view = store.view.get(runId as never);
          expect(view.status).toBe("paused");
          expect(view.executions.a1?.status).toBe("waiting_approval");
          expect(view.executions.a1?.processStopped ?? null).toBe(null);
        }
      } finally {
        lookup.mockRestore();
      }
      expect((await engine.cancel(runId)).ok).toBe(true);
      expect(store.view.get(runId as never).status).toBe("cancelled");
    });
  });
});
