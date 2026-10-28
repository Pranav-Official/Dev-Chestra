import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Path } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { acquireScratch, finalizeScratch, releaseScratch } from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { countNoSubmit, finalizeAccepted } from "../src/agent-support.js";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { analyzeLinearWorkflow } from "../src/sequence.js";

const fixture = {
  schemaVersion: 1,
  id: "linear",
  name: "linear",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      {
        id: "research",
        type: "agent",
        name: "Research",
        cli: "fake",
        prompt: "go",
        output: { type: "object", properties: { summary: { type: "string" } } },
        permissions: { network: false, write: [] },
        workspace: { mode: "scratch" },
        limits: { timeoutMin: 1, validationRetries: 1, crashRetries: 0 },
        context: { project: "none", workflow: "none" },
      },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ],
    edges: [
      { id: "e1", from: "start", to: "research" },
      { id: "e2", from: "research", to: "end" },
    ],
  },
};

const tempDirs: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-engine-support-"));
  tempDirs.push(dir);
  return dir;
}

function context(store: Store, dataDir: string): EngineContext {
  return new EngineContext({
    store,
    adapters: {
      get() {
        throw new Error("not used");
      },
      has: () => false,
      ids: () => [],
    },
    workspaces: { acquire: acquireScratch, finalize: finalizeScratch, release: releaseScratch },
    gateway: {
      url: "http://127.0.0.1:1",
      issue() {
        throw new Error("not used");
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: "/unused",
  });
}

function seed(store: Store, dataDir: string) {
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const created = store.runs.create({
    projectId: "p1",
    workflowId: "linear",
    workflowHash: "hash",
    snapshot: fixture,
    snapshotRaw: JSON.stringify(fixture),
    params: {},
  });
  const chain = analyzeLinearWorkflow(fixture);
  if (!chain.ok) throw chain.error;
  const node = chain.value.nodes[1];
  if (node === undefined) throw new Error("missing research node");
  return { runId: created.runId, chain: chain.value, node };
}

function accept(store: Store, runId: string) {
  const execution = store.executions.ensure({
    runId: runId as never,
    path: "research" as Path,
    nodeId: "research",
    kind: "agent",
    validationLimit: 2,
  });
  const identity = store.executions.beginInvocation({
    runId: runId as never,
    path: "research" as Path,
    attempt: execution.attempt,
  });
  store.submissions.submit({
    identity,
    callId: "valid-1",
    request: { name: "submit_result", arguments: { summary: "ok" } },
    ok: true,
    output: { summary: "ok" },
    schemaHash: "schema",
  });
  return identity;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable no-submit counting", () => {
  it("counts committed E_NO_SUBMIT receipts, not state events", () => {
    const dataDir = temp();
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    try {
      const { runId } = seed(store, dataDir);
      const execution = store.executions.ensure({
        runId: runId as never,
        path: "research" as Path,
        nodeId: "research",
        kind: "agent",
        validationLimit: 3,
      });
      const identity = store.executions.beginInvocation({
        runId: runId as never,
        path: "research" as Path,
        attempt: execution.attempt,
      });
      const ctx = context(store, dataDir);
      expect(countNoSubmit(ctx, runId, "research", 1)).toBe(0);
      const submit = {
        identity,
        callId: "engine-no-submit-1-2",
        request: { name: "devchestra.engine.no_submit", arguments: {} },
        ok: false as const,
        errors: [{ path: "/", message: "no submit" }],
        errorCode: "E_NO_SUBMIT",
      };
      store.submissions.submit(submit);
      store.submissions.submit(submit);
      expect(countNoSubmit(ctx, runId, "research", 1)).toBe(1);
      expect(
        store.events
          .list(runId as never)
          .some(
            (event) =>
              event.type === "node.state" &&
              (event.payload as { reason?: string }).reason === "no_submit",
          ),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("accepted finalization without a workspace", () => {
  it("pauses and refuses to recreate a missing accepted workspace", async () => {
    const dataDir = temp();
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    try {
      const { runId, node } = seed(store, dataDir);
      const identity = accept(store, runId);
      const run = store.runs.get(runId);
      if (run === null) throw new Error("missing run");
      const active: ActiveRunState = {
        abort: new AbortController(),
        reason: null,
        tokens: new Set(),
      };
      await expect(
        finalizeAccepted(
          context(store, dataDir),
          run,
          node,
          active,
          {
            runId,
            path: "research" as Path,
            outputId: "out",
            outputHash: "hash",
            schemaHash: "schema",
            attempt: identity.attempt,
            generation: identity.generation,
            acceptedEventId: 0,
          },
          undefined,
        ),
      ).rejects.toMatchObject({ code: "E_WORKSPACE" });
      const view = store.view.get(runId);
      expect(view.status).toBe("paused");
      expect(view.pauseReason).toBe("shutdown");
      expect(view.executions.research?.status).toBe("validating");
      expect(() =>
        statSync(join(dataDir, "projects", "p1", "runs", runId, "ws", "research")),
      ).toThrow();
      expect(
        store.events
          .list(runId)
          .some(
            (event) => event.type === "node.workspace.finalized" || event.type === "run.completed",
          ),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
});
