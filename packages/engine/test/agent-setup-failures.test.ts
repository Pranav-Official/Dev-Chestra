import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevChestraError, err, ok, type Path, type Result } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock("@devchestra/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devchestra/adapters")>();
  return { ...actual, runAgent: mocks.runAgent };
});

import type { AdapterRegistry, RunRequest } from "@devchestra/adapters";
import type { McpSelection } from "@devchestra/schema";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { executeAgent } from "../src/exec-agent.js";
import type { PlanNode, WorkflowPlan } from "../src/graph-plan.js";
import { StopSignal } from "../src/stop.js";
import type { McpResolver } from "../src/types.js";
import { isolated, planOf } from "./plan-source.js";

function workflow(agentExtra: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    id: "agent-setup",
    name: "Agent setup",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "a",
          type: "agent",
          name: "Work",
          cli: "fake",
          prompt: "do work",
          output: { type: "object", properties: { ok: { type: "boolean" } } },
          permissions: { network: false, write: [] },
          workspace: { mode: "scratch" },
          limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
          ...agentExtra,
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "a" },
        { id: "e2", from: "a", to: "end" },
      ],
    },
  };
}

interface Counters {
  issue: number;
  revoke: number;
  acquire: number;
  finalize: number;
  finalizeOutcomes: unknown[];
  release: number;
}

interface Harness {
  ctx: EngineContext;
  store: Store;
  runId: string;
  plan: WorkflowPlan;
  node: PlanNode;
  active: ActiveRunState;
  counters: Counters;
  runAgentCalls: () => number;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  mocks.runAgent.mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(options: {
  agent?: Record<string, unknown>;
  planError?: DevChestraError;
  acquireError?: DevChestraError;
  resolver?: McpResolver;
}): Harness {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-setupfail-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const snapshot = workflow(options.agent ?? {});
  const created = store.runs.create({
    projectId: "p1",
    workflowId: "agent-setup",
    workflowHash: "hash",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  });
  const plan = planOf(snapshot);
  const node = plan.nodes.find((entry) => entry.id === "a");
  if (node === undefined) throw new Error("missing node");

  const counters: Counters = {
    issue: 0,
    revoke: 0,
    acquire: 0,
    finalize: 0,
    finalizeOutcomes: [],
    release: 0,
  };
  let runAgentCalls = 0;
  mocks.runAgent.mockImplementation(async () => {
    runAgentCalls += 1;
    throw new Error("runAgent must not be called in setup-failure tests");
  });

  const stub = {
    id: "fake" as const,
    caps: {
      enforcesPermissions: "advisory" as const,
      structuredOutputFlag: false,
      resumeSupportsMcp: true,
      reportsCost: false,
      usageIsCumulative: false,
      promptViaStdin: true,
      maxPromptArgBytes: 0,
    },
    evidence: {
      cliVersion: "test",
      argvSource: "synthetic" as const,
      behaviorVerified: true,
      notes: [],
    },
    toolRef: (tool: string) => tool,
    plan: (_request: RunRequest) => {
      if (options.planError !== undefined) return err(options.planError);
      return ok({
        bin: process.execPath,
        args: [],
        cwd: dataDir,
        env: {},
        stdin: "",
        files: [],
      });
    },
    parser: () => ({ feed: () => [], end: () => [] }),
    classify: () => ({ kind: "ok" }) as const,
    probe: async () => ({ ok: true, version: "test" }),
  };
  const registry: AdapterRegistry = {
    ids: () => ["fake"],
    has: (id: string) => id === "fake",
    get: () => stub as never,
  };

  const ctx = new EngineContext({
    store,
    adapters: registry,
    workspaces: {
      prepare: async () => {
        throw new DevChestraError("E_INTERNAL", "run-level workspace is not used in this test");
      },
      acquire: async (request) => {
        counters.acquire += 1;
        if (options.acquireError !== undefined) throw options.acquireError;
        const dir = join(dataDir, "scratch", request.path as string);
        mkdirSync(dir, { recursive: true });
        return ok({
          mode: "scratch",
          dataDir,
          projectId: request.projectId,
          runId: request.runId,
          path: request.path as Path,
          attempt: request.attempt as number,
          generation: request.generation as number,
          dir,
          markerFile: join(dir, `.marker-${request.attempt as number}`),
          reused: false,
          projectRoot: null,
        } as never);
      },
      finalize: async (target, request) => {
        counters.finalize += 1;
        counters.finalizeOutcomes.push(request.outcome);
        return ok({
          dir: (target as { dir: string }).dir,
          attempt: (request.process as { attempt: number }).attempt,
          generation: (request.process as { generation: number }).generation,
          outcome: request.outcome,
          alreadyFinalized: false,
          markerFile: (target as { markerFile: string }).markerFile,
          process: request.process,
        });
      },
      release: () => {
        counters.release += 1;
      },
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => {
        counters.issue += 1;
        const token = `test-token-${counters.issue}`;
        const revoke = (): void => {
          counters.revoke += 1;
        };
        return { token, revoke };
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: { ...process.env, DEVCHESTRA_ALLOW_FAKE: "1" },
    ...(options.resolver === undefined ? {} : { mcpResolver: options.resolver }),
  });
  const active: ActiveRunState = { abort: new AbortController(), reason: null, tokens: new Set() };
  return {
    ctx,
    store,
    runId: created.runId as string,
    plan,
    node: node as PlanNode,
    active,
    counters,
    runAgentCalls: () => runAgentCalls,
  };
}

function execStatus(harness: Harness): string | undefined {
  return harness.store.view.get(harness.runId as never).executions.a?.status;
}

describe("agent setup failures", () => {
  it("adapter.plan throw fails the node, keeps the original error, revokes the token, finalizes + releases", async () => {
    const original = new DevChestraError("E_VALIDATION", "bad plan: marker-7f3a");
    const h = setup({ planError: original });
    let error: unknown;
    try {
      await executeAgent(h.ctx, h.ctx.run(h.runId), isolated(h.plan), h.node, h.active);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "E_VALIDATION" });
    expect(String((error as Error).message)).toContain("marker-7f3a");
    expect(execStatus(h)).toBe("failed");
    expect(h.runAgentCalls()).toBe(0);
    // Token was issued pre-plan and must be revoked exactly once.
    expect(h.counters.issue).toBe(1);
    expect(h.counters.revoke).toBe(1);
    expect(h.active.tokens.size).toBe(0);
    // Workspace was acquired, finalized as failed, and released.
    expect(h.counters.acquire).toBe(1);
    expect(h.counters.finalize).toBe(1);
    expect(h.counters.finalizeOutcomes).toEqual(["failed"]);
    expect(h.counters.release).toBe(1);
  });

  it("Stop during deferred MCP resolve cancels without minting a token or spawning", async () => {
    let releaseDeferred!: (value: Result<{ extra: []; known: [] }, DevChestraError>) => void;
    let resolveCalls = 0;
    const deferred = new Promise<Result<{ extra: []; known: [] }, DevChestraError>>((resolve) => {
      releaseDeferred = resolve;
    });
    const resolver: McpResolver = {
      list: async () => ({ servers: [], warnings: [] }),
      resolve: async (
        _cli: string,
        _projectDir: string,
        _selection: readonly McpSelection[],
      ): Promise<Result<{ extra: []; known: [] }, DevChestraError>> => {
        resolveCalls += 1;
        return deferred;
      },
    };
    const h = setup({
      agent: { mcpServers: [{ name: "github", scope: "global" }] },
      resolver,
    });
    const pending = executeAgent(h.ctx, h.ctx.run(h.runId), isolated(h.plan), h.node, h.active);
    pending.catch(() => undefined);
    for (let i = 0; i < 200 && resolveCalls === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resolveCalls).toBe(1);
    h.active.reason = "user";
    h.active.abort.abort("user");
    releaseDeferred(ok({ extra: [], known: [] }));
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StopSignal);
    expect(execStatus(h)).toBe("cancelled");
    expect(execStatus(h)).not.toBe("failed");
    expect(h.counters.issue).toBe(0);
    expect(h.runAgentCalls()).toBe(0);
  });

  it("workspace acquire throw fails the execution instead of leaving it running", async () => {
    const h = setup({ acquireError: new DevChestraError("E_WORKSPACE", "disk gone: marker-9c2e") });
    let error: unknown;
    try {
      await executeAgent(h.ctx, h.ctx.run(h.runId), isolated(h.plan), h.node, h.active);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "E_WORKSPACE" });
    expect(String((error as Error).message)).toContain("marker-9c2e");
    expect(execStatus(h)).toBe("failed");
    expect(execStatus(h)).not.toBe("running");
    // Failed before any token or process existed.
    expect(h.counters.issue).toBe(0);
    expect(h.runAgentCalls()).toBe(0);
  });
});
