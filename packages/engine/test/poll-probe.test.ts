import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliId, createAdapterRegistry } from "@devchestra/adapters";
import type { NormalizedStartNode, NormalizedWorkflow, PollProbe } from "@devchestra/schema";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
// Real loopback gateway for agent probes, imported from the built server like
// the engine fixture drivers do (no package dependency; dist only).
import {
  createAgentGateway,
  ExecTokenRegistry,
  OutputValidator,
  startLoopbackServer,
} from "../../server/dist/index.js";
import { createEngine } from "../src/engine.js";
import { buildProbeSnapshot, POLL_PROBE_NODE_ID, probeStartNode } from "../src/probe.js";
import type { Engine, ProbePollInput } from "../src/types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fakeBin = join(repoRoot, "tools/fake-agent/dist/main.js");
const shim = join(repoRoot, "packages/mcp/dist/bin/shim.js");

const cleanups: (() => void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

interface Harness {
  engine: Engine;
  store: Store;
  requests: { prompt: string; permissions: unknown; mcpServers: unknown }[];
}

async function harness(
  options: {
    fakeScript?: unknown[];
    isCliEnabled?: (cli: CliId) => boolean;
    gateway?: "stub" | "real";
    mcpResolver?: import("../src/types.js").McpResolver;
  } = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-probe-"));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const requests: Harness["requests"] = [];
  const base = createAdapterRegistry({
    ids: ["fake"],
    fakeAgentBin: fakeBin,
    fakeScript: options.fakeScript ?? [],
  }).get("fake");
  const adapter = {
    ...base,
    plan: (request: Parameters<typeof base.plan>[0]) => {
      requests.push({
        prompt: (request as { prompt?: string }).prompt ?? "",
        permissions: (request as { permissions?: unknown }).permissions,
        mcpServers: (request as { extraMcp?: unknown }).extraMcp,
      });
      return base.plan(request);
    },
  };
  const registry = {
    ids: () => ["fake" as CliId],
    has: (id: unknown) => id === "fake",
    get: () => adapter,
  };
  // Agent probes submit through the MCP shim, which only talks to a real
  // gateway. Shell probes use the stub.
  let gateway: { url: string; issue: (scope: never) => { token: string; revoke: () => void } };
  let closeGateway = async (): Promise<void> => undefined;
  if (options.gateway === "real") {
    const tokens = new ExecTokenRegistry({
      registerSecret: (value: string, name?: string) => store.security.registerSecret(value, name),
    });
    const validator = new OutputValidator();
    let port = 0;
    const server = await startLoopbackServer(
      createAgentGateway({ tokens, submissions: store.submissions, validator, port: () => port }),
    );
    port = server.port;
    gateway = {
      url: server.url,
      issue: (scope: {
        identity: unknown;
        outputSchema: unknown;
        outputSchemaHash: string;
        validationLimit: number;
        expiresAt: number;
      }) => {
        const token = tokens.issue({
          identity: scope.identity as never,
          toolset: "agent",
          outputSchema: scope.outputSchema as never,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
        });
        return { token, revoke: () => tokens.revoke(token) };
      },
    };
    closeGateway = () => server.close();
  } else {
    gateway = {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "test-token-unused", revoke: () => undefined }),
    };
  }
  const engine = createEngine({
    store,
    adapters: registry as never,
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway,
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: shim,
    env: { ...process.env, DEVCHESTRA_ALLOW_FAKE: "1" },
    maxNodeTimeoutMs: 30_000,
    validateOutput: (schema, value) =>
      new OutputValidator().compile(schema).validate(value) as
        | { ok: true }
        | { ok: false; issues: never },
    ...(options.isCliEnabled === undefined ? {} : { isCliEnabled: options.isCliEnabled }),
    ...(options.mcpResolver === undefined ? {} : { mcpResolver: options.mcpResolver }),
  });
  cleanups.push(async () => {
    await engine.stop({ graceMs: 1_000 }).catch(() => undefined);
    await closeGateway().catch(() => undefined);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { engine, store, requests };
}

const START: NormalizedStartNode = {
  id: "start",
  type: "start",
  name: "Start",
  supervise: "default",
  env: [],
  params: [{ name: "pr", type: "number", required: true }],
  polling: {
    enabled: true,
    probe: { id: "probe", type: "shell", name: "Poll probe", command: "true" },
    dedupe: true,
    workspace: "project",
  },
};

function snapshot(probe: PollProbe): NormalizedWorkflow {
  return {
    schemaVersion: 1,
    id: "polled",
    name: "Polled",
    graph: {
      nodes: [{ ...START, polling: { enabled: true, probe, dedupe: true, workspace: "project" } }],
      edges: [],
    },
  };
}

function input(probe: PollProbe, extra: Partial<ProbePollInput> = {}): ProbePollInput {
  return {
    projectId: "p1",
    workflowId: "polled",
    snapshot: snapshot(probe),
    probe,
    workspace: "project",
    timeoutMs: 20_000,
    ...extra,
  };
}

describe("buildProbeSnapshot", () => {
  it("synthesizes start -> probe -> end for a shell probe", () => {
    const snap = buildProbeSnapshot(
      "wf",
      START,
      { id: "probe", type: "shell", name: "Poll probe", command: "echo hi" },
      1,
    );
    expect(snap.graph.nodes.map((node) => node.id)).toEqual(["start", "probe", "end"]);
    expect(snap.graph.edges).toEqual([
      { id: "e1", from: "start", to: "probe" },
      { id: "e2", from: "probe", to: "end" },
    ]);
    const probe = snap.graph.nodes.find((node) => node.id === POLL_PROBE_NODE_ID);
    expect(probe).toMatchObject({ type: "shell", command: "echo hi", allowFailure: false });
  });

  it("builds an agent probe from the saved node with generated schema", () => {
    const snap = buildProbeSnapshot(
      "wf",
      START,
      {
        id: "probe",
        type: "agent",
        name: "Poll probe",
        cli: "codex",
        prompt: "Check.",
        permissions: { network: false, write: ["workspace"], shell: false },
        mcpServers: [{ name: "gh", scope: "global" }],
        limits: { timeoutMin: 5, validationRetries: 2, crashRetries: 1 },
      } as unknown as PollProbe,
      2,
    );
    const probe = snap.graph.nodes.find((node) => node.id === POLL_PROBE_NODE_ID);
    expect(probe).toMatchObject({
      type: "agent",
      cli: "codex",
      permissions: { network: false, write: ["workspace"], shell: false },
      mcpServers: [{ name: "gh", scope: "global" }],
      limits: { timeoutMin: 2 },
    });
    if (probe?.type !== "agent") throw new Error("expected agent probe node");
    expect(probe.prompt).toContain("read-only polling probe");
    expect(probe.prompt).toContain("Check.");
    expect(probe.output).toMatchObject({
      type: "object",
      required: ["found", "params"],
    });
  });

  it("refuses a snapshot without a start node", () => {
    expect(() =>
      probeStartNode({ schemaVersion: 1, id: "x", name: "x", graph: { nodes: [], edges: [] } }),
    ).toThrow(/no start node/);
  });
});

describe("engine.probe with a shell probe", () => {
  it("returns stdout and the exit code as an ordinary poll_probe run", async () => {
    const { engine, store } = await harness();
    await engine.start();
    const result = await engine.probe(
      input({ id: "probe", type: "shell", name: "Poll probe", command: `printf '{"pr": 7}'` }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.raw).toEqual({ kind: "shell", stdout: '{"pr": 7}', exitCode: 0 });
    expect(typeof result.value.runId).toBe("string");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);

    const run = store.runs.get(result.value.runId as never);
    expect(run?.kind).toBe("poll_probe");
    // Probe runs stay out of listings by default.
    expect(store.runs.list({}).items.map((item) => item.id)).not.toContain(result.value.runId);
    expect(store.runs.list({ includeProbeRuns: true }).items.map((item) => item.id)).toContain(
      result.value.runId,
    );
    expect(store.runs.workflowSummaries("p1").map((item) => item.id)).not.toContain(
      result.value.runId,
    );
  });

  it("fails the probe on a non-zero exit", async () => {
    const { engine } = await harness();
    await engine.start();
    const result = await engine.probe(
      input({ id: "probe", type: "shell", name: "Poll probe", command: "exit 3" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected probe failure");
    expect(result.error.code).toBe("E_POLL_PROBE");
  });

  it("times out a stuck probe and cancels its run", async () => {
    const { engine, store } = await harness();
    await engine.start();
    const result = await engine.probe(
      input(
        { id: "probe", type: "shell", name: "Poll probe", command: "sleep 30" },
        { timeoutMs: 800 },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected probe timeout");
    expect(result.error.code).toBe("E_POLL_PROBE");
    expect(result.error.message).toContain("timed out");
    const runId = (result.error.details as { runId?: string } | undefined)?.runId;
    expect(typeof runId).toBe("string");
    // The cancelled run settles instead of lingering.
    for (let i = 0; i < 50; i++) {
      const run = store.runs.get(runId as never);
      if (run !== null && ["cancelled", "failed"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(["cancelled", "failed"]).toContain(store.runs.get(runId as never)?.status);
  });
});

describe("engine.probe with an agent probe", () => {
  // `fake` is test-only: the PollProbe type keeps the production CLI union,
  // so the test fixture casts at the boundary like the parser does.
  const agentProbe = {
    id: "probe",
    type: "agent",
    name: "Poll probe",
    cli: "fake",
    prompt: "Check for work.",
    permissions: { network: true, write: [], shell: true },
    mcpServers: [{ name: "gh", scope: "global" }],
    limits: { timeoutMin: 5, validationRetries: 2, crashRetries: 1 },
  } as unknown as PollProbe;

  it("carries the author's permissions and mcpServers with generated schema", async () => {
    const { engine, store, requests } = await harness({
      fakeScript: [{ type: "submit", output: { found: true, params: { pr: 5 } } }],
      gateway: "real",
      mcpResolver: {
        list: async () => ({
          servers: [{ name: "gh", scope: "global" as const }],
          warnings: [],
        }),
        resolve: async (_cli, _dir, selection) => ({
          ok: true as const,
          value: {
            extra: selection.map((s) => ({
              name: s.name,
              scope: s.scope,
              transport: "http" as const,
              url: "https://example.test",
            })),
            known: selection.map((s) => ({ name: s.name, scope: s.scope })),
          },
        }),
      },
    });
    await engine.start();
    const result = await engine.probe(input(agentProbe));
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.raw).toEqual({
      kind: "agent",
      output: { found: true, params: { pr: 5 } },
    });
    expect(store.runs.get(result.value.runId as never)?.kind).toBe("poll_probe");
    // Author's permissions/mcpServers pass through unchanged (not overridden).
    expect(requests).toHaveLength(1);
    expect(requests[0]?.permissions).toMatchObject({ network: true, write: [], shell: true });
    expect(requests[0]?.mcpServers).toMatchObject([{ name: "gh", scope: "global" }]);
    expect(requests[0]?.prompt).toContain("read-only polling probe");
    expect(requests[0]?.prompt).toContain("Check for work.");
    // Output schema is generated from the start params, not from the probe.
    const snap = buildProbeSnapshot("polled", START, agentProbe, 1);
    const node = snap.graph.nodes.find((n) => n.id === POLL_PROBE_NODE_ID);
    if (node?.type !== "agent") throw new Error("expected agent probe node");
    expect(node.output).toMatchObject({ type: "object", required: ["found", "params"] });
  });

  it("honours provider-disabled checks", async () => {
    const { engine } = await harness({
      fakeScript: [{ type: "submit", output: { found: false, params: {} } }],
      isCliEnabled: () => false,
    });
    await engine.start();
    const result = await engine.probe(input(agentProbe));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected disabled-provider failure");
    expect(result.error.code).toBe("E_CLI_DISABLED");
  });

  it("fails when the agent submits nothing usable", async () => {
    const { engine } = await harness({ fakeScript: [] });
    await engine.start();
    const result = await engine.probe(input(agentProbe, { timeoutMs: 20_000 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected probe failure");
    expect(result.error.code).toBe("E_POLL_PROBE");
  });
});

describe("poll_probe run hygiene", () => {
  it("deletes one probe run and prunes a workflow to the newest keep", async () => {
    const { engine, store } = await harness();
    await engine.start();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await engine.probe(
        input({ id: "probe", type: "shell", name: "Poll probe", command: "echo hi" }),
      );
      if (!result.ok) throw result.error;
      ids.push(result.value.runId);
    }
    const [first] = ids;
    store.runs.deleteProbeRun(first as never);
    expect(store.runs.get(first as never)).toBeNull();
    expect(store.runs.pruneProbeRuns("p1", "polled", 20)).toBe(0);
    expect(store.runs.pruneProbeRuns("p1", "polled", 1)).toBe(1);
    const remaining = store.runs.list({ includeProbeRuns: true }).items;
    expect(remaining).toHaveLength(1);
  });

  it("refuses to delete a real run", async () => {
    const { engine, store } = await harness();
    await engine.start();
    const launched = await engine.launch({
      projectId: "p1",
      workflowId: "real",
      snapshot: {
        schemaVersion: 1,
        id: "real",
        name: "Real",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "s", type: "shell", name: "S", command: "echo hi", timeoutMin: 1 },
            { id: "end", type: "end", name: "End", status: "success", result: "{}" },
          ],
          edges: [
            { id: "e1", from: "start", to: "s" },
            { id: "e2", from: "s", to: "end" },
          ],
        },
      },
      snapshotRaw: "{}",
      params: {},
    });
    if (!launched.ok) throw launched.error;
    expect(() => store.runs.deleteProbeRun(launched.value.runId as never)).toThrow(
      /not a probe run/,
    );
  });

  it("keeps probe runs out of usage by default", async () => {
    const { engine, store } = await harness();
    await engine.start();
    const result = await engine.probe(
      input({ id: "probe", type: "shell", name: "Poll probe", command: "echo hi" }),
    );
    if (!result.ok) throw result.error;
    expect(store.usage.summary({}).total).toEqual({ usd: 0, tokens: 0 });
    expect(store.usage.summary({ includeProbeRuns: true }).total).toEqual({
      usd: 0,
      tokens: 0,
    });
  });
});
