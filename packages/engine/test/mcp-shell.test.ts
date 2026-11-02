import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DevChestraError, err, ok, type Path, type Result } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock("@devchestra/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devchestra/adapters")>();
  return { ...actual, runAgent: mocks.runAgent };
});

import type {
  AdapterEvent,
  AdapterRegistry,
  FailureClass,
  ResolvedMcpServer,
  RunRequest,
} from "@devchestra/adapters";
import type { McpSelection } from "@devchestra/schema";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { executeAgent } from "../src/exec-agent.js";
import type { PlanNode, WorkflowPlan } from "../src/graph-plan.js";
import type { McpResolver } from "../src/types.js";
import { isolated, planOf } from "./plan-source.js";

/** Planted secret: must never appear in any event, error detail or snapshot. */
const SECRET = "sk-planted-fake-secret-9f8e7d6c5b4a";

const EXTRA: ResolvedMcpServer[] = [
  {
    name: "github",
    scope: "global",
    transport: "http",
    url: "https://mcp.example.com/github",
    headers: { Authorization: `Bearer ${SECRET}` },
    env: { GITHUB_TOKEN: SECRET },
  },
];

const KNOWN: NonNullable<RunRequest["knownMcp"]> = [
  { name: "github", scope: "global" },
  { name: "docs", scope: "project" },
];

interface AttemptSpec {
  events?: AdapterEvent[];
  classify: FailureClass;
  exit?: Record<string, unknown>;
  acceptMidRun?: boolean;
}

interface ResolverCalls {
  list: number;
  resolve: number;
  selections: McpSelection[][];
}

function fakeResolver(options: {
  extra?: ResolvedMcpServer[];
  known?: NonNullable<RunRequest["knownMcp"]>;
  resolveError?: DevChestraError;
  listThrows?: boolean;
  calls?: ResolverCalls;
}): McpResolver {
  const calls = options.calls ?? { list: 0, resolve: 0, selections: [] };
  if (options.calls === undefined) {
    // Keep the caller's object identity when provided; otherwise use the local one.
  }
  return {
    list: async () => {
      calls.list += 1;
      if (options.listThrows === true) throw new Error("mcp list exploded");
      return {
        servers: (options.known ?? KNOWN).map((server) => ({ ...server })),
        warnings: [],
      };
    },
    resolve: async (
      _cli: string,
      _projectDir: string,
      selection: readonly McpSelection[],
    ): Promise<Result<{ extra: ResolvedMcpServer[]; known: typeof KNOWN }, DevChestraError>> => {
      calls.resolve += 1;
      if (options.listThrows === true && selection.length === 0) {
        throw new Error("mcp discovery exploded");
      }
      calls.selections.push(selection.map((item) => ({ ...item })));
      if (options.resolveError !== undefined) return err(options.resolveError);
      return ok({ extra: options.extra ?? EXTRA, known: options.known ?? KNOWN });
    },
  };
}

function workflow(agentExtra: Record<string, unknown>, limits?: Record<string, number>): unknown {
  return {
    schemaVersion: 1,
    id: "mcp-shell",
    name: "MCP shell",
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
          limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0, ...limits },
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

interface Harness {
  ctx: EngineContext;
  store: Store;
  runId: string;
  plan: WorkflowPlan;
  node: PlanNode;
  active: ActiveRunState;
  requests: RunRequest[];
  runAgentCalls: () => number;
  events: (type: string) => Array<{ path: string; payload: Record<string, unknown> }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  mocks.runAgent.mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(
  specs: AttemptSpec[],
  options: {
    agent?: Record<string, unknown>;
    limits?: Record<string, number>;
    resolver?: McpResolver;
  } = {},
): Harness {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-mcpshell-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const snapshot = workflow(options.agent ?? {}, options.limits);
  const created = store.runs.create({
    projectId: "p1",
    workflowId: "mcp-shell",
    workflowHash: "hash",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  });
  const plan = planOf(snapshot);
  const node = plan.nodes.find((entry) => entry.id === "a");
  if (node === undefined) throw new Error("missing node");

  const requests: RunRequest[] = [];
  let runAgentCalls = 0;
  let classifyCalls = 0;
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
    plan: (request: RunRequest) => {
      requests.push(request);
      const checkpoint =
        typeof request.cliOptions?.checkpoint === "string"
          ? request.cliOptions.checkpoint
          : undefined;
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
    classify: () => {
      const spec = specs[Math.min(classifyCalls, specs.length - 1)];
      classifyCalls += 1;
      if (spec === undefined) throw new Error("no classify spec configured");
      return spec.classify;
    },
    probe: async () => ({ ok: true, version: "test" }),
  };
  const registry: AdapterRegistry = {
    ids: () => ["fake"],
    has: (id: string) => id === "fake",
    get: () => stub as never,
  };

  mocks.runAgent.mockImplementation(
    async (
      _invocation: unknown,
      hooks: {
        onSpawn: (spawn: { pid: number; pidStart: string; binary: string; cwd: string }) => void;
        onEvent: (event: AdapterEvent) => void;
        onStderr: (chunk: string) => void;
        onTranscript: (entry: { ts: string; kind: string; text: string }) => void;
      },
    ) => {
      const index = runAgentCalls;
      runAgentCalls += 1;
      const spec = specs[Math.min(index, specs.length - 1)];
      if (spec === undefined) throw new Error("no runAgent spec configured");
      const pid = 1000 + index;
      await hooks.onSpawn({
        pid,
        pidStart: `test:${pid}`,
        binary: "/bin/agent",
        cwd: join(dataDir, "scratch", "a"),
      });
      hooks.onStderr("warning: slow line\n");
      hooks.onTranscript({ ts: new Date().toISOString(), kind: "system", text: "note" });
      if (spec.acceptMidRun === true) {
        const current = store.executions.get(created.runId as never, "a" as Path);
        if (current === null) throw new Error("missing execution");
        store.submissions.submit({
          identity: {
            runId: created.runId,
            path: "a" as Path,
            attempt: current.attempt,
            generation: current.generation,
          },
          callId: `agent-accept-${index}`,
          request: { name: "submit_result", arguments: { ok: true } },
          ok: true as const,
          output: { ok: true },
          schemaHash: "schema",
        });
      }
      for (const event of spec.events ?? []) await hooks.onEvent(event);
      return {
        code: 1,
        signal: null,
        killedBy: null,
        durationMs: 1,
        pid,
        stdoutBytes: 0,
        stderrBytes: 0,
        sawTurnEnd: false,
        groupStopped: true,
        ...spec.exit,
        tail: { stdout: "", stderr: "" },
      };
    },
  );

  const abortController = new AbortController();
  const ctx = new EngineContext({
    store,
    adapters: registry,
    workspaces: {
      prepare: async () => {
        throw new DevChestraError("E_INTERNAL", "run-level workspace is not used in this test");
      },
      acquire: async (request) => {
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
      finalize: async (target, request) =>
        ok({
          dir: (target as { dir: string }).dir,
          attempt: (request.process as { attempt: number }).attempt,
          generation: (request.process as { generation: number }).generation,
          outcome: request.outcome,
          alreadyFinalized: false,
          markerFile: (target as { markerFile: string }).markerFile,
          process: request.process,
        }),
      release: () => undefined,
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "test-token", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: { ...process.env, DEVCHESTRA_ALLOW_FAKE: "1" },
    ...(options.resolver === undefined ? {} : { mcpResolver: options.resolver }),
  });
  const active: ActiveRunState = { abort: abortController, reason: null, tokens: new Set() };
  return {
    ctx,
    store,
    runId: created.runId as string,
    plan,
    node: node as PlanNode,
    active,
    requests,
    runAgentCalls: () => runAgentCalls,
    events: (type: string) =>
      store.events
        .list(created.runId as never, { limit: 100_000 })
        .filter((event) => event.type === type)
        .map((event) => ({
          path: event.path as string,
          payload: event.payload as Record<string, unknown>,
        })),
  };
}

async function runAgent(harness: Harness): Promise<{ error?: unknown }> {
  try {
    await executeAgent(
      harness.ctx,
      harness.ctx.run(harness.runId),
      isolated(harness.plan),
      harness.node,
      harness.active,
    );
    return {};
  } catch (error) {
    return { error };
  }
}

function leakScan(harness: Harness): string[] {
  const haystacks = [
    JSON.stringify(harness.store.events.list(harness.runId as never, { limit: 100_000 })),
  ];
  return [SECRET].filter((needle) => haystacks.some((hay) => hay.includes(needle)));
}

const SUCCESS: AttemptSpec[] = [
  { classify: { kind: "ok" }, acceptMidRun: true, exit: { code: 0 } },
];

describe("engine agent MCP servers and shell toggle", () => {
  it("resolves the selection and passes extraMcp, knownMcp and shell to the adapter", async () => {
    const h = setup(SUCCESS, {
      agent: {
        permissions: { network: false, write: [], shell: true },
        mcpServers: [{ name: "github", scope: "global" }],
      },
      resolver: fakeResolver({}),
    });
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as RunRequest;
    expect(request.permissions).toMatchObject({ network: false, write: [], shell: true });
    expect(request.extraMcp).toEqual(EXTRA);
    expect(request.knownMcp).toEqual(KNOWN);

    const resolved = h.events("node.input.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload.inputs).toMatchObject({
      tools: { shell: true, servers: [{ name: "github", scope: "global" }] },
    });
    expect(leakScan(h)).toEqual([]);
  });

  it("fails the node fast with a names-only error when a server is missing", async () => {
    const h = setup(SUCCESS, {
      agent: {
        permissions: { network: false, write: [] },
        mcpServers: [{ name: "nope", scope: "global" }],
      },
      resolver: fakeResolver({
        resolveError: new DevChestraError("E_CLI_MISSING", "unknown MCP server 'global:nope'"),
      }),
    });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_MISSING" });
    expect(String((error as Error).message)).toContain("global:nope");
    // Failed before launch: no process, no recorded inputs.
    expect(h.runAgentCalls()).toBe(0);
    expect(h.requests).toHaveLength(0);
    expect(h.events("node.input.resolved")).toHaveLength(0);
    expect(leakScan(h)).toEqual([]);
  });

  it("strips secret-carrying resolver details from the failure", async () => {
    const h = setup(SUCCESS, {
      agent: {
        permissions: { network: false, write: [] },
        mcpServers: [{ name: "nope", scope: "global" }],
      },
      resolver: fakeResolver({
        resolveError: new DevChestraError("E_CLI_MISSING", "unknown MCP server 'global:nope'", {
          details: { token: SECRET, servers: [{ name: "nope", scope: "global" }] },
        }),
      }),
    });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_MISSING" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(JSON.stringify((error as DevChestraError).details)).toContain("nope");
    expect(leakScan(h)).toEqual([]);
  });

  it("fails with a clear error when a selection exists but no resolver is configured", async () => {
    const h = setup(SUCCESS, {
      agent: {
        permissions: { network: false, write: [] },
        mcpServers: [{ name: "github", scope: "global" }],
      },
    });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_MISSING" });
    expect(String((error as Error).message)).toContain("no MCP resolver is configured");
    expect(String((error as Error).message)).toContain("global:github");
    expect(h.runAgentCalls()).toBe(0);
  });

  it("sends no selection but fills knownMcp when nothing is selected", async () => {
    const h = setup(SUCCESS, { resolver: fakeResolver({}) });
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as RunRequest;
    expect(request.extraMcp).toBeUndefined();
    expect(request.knownMcp).toEqual(KNOWN);
    expect(request.permissions).not.toHaveProperty("shell");
    const resolved = h.events("node.input.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload.inputs).toMatchObject({ tools: { shell: null, servers: [] } });
    expect(leakScan(h)).toEqual([]);
  });

  it("never fails the node when discovery for an empty selection fails", async () => {
    const h = setup(SUCCESS, { resolver: fakeResolver({ listThrows: true }) });
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.extraMcp).toBeUndefined();
    expect(h.requests[0]?.knownMcp).toBeUndefined();
  });

  it.each([undefined, true, false] as const)(
    "passes shell=%s through to the adapter exactly",
    async (shell) => {
      const h = setup(SUCCESS, {
        agent: {
          permissions:
            shell === undefined
              ? { network: true, write: ["workspace"] }
              : { network: true, write: ["workspace"], shell },
        },
        resolver: fakeResolver({}),
      });
      const { error } = await runAgent(h);
      expect(error).toBeUndefined();
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0] as RunRequest;
      if (shell === undefined) {
        expect("shell" in request.permissions).toBe(false);
      } else {
        expect(request.permissions.shell).toBe(shell);
      }
      const resolved = h.events("node.input.resolved");
      expect(resolved[0]?.payload.inputs).toMatchObject({
        tools: { shell: shell ?? null, servers: [] },
      });
    },
  );

  it("re-resolves on retry so a resume sees the current CLI config", async () => {
    const calls: ResolverCalls = { list: 0, resolve: 0, selections: [] };
    const h = setup(
      [
        { classify: { kind: "crash", exitCode: 1, signal: null } },
        { classify: { kind: "ok" }, acceptMidRun: true, exit: { code: 0 } },
      ],
      {
        agent: {
          permissions: { network: false, write: [] },
          mcpServers: [{ name: "github", scope: "global" }],
        },
        limits: { crashRetries: 1 },
        resolver: fakeResolver({ calls }),
      },
    );
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(2);
    expect(calls.resolve).toBe(2);
    expect(calls.selections).toEqual([
      [{ name: "github", scope: "global" }],
      [{ name: "github", scope: "global" }],
    ]);
    expect(leakScan(h)).toEqual([]);
  });
});
