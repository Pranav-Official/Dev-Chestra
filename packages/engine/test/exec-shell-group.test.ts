import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@devchestra/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devchestra/adapters")>();
  return { ...actual, runCommand: runCommandMock };
});

import type { Path } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import { acquireScratch, finalizeScratch, releaseScratch } from "@devchestra/workspaces";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { executeShell } from "../src/exec-shell.js";
import { analyzeLinearWorkflow } from "../src/sequence.js";

const fixture = {
  schemaVersion: 1,
  id: "linear",
  name: "linear",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      {
        id: "report",
        type: "shell",
        name: "Report",
        command: "true",
        workspace: { mode: "scratch" },
        timeoutMin: 1,
        allowFailure: false,
      },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ],
    edges: [
      { id: "e1", from: "start", to: "report" },
      { id: "e2", from: "report", to: "end" },
    ],
  },
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  runCommandMock.mockReset();
});

describe("shell process group stop", () => {
  it("keeps the node running and pauses the run when the group survives", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-group-"));
    tempDirs.push(dataDir);
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    try {
      store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
      const created = store.runs.create({
        projectId: "p1",
        workflowId: "linear",
        workflowHash: "hash",
        snapshot: fixture,
        snapshotRaw: JSON.stringify(fixture),
        params: {},
      });
      const chainResult = analyzeLinearWorkflow(fixture);
      if (!chainResult.ok) throw chainResult.error;
      const chain = chainResult.value;
      const node = chain.nodes.find((candidate) => candidate.id === "report");
      if (node === undefined) throw new Error("missing report node");
      const run = store.runs.get(created.runId);
      if (run === null) throw new Error("missing run");
      store.executions.ensure({
        runId: created.runId,
        path: "report" as Path,
        nodeId: "report",
        kind: "shell",
      });
      runCommandMock.mockResolvedValue({
        exitCode: null,
        signal: null,
        killedBy: null,
        durationMs: 1,
        pid: 424242,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        groupStopped: false,
      });
      const ctx = new EngineContext({
        store,
        adapters: {
          get() {
            throw new Error("not used");
          },
          has: () => false,
          ids: () => [],
        },
        workspaces: {
          acquire: acquireScratch,
          finalize: finalizeScratch,
          release: releaseScratch,
        },
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
      const active: ActiveRunState = {
        abort: new AbortController(),
        reason: null,
        tokens: new Set(),
      };
      const shellChain = { ...chain, nodes: [node] };
      await expect(executeShell(ctx, run, shellChain, node, active)).rejects.toMatchObject({
        code: "E_WORKSPACE",
      });
      const view = store.view.get(created.runId);
      expect(view.status).toBe("paused");
      expect(view.pauseReason).toBe("shutdown");
      expect(view.executions.report?.status).toBe("running");
      const events = store.events.list(created.runId);
      expect(events.some((event) => event.type === "node.process.stopped")).toBe(false);
      expect(events.some((event) => event.type === "node.workspace.finalized")).toBe(false);
      expect(events.some((event) => event.type === "error.logged")).toBe(true);
    } finally {
      store.close();
    }
  });
});
