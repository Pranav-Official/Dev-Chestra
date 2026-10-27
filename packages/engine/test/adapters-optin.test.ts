import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, type CliId, createAdapterRegistry } from "@relay/adapters";
import { err, ok, RelayError } from "@relay/core";
import { openStore, type Store } from "@relay/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@relay/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, StartRunInput, WorkspacePort } from "../src/types.js";

const REAL_IDS = ["codex", "claude-code"] as const;

interface WorkspaceProbe {
  acquire: number;
  release: number;
  port: WorkspacePort;
}

function failingWorkspace(): WorkspaceProbe {
  const probe: WorkspaceProbe = {
    acquire: 0,
    release: 0,
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
          new RelayError("E_WORKSPACE", "intentional test workspace failure", {
            details: { step: "test_workspace" },
          }),
        );
      },
      finalize: async () =>
        err(new RelayError("E_WORKSPACE", "intentional test workspace failure")),
      release: () => {
        probe.release += 1;
      },
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

function setup(
  allow: readonly ("claude-code" | "codex")[],
  options: { ids?: readonly CliId[]; workspaces?: WorkspacePort } = {},
): Setup {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-engine-optin-"));
  const store = openStore({ file: join(dataDir, "relay.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const workspace = failingWorkspace();
  const registry = createAdapterRegistry({
    ...(options.ids === undefined ? {} : { ids: [...options.ids] }),
    codexBin: join(dataDir, "never-run-codex"),
    claudeBin: join(dataDir, "never-run-claude"),
    nodeBin: process.execPath,
  });
  const engine = createEngine({
    store,
    adapters: registry,
    workspaces:
      options.workspaces === undefined
        ? workspace.port
        : { ...options.workspaces, release: workspace.port.release },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "test-token", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused-shim.js"),
    env: process.env,
    allowExperimentalClis: allow,
    maxNodeTimeoutMs: 15_000,
  });
  const value: Setup = { engine, store, registry, workspace, dataDir };
  live.add(value);
  return value;
}

function workflow(cli: string): unknown {
  return {
    schemaVersion: 1,
    id: "optin-test",
    name: "Opt-in test",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "work",
          type: "agent",
          name: "Work",
          cli,
          prompt: "Do nothing.",
          output: { type: "object", properties: { ok: { type: "boolean" } } },
          permissions: { network: false, write: [] },
          workspace: { mode: "scratch" },
          limits: { validationRetries: 0, crashRetries: 0 },
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "work" },
        { id: "e2", from: "work", to: "end" },
      ],
    },
  };
}

function input(cli: string): StartRunInput {
  const snapshot = workflow(cli);
  return {
    projectId: "p1",
    workflowId: "optin-test",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  };
}

function spawned(store: Store, runId: string): boolean {
  return store.events
    .list(runId as never, { limit: 10_000 })
    .some((event) => event.type === "node.process.spawned");
}

function failureCode(store: Store, runId: string): string | undefined {
  for (const event of store.events.list(runId as never, { limit: 10_000 })) {
    if (event.type !== "run.completed") continue;
    const payload = event.payload as { error?: { code?: string } };
    if (payload.error?.code !== undefined) return payload.error.code;
  }
  return undefined;
}

describe("real adapter ids require an explicit trusted opt-in", () => {
  for (const cli of REAL_IDS) {
    it(`${cli}: no opt-in fails before durable create or workspace/process attempt`, async () => {
      const s = setup([]);
      const launched = await s.engine.launch(input(cli));
      expect(launched.ok).toBe(false);
      if (launched.ok) throw new Error("expected E_CLI_MISSING denial");
      expect(launched.error.code).toBe("E_CLI_MISSING");
      expect(launched.error.details).toMatchObject({ cli, behaviorVerified: false });
      expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
      expect(s.store.processes.active()).toHaveLength(0);
      expect(s.workspace.acquire).toBe(0);
      expect(s.registry.get(cli).evidence.behaviorVerified).toBe(false);
    });

    it(`${cli}: a different provider's opt-in does not authorize it`, async () => {
      const other = cli === "codex" ? "claude-code" : "codex";
      const s = setup([other]);
      const launched = await s.engine.launch(input(cli));
      expect(launched.ok).toBe(false);
      if (launched.ok) throw new Error("expected E_CLI_MISSING denial");
      expect(launched.error.code).toBe("E_CLI_MISSING");
      expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
      expect(s.workspace.acquire).toBe(0);
    });

    it(`${cli}: matching opt-in creates durably, then stops at the workspace`, async () => {
      const s = setup([cli]);
      const adapter = s.registry.get(cli);
      expect(adapter.evidence.behaviorVerified).toBe(false);

      const launched = await s.engine.launch(input(cli));
      expect(launched.ok).toBe(true);
      if (!launched.ok) throw launched.error;
      const { runId } = launched.value;
      expect(s.store.runs.get(runId as never)).not.toBeNull();

      const outcome = await launched.value.completion;
      expect(outcome.status).toBe("failed");
      expect(failureCode(s.store, runId)).toBe("E_WORKSPACE");
      expect(s.workspace.acquire).toBe(1);
      expect(spawned(s.store, runId)).toBe(false);
      expect(s.store.processes.active()).toHaveLength(0);
      expect(adapter.evidence.behaviorVerified).toBe(false);
    });
  }

  it("fake stays available without any experimental opt-in", async () => {
    const s = setup([]);
    const launched = await s.engine.launch(input("fake"));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    expect(s.store.runs.get(launched.value.runId as never)).not.toBeNull();
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(failureCode(s.store, launched.value.runId)).toBe("E_WORKSPACE");
    expect(s.workspace.acquire).toBe(1);
  });

  it("a missing or disabled registry always fails", async () => {
    const s = setup([], { ids: ["fake"] });
    const launched = await s.engine.launch(input("codex"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_CLI_MISSING denial");
    expect(launched.error.code).toBe("E_CLI_MISSING");
    expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
    expect(s.workspace.acquire).toBe(0);
  });
});

describe("resume keeps the exec-agent opt-in gate", () => {
  it("resuming a real-CLI run without opt-in fails before any process dispatch", async () => {
    const s = setup([], {
      workspaces: {
        prepare: (request) => prepareRunWorkspace(request),
        acquire: (request) => acquireScratch(request),
        finalize: (workspace, request) => finalizeScratch(workspace, request),
        release: (workspace) => releaseScratch(workspace),
      },
    });
    const snapshot = workflow("codex");
    const runId = s.store.runs.create({
      projectId: "p1",
      workflowId: "optin-resume",
      workflowHash: "test-hash",
      snapshot,
      snapshotRaw: JSON.stringify(snapshot),
    }).runId as string;

    const outcome = await s.engine.resume(runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.status).toBe("failed");
    expect(failureCode(s.store, runId)).toBe("E_CLI_MISSING");
    expect(spawned(s.store, runId)).toBe(false);
    expect(s.store.processes.active()).toHaveLength(0);
    expect(s.registry.get("codex").evidence.behaviorVerified).toBe(false);
  });
});
