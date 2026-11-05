import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, type CliId, createAdapterRegistry } from "@devchestra/adapters";
import { DevChestraError, err, hashJson, ok } from "@devchestra/core";
import type { EffectiveModelTiers } from "@devchestra/schema";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { freezeWorkflowBundle } from "../src/freeze.js";
import { resolveModelTiers } from "../src/model-tiers.js";
import type {
  Engine,
  EngineDeps,
  ModelTierSource,
  StartRunInput,
  WorkspacePort,
} from "../src/types.js";

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

function setup(
  options: { isCliEnabled?: (cli: CliId) => boolean; modelTiers?: ModelTierSource } = {},
): Setup {
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
    validateOutput: () => ({ ok: true }),
    ...(options.isCliEnabled === undefined ? {} : { isCliEnabled: options.isCliEnabled }),
    ...(options.modelTiers === undefined ? {} : { modelTiers: options.modelTiers }),
  };
  const engine = createEngine(deps);
  const value: Setup = { engine, store, registry, workspace, dataDir };
  live.add(value);
  return value;
}

function agentNode(id: string, cli: string | { tier: string }): unknown {
  return {
    id,
    type: "agent",
    name: "Work",
    ...(typeof cli === "string" ? { cli } : cli),
    prompt: "Do nothing.",
    output: { type: "object", properties: { ok: { type: "boolean" } } },
    permissions: { network: false, write: [] },
    workspace: { mode: "scratch" },
    limits: { validationRetries: 0, crashRetries: 0 },
  };
}

function flatWorkflow(cli: string | { tier: string }): unknown {
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

function loopWorkflow(cli: string | { tier: string }): unknown {
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

function source(tiers: EffectiveModelTiers): ModelTierSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async (projectId) => {
      calls.push(projectId);
      return ok(tiers);
    },
  };
}

const mapped: EffectiveModelTiers = {
  high: { ref: { cli: "claude-code", model: "opus" }, source: "local" },
  low: { ref: { cli: "codex" }, source: "project" },
};

describe("model tiers at launch", () => {
  it("stores the resolved snapshot and hashes the authored one", async () => {
    const tiers = source(mapped);
    const s = setup({ modelTiers: tiers });
    const authored = flatWorkflow({ tier: "high" });
    const launched = await s.engine.launch(input(authored, "tier-test"));
    if (!launched.ok) throw launched.error;
    await launched.value.completion;
    expect(tiers.calls).toEqual(["p1"]);
    const run = s.store.runs.get(launched.value.runId);
    if (run === null) throw new Error("run was not stored");
    const snapshot = run.snapshot as {
      graph: { nodes: { id: string; cli?: string; model?: string; tier?: string }[] };
    };
    const agent = snapshot.graph.nodes.find((node) => node.id === "work");
    expect(agent).toMatchObject({ cli: "claude-code", model: "opus" });
    expect(agent).not.toHaveProperty("tier");
    expect(run.workflowHash).toBe(await hashJson(authored));
    expect(run.snapshotRaw).toBe(JSON.stringify(authored));
  });

  it("resolves tiers inside a loop body", async () => {
    const s = setup({ modelTiers: source(mapped) });
    const launched = await s.engine.launch(input(loopWorkflow({ tier: "low" }), "tier-loop"));
    if (!launched.ok) throw launched.error;
    await launched.value.completion;
    expect(JSON.stringify(s.store.runs.get(launched.value.runId)?.snapshot)).toContain(
      '"cli":"codex"',
    );
  });

  it("refuses an unmapped tier before any run or workspace exists", async () => {
    const s = setup({ modelTiers: source({ high: mapped.high } as EffectiveModelTiers) });
    const launched = await s.engine.launch(input(flatWorkflow({ tier: "low" }), "tier-test"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_MODEL_TIER refusal");
    expect(launched.error.code).toBe("E_MODEL_TIER");
    expect(launched.error.message).toContain("Model tier 'low' is not set on this machine");
    expect(launched.error.message).toContain("devchestra settings set low");
    expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
    expect(s.workspace.acquire).toBe(0);
  });

  it("refuses a tier mapped to a provider that is turned off", async () => {
    const s = setup({
      modelTiers: source(mapped),
      isCliEnabled: (cli) => cli !== "claude-code",
    });
    const launched = await s.engine.launch(input(flatWorkflow({ tier: "high" }), "tier-test"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_CLI_DISABLED refusal");
    expect(launched.error.code).toBe("E_CLI_DISABLED");
    expect(s.store.runs.list({ limit: 100 }).items).toHaveLength(0);
  });

  it("refuses a tiered workflow when no settings source is configured", async () => {
    const s = setup();
    const launched = await s.engine.launch(input(flatWorkflow({ tier: "high" }), "tier-test"));
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected E_MODEL_TIER refusal");
    expect(launched.error.code).toBe("E_MODEL_TIER");
  });

  it("surfaces a settings source failure and never reads settings for untiered workflows", async () => {
    const failing: ModelTierSource = {
      load: async () =>
        err(new DevChestraError("E_MODEL_TIER", "settings.local.json is not valid")),
    };
    const s = setup({ modelTiers: failing });
    const tiered = await s.engine.launch(input(flatWorkflow({ tier: "high" }), "tier-test"));
    expect(tiered.ok).toBe(false);
    if (tiered.ok) throw new Error("expected failure");
    expect(tiered.error.message).toBe("settings.local.json is not valid");

    const plain = await s.engine.launch(input(flatWorkflow("codex"), "plain-test"));
    expect(plain.ok).toBe(true);
  });
});

describe("model tiers in frozen bundles", () => {
  function child(tier: string): unknown {
    return flatWorkflow({ tier });
  }
  function parent(): unknown {
    const nodes = [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "call", type: "workflow", name: "Call", workflowId: "kid", inputs: {} },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ];
    return {
      schemaVersion: 1,
      id: "parent",
      name: "Parent",
      graph: {
        nodes,
        edges: [
          { id: "e1", from: "start", to: "call" },
          { id: "e2", from: "call", to: "end" },
        ],
      },
    };
  }
  const reader = {
    resolve: async (_projectId: string, id: string) =>
      ok({ id, normalized: child("high"), hash: "h", text: "" }),
  };

  it("keeps child definitions as authored when armed without a transform", async () => {
    const frozen = await freezeWorkflowBundle({
      projectId: "p1",
      rootSnapshot: parent(),
      rootWorkflowId: "parent",
      resolver: reader,
    });
    expect(JSON.stringify(frozen.bundle.kid)).toContain('"tier":"high"');
    expect(JSON.stringify(frozen.bundle.kid)).not.toContain('"cli"');
  });

  it("resolves child definitions when a transform is supplied", async () => {
    const frozen = await freezeWorkflowBundle({
      projectId: "p1",
      rootSnapshot: parent(),
      rootWorkflowId: "parent",
      resolver: reader,
      transform: (snapshot) =>
        resolveModelTiers({ projectId: "p1", snapshot, source: source(mapped) }),
    });
    expect(JSON.stringify(frozen.bundle.kid)).toContain('"cli":"claude-code","model":"opus"');
  });
});
