import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, type CliId, createAdapterRegistry } from "@devchestra/adapters";
import { DevChestraError, err, ok } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, EngineDeps, StartRunInput, WorkspacePort } from "../src/types.js";

interface WorkspaceProbe {
  acquire: number;
  port: WorkspacePort;
}

function failingWorkspace(): WorkspaceProbe {
  const probe: WorkspaceProbe = {
    acquire: 0,
    port: {
      prepare: async (request) =>
        ok({
          projectRoot: request.projectRoot,
          selection: request.selection,
          dir: request.projectRoot,
          mode: "project",
          baseSha: null,
          git: false,
        }),
      acquire: async () => {
        probe.acquire += 1;
        return err(
          new DevChestraError("E_WORKSPACE", "intentional test workspace failure", {
            details: { step: "test_workspace" },
          }),
        );
      },
      finalize: async () =>
        err(new DevChestraError("E_WORKSPACE", "intentional test workspace failure")),
      release: () => undefined,
    },
  };
  return probe;
}

interface Setup {
  engine: Engine;
  store: Store;
  registry: AdapterRegistry;
  workspace: WorkspaceProbe;
  dataDir: string;
}

const live = new Set<Setup>();

afterEach(async () => {
  for (const setup of live) {
    await setup.engine.stop({ graceMs: 1_000 }).catch(() => undefined);
    setup.store.close();
    rmSync(setup.dataDir, { recursive: true, force: true });
  }
  live.clear();
});

function setup(options: { isCliEnabled?: (cli: CliId) => boolean } = {}): Setup {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-disabled-"));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const workspace = failingWorkspace();
  const registry = createAdapterRegistry({
    codexBin: join(dataDir, "never-run-codex"),
    claudeBin: join(dataDir, "never-run-claude"),
    nodeBin: process.execPath,
  });
  const deps: EngineDeps = {
    store,
    adapters: registry,
    workspaces: workspace.port,
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "test-token", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused-shim.js"),
    env: process.env,
    maxNodeTimeoutMs: 15_000,
    validateOutput: () => ok({ ok: true }),
    ...(options.isCliEnabled === undefined ? {} : { isCliEnabled: options.isCliEnabled }),
  };
  const engine = createEngine(deps);
  const value: Setup = { engine, store, registry, workspace, dataDir };
  live.add(value);
  return value;
}

function agentNode(id: string, cli: string): unknown {
  return {
    id,
    type: "agent",
    name: "Work",
    cli,
    prompt: "Do nothing.",
    output: { type: "object", properties: { ok: { type: "boolean" } } },
    permissions: { network: false, write: [] },
    workspace: { mode: "scratch" },
    limits: { validationRetries: 0, crashRetries: 0 },
  };
}

function flatWorkflow(cli: string): unknown {
  return {
    schemaVersion: 1,
    id: "disabled-test",
    name: "Disabled test",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        agentNode("work", cli),
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "work" },
        { id: "e2", from: "work", to: "end" },
      ],
    },
  };
}

function loopWorkflow(cli: string): unknown {
  return {
    schemaVersion: 1,
    id: "disabled-loop-test",
    name: "Disabled loop test",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "loop",
          type: "loop",
          name: "Loop",
          mode: "repeatUntil",
          maxIterations: 1,
          until: "true",
          result: "loop.state",
          output: { type: "object" },
          body: {
            nodes: [
              { id: "bstart", type: "start", name: "BStart", params: [] },
              agentNode("inner", cli),
              { id: "bdone", type: "end", name: "BDone", status: "success", result: "{}" },
            ],
            edges: [
              { id: "be1", from: "bstart", to: "inner" },
              { id: "be2", from: "inner", to: "bdone" },
            ],
          },
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "loop" },
        { id: "e2", from: "loop", to: "end" },
      ],
    },
  };
}

function input(snapshot: unknown, workflowId: string): StartRunInput {
  return {
    projectId: "p1",
    workflowId,
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  };
}

function failureCode(store: Store, runId: string): string | undefined {
  for (const event of store.events.list(runId as never, { limit: 10_000 })) {
    if (event.type !== "run.completed") continue;
    const payload = event.payload as { error?: { code?: string } };
    if (payload.error?.code !== undefined) return payload.error.code;
  }
  return undefined;
}

describe("provider on/off gate", () => {
  it("refuses a run that uses a disabled provider before any workspace work", async () => {
    const s = setup({ isCliEnabled: (cli) => cli !== "codex" });
    const launched = await s.engine.launch(input(flatWorkflow("codex"), "disabled-test"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_CLI_DISABLED refusal");
    expect(launched.error.code).toBe("E_CLI_DISABLED");
    expect(launched.error.message).toBe("Codex is turned off. Turn it on in Settings > Providers.");
    expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
    expect(s.workspace.acquire).toBe(0);
  });

  it("refuses a disabled provider inside a loop body at start", async () => {
    const s = setup({ isCliEnabled: (cli) => cli !== "codex" });
    const launched = await s.engine.launch(input(loopWorkflow("codex"), "disabled-loop-test"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_CLI_DISABLED refusal");
    expect(launched.error.code).toBe("E_CLI_DISABLED");
    expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
    expect(s.workspace.acquire).toBe(0);
  });

  it("lets an enabled provider run while another one is disabled", async () => {
    const s = setup({ isCliEnabled: (cli) => cli !== "codex" });
    const launched = await s.engine.launch(input(flatWorkflow("claude-code"), "disabled-test"));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(failureCode(s.store, launched.value.runId)).toBe("E_WORKSPACE");
    expect(s.workspace.acquire).toBe(1);
  });

  it("behaves as before when no enabled check is wired", async () => {
    const s = setup();
    const launched = await s.engine.launch(input(flatWorkflow("codex"), "disabled-test"));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(failureCode(s.store, launched.value.runId)).toBe("E_WORKSPACE");
    expect(s.workspace.acquire).toBe(1);
  });
});
