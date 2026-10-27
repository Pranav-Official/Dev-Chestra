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
import { describe, expect, it } from "vitest";
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

describe("approval restart", () => {
  it("restart after resolve before wake dispatches via reconcile (deterministic barrier)", async () => {
    const temp = mkdtempSync(join(tmpdir(), "relay-approval-restart-"));
    const home = mkdtempSync(join(tmpdir(), "relay-home-r-"));
    const store = openStore({ file: join(temp, "db.sqlite") });
    store.projects.ensure({ id: "p1", name: "P1", path: temp, kind: "folder" });
    const mkEngine = () =>
      createEngine({
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
        env: { HOME: home, PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv,
      });
    const engine = mkEngine();
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
    for (let i = 0; i < 50; i++)
      if (store.view.get(r.value.runId as never).executions.a1?.status === "waiting_approval")
        break;
      else await new Promise((rr) => setTimeout(rr, 20));
    const pend = store.approvals.listPending({ runId: r.value.runId as never })[0]!;
    const ex = store.executions.get(r.value.runId as never, "a1" as never)!;
    await engine.stop();
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
    const engine2 = mkEngine();
    await engine2.start();
    for (let i = 0; i < 50; i++)
      if (store.view.get(r.value.runId as never).status === "succeeded") break;
      else await new Promise((rr) => setTimeout(rr, 20));
    expect(store.view.get(r.value.runId as never).status).toBe("succeeded");
    await engine2.stop();
    store.close();
    rmSync(temp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("interrupted shell safety: wake does not auto-restart shell", async () => {
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
    try {
      await engine.start();
      const wf = makeWorkflow(
        [startNode(), approvalNode("a1"), shellNode("sh", "echo hi"), endNode()],
        [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "sh" },
          { id: "e3", from: "sh", to: "end" },
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
      for (let i = 0; i < 50; i++) {
        const v = store.view.get(r.value.runId as never);
        if (v.executions.sh?.status === "running" || v.executions.sh?.status === "interrupted")
          break;
        else await new Promise((rr) => setTimeout(rr, 10));
      }
      const shExec = store.executions.get(r.value.runId as never, "sh" as never);
      if (shExec && shExec.status === "running") {
        store.events.append(r.value.runId as never, [
          {
            runId: r.value.runId as never,
            path: "sh" as never,
            type: "node.state" as never,
            actor: "engine" as never,
            payload: {
              from: "running",
              to: "interrupted",
              attempt: shExec.attempt,
              generation: shExec.generation,
            },
          } as never,
        ]);
      }
      expect(store.view.get(r.value.runId as never).executions.sh?.status).toBe("interrupted");
      await new Promise((rr) => setTimeout(rr, 50));
      expect(store.view.get(r.value.runId as never).status).not.toBe("succeeded");
    } finally {
      await engine.stop();
      store.close();
      rmSync(temp, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
