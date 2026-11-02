import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ok, type Path } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  captures: [] as {
    mode: "fresh" | "resume";
    cwd: string;
    execDir: string;
    checkpoint?: string;
  }[],
}));

vi.mock("@devchestra/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devchestra/adapters")>();
  return { ...actual, runAgent: mocks.runAgent };
});

import type { AdapterRegistry, RunRequest } from "@devchestra/adapters";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { executeAgent } from "../src/exec-agent.js";
import type { PlanNode, WorkflowPlan } from "../src/graph-plan.js";
import { isolated, planOf } from "./plan-source.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mocks.runAgent.mockReset();
  mocks.captures.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function adapterRegistry(): AdapterRegistry {
  const value = {
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
    plan: (request: RunRequest) => {
      const checkpoint =
        typeof request.cliOptions?.checkpoint === "string"
          ? request.cliOptions.checkpoint
          : undefined;
      mocks.captures.push({
        mode: request.mode,
        cwd: request.cwd,
        execDir: request.execDir,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      if (checkpoint !== undefined) {
        mkdirSync(dirname(checkpoint), { recursive: true });
        writeFileSync(checkpoint, "{}\n");
      }
      return ok({
        bin: process.execPath,
        args: [],
        cwd: request.cwd,
        env: request.env,
        stdin: request.prompt,
        files: [],
      });
    },
    parser: () => ({ feed: () => [], end: () => [] }),
    classify: () => ({ kind: "crash" as const, exitCode: 1, signal: null }),
    probe: async () => ({ ok: true, version: "test" }),
  };
  return { ids: () => ["fake"], has: () => true, get: () => value as never };
}

function workflow(): unknown {
  const agent = (id: string) => ({
    id,
    type: "agent",
    name: id,
    cli: "fake",
    prompt: id,
    output: { type: "object", properties: { ok: { type: "boolean" } } },
    permissions: { network: false, write: [] },
    workspace: { mode: "scratch" },
    limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 1 },
  });
  return {
    schemaVersion: 1,
    id: "checkpoint",
    name: "Checkpoint",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        agent("a"),
        agent("b"),
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "a" },
        { id: "e2", from: "a", to: "b" },
        { id: "e3", from: "b", to: "end" },
      ],
    },
  };
}

function setup(runLevel: boolean) {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-checkpoint-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project);
  mkdirSync(dataDir);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const snapshot = workflow();
  const created = store.runs.create({
    projectId: "p1",
    workflowId: "checkpoint",
    workflowHash: "hash",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
    ...(runLevel
      ? { workspace: { selection: { mode: "project" as const }, projectRoot: project } }
      : {}),
  });
  const plan = planOf(snapshot);
  const ctx = new EngineContext({
    store,
    adapters: adapterRegistry(),
    workspaces: {
      prepare: async (request) =>
        ok({
          projectRoot: request.projectRoot,
          selection: request.selection,
          dir: request.projectRoot,
          mode: "project",
          baseSha: null,
          git: false,
        }),
      acquire: async (request) => {
        const dir = request.runWorkspace?.projectRoot ?? join(dataDir, "scratch", request.path);
        mkdirSync(dir, { recursive: true });
        return ok({
          mode: request.runWorkspace === undefined ? "scratch" : "project",
          dataDir,
          projectId: request.projectId,
          runId: request.runId,
          path: request.path as Path,
          attempt: request.attempt,
          generation: request.generation,
          dir,
          markerFile: join(dir, `.marker-${request.attempt}-${request.generation}`),
          reused: request.requireExisting === true,
          projectRoot: request.projectRoot ?? null,
        } as never);
      },
      finalize: async (target, request) =>
        ok({
          dir: target.dir,
          attempt: request.process.attempt,
          generation: request.process.generation,
          outcome: request.outcome,
          alreadyFinalized: false,
          markerFile: target.markerFile,
          process: request.process,
        }),
      release: () => undefined,
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "token-value", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: process.env,
  });
  mocks.runAgent.mockImplementation(async (_inv, hooks) => {
    await hooks.onEvent({ t: "session", sessionId: "checkpoint-session" });
    return {
      code: 1,
      signal: null,
      killedBy: null,
      durationMs: 1,
      pid: 42,
      stdoutBytes: 0,
      stderrBytes: 0,
      sawTurnEnd: false,
      groupStopped: true,
      tail: { stdout: "", stderr: "" },
    };
  });
  const active: ActiveRunState = {
    abort: new AbortController(),
    reason: null,
    tokens: new Set(),
  };
  return { base, project, dataDir, store, plan, created, ctx, active };
}

async function runNode(
  ctx: EngineContext,
  runId: string,
  plan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  try {
    await executeAgent(ctx, ctx.run(runId), isolated(plan), node, active);
  } catch (error) {
    if (process.env.DEBUG_CHECKPOINT) console.error(error);
  }
}

describe("fake checkpoint placement", () => {
  it("uses stable per-node/attempt dataDir checkpoints for a shared run cwd", async () => {
    const s = setup(true);
    const a = s.plan.nodes.find((node) => node.id === "a");
    const b = s.plan.nodes.find((node) => node.id === "b");
    if (a === undefined || b === undefined) throw new Error("missing node");
    await runNode(s.ctx, s.created.runId, s.plan, a, s.active);
    await runNode(s.ctx, s.created.runId, s.plan, b, s.active);

    const byNode = (id: string) =>
      mocks.captures.filter((capture) => capture.checkpoint?.includes(`/${id}/`));
    const aCaptures = byNode("a");
    const bCaptures = byNode("b");
    const aPath = aCaptures[0]?.checkpoint as string;
    expect(aCaptures.length).toBeGreaterThanOrEqual(2);
    expect(bCaptures.length).toBeGreaterThanOrEqual(2);
    expect(aPath.startsWith(join(s.dataDir, "exec"))).toBe(true);
    expect(aPath.startsWith(s.project)).toBe(false);
    expect(new Set(aCaptures.map((capture) => capture.checkpoint)).size).toBe(1);
    expect(aCaptures.some((capture) => capture.mode === "fresh")).toBe(true);
    expect(aCaptures.some((capture) => capture.mode === "resume")).toBe(true);
    expect(new Set(bCaptures.map((capture) => capture.checkpoint)).size).toBe(1);
    expect(bCaptures[0]?.checkpoint).not.toBe(aPath);
    expect(aPath.includes("fake-a1")).toBe(true);
    expect(s.store.runs.get(s.created.runId)?.workspace?.projectRoot).toBe(s.project);
  });

  it("keeps the legacy cwd checkpoint for runs without a frozen binding", async () => {
    const s = setup(false);
    const a = s.plan.nodes.find((node) => node.id === "a");
    if (a === undefined) throw new Error("missing node");
    await runNode(s.ctx, s.created.runId, s.plan, a, s.active);
    const capture = mocks.captures.find((entry) => entry.checkpoint?.includes("/a/"));
    const legacyDir = join(s.dataDir, "scratch", "a");
    expect(capture?.checkpoint).toBe(join(legacyDir, ".devchestra/fake-checkpoint.json"));
    expect(capture?.cwd).toBe(legacyDir);
    expect(capture?.execDir.includes("/a1g")).toBe(true);
  });
});
