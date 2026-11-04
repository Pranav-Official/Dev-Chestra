import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DevChestraError, type ErrorCode, err, ok, type Path } from "@devchestra/core";
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
  ExitInfo,
  FailureClass,
  RunRequest,
} from "@devchestra/adapters";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { executeAgent } from "../src/exec-agent.js";
import type { PlanNode, WorkflowPlan } from "../src/graph-plan.js";
import { ProcessGroupAliveError, StopSignal } from "../src/stop.js";
import { isolated, planOf } from "./plan-source.js";

/**
 * Characterization tests for `runAttempts` (packages/engine/src/exec-agent.ts).
 *
 * These pin the CURRENT observable behavior of the retry loop, pre-flight
 * policy checks, event handling and failure mapping before the TD-006
 * refactor. They drive the private `runAttempts` through the public
 * `executeAgent` entry point so they survive extraction refactors unchanged.
 *
 * Invariants pinned here (see final TD-006 report for the full list):
 * - experimental adapters are gated before any process dispatch;
 * - every attempt records spawn identity, input hash, stop evidence and a
 *   transcript ref, in that causal order;
 * - usage deltas settle cumulative vs absolute adapter reports;
 * - crash/timeout stop reasons consume the crash budget; quota/auth pause;
 * - the exec token is revoked and removed from the abort set on every path.
 */

const GATEWAY_TOKEN = "test-token-12345-67890";

interface AttemptSpec {
  /** Events emitted via hooks.onEvent, in order, after onSpawn. */
  events?: AdapterEvent[];
  /** What adapter.classify returns for this attempt. */
  classify: FailureClass;
  /** Exit overrides for this attempt. */
  exit?: Partial<ExitInfo> & { tail?: { stdout: string; stderr: string } };
  /** Submit a rejected receipt mid-run (simulates agent junk before exit). */
  preSubmitInvalid?: boolean;
  /** Submit an accepted receipt mid-run for the live identity. */
  acceptMidRun?: boolean;
  /** Sleep after events (lets the accept grace timer fire). */
  afterEventsSleepMs?: number;
  /** Throw after events/sleep instead of returning an exit. */
  throwAfterEvents?: "stop";
  /** Abort the run mid-attempt. */
  abortDuringRun?: boolean;
  /** pidStart reported by onSpawn; defaults to `test:<pid>`. */
  pidStart?: string;
}

interface Harness {
  ctx: EngineContext;
  store: Store;
  runId: string;
  plan: WorkflowPlan;
  node: PlanNode;
  active: ActiveRunState;
  runAgentCalls: () => number;
  prompts: () => string[];
  modes: () => Array<"fresh" | "resume">;
  execDirs: () => string[];
  revokes: () => number;
  acquires: () => number;
  releases: () => number;
  finalizes: () => Array<{ outcome: string; reason: string }>;
  events: (type: string) => Array<{ path: string; payload: Record<string, unknown> }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  mocks.runAgent.mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function workflow(cli: string, limits: Record<string, number>): unknown {
  return {
    schemaVersion: 1,
    id: "characterization",
    name: "Characterization",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "a",
          type: "agent",
          name: "Work",
          cli,
          prompt: "do work",
          output: { type: "object", properties: { ok: { type: "boolean" } } },
          permissions: { network: false, write: [] },
          workspace: { mode: "scratch" },
          limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0, ...limits },
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

function registryFor(
  specs: AttemptSpec[],
  seen: { prompts: string[]; modes: Array<"fresh" | "resume">; execDirs: string[] },
  planError?: { code: ErrorCode; message: string },
  omitCheckpoint?: boolean,
): AdapterRegistry {
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
      seen.prompts.push(request.prompt);
      seen.modes.push(request.mode);
      seen.execDirs.push(request.execDir);
      if (planError !== undefined) {
        return err(new DevChestraError(planError.code, planError.message));
      }
      // Mirror the real fake provider: resume is only honored when the
      // checkpoint from the previous attempt is on disk. Without this the
      // engine downgrades resume to fresh (see effectiveMode).
      const checkpoint =
        typeof request.cliOptions?.checkpoint === "string" && omitCheckpoint !== true
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
  const codexStub = {
    ...stub,
    id: "codex" as const,
    evidence: { ...stub.evidence, behaviorVerified: false },
  };
  return {
    ids: () => ["fake", "codex"],
    has: (id: string) => id === "fake" || id === "codex",
    get: (id: string) => (id === "codex" ? codexStub : stub) as never,
  };
}

// Avoid a top-level import cycle in the test double: DevChestraError comes from the
// real @devchestra/core which the mock above leaves intact.

function setup(
  specs: AttemptSpec[],
  options: {
    cli?: string;
    limits?: Record<string, number>;
    allowExperimentalClis?: Array<"claude-code" | "codex">;
    finishGraceMs?: number;
    omitCheckpoint?: boolean;
    planError?: { code: ErrorCode; message: string };
    generationOverride?: number;
  } = {},
): Harness {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-runattempts-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project);
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const snapshot = workflow(options.cli ?? "fake", options.limits ?? {});
  const created = store.runs.create({
    projectId: "p1",
    workflowId: "characterization",
    workflowHash: "hash",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  });
  const plan = planOf(snapshot);
  const node = plan.nodes.find((entry) => entry.id === "a");
  if (node === undefined) throw new Error("missing node");

  const seen = {
    prompts: [] as string[],
    modes: [] as Array<"fresh" | "resume">,
    execDirs: [] as string[],
  };
  let runAgentCalls = 0;
  let revokes = 0;
  let acquires = 0;
  let releases = 0;
  const finalizes: Array<{ outcome: string; reason: string }> = [];
  const abortController = new AbortController();

  mocks.runAgent.mockImplementation(
    async (
      _invocation: unknown,
      hooks: {
        onSpawn: (spawn: {
          pid: number;
          pidStart: string;
          binary: string;
          cwd: string;
        }) => Promise<void> | void;
        onEvent: (event: AdapterEvent) => Promise<void> | void;
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
        pidStart: spec.pidStart ?? `test:${pid}`,
        binary: "/bin/agent",
        cwd: join(dataDir, "scratch", "a"),
      });
      // Pin the transcript taps on every attempt.
      hooks.onStderr("warning: slow line\n");
      hooks.onTranscript({ ts: new Date().toISOString(), kind: "system", text: "note" });
      if (spec.preSubmitInvalid === true) {
        const current = store.executions.get(created.runId as never, "a" as Path);
        if (current === null) throw new Error("missing execution");
        store.submissions.submit({
          identity: {
            runId: created.runId,
            path: "a" as Path,
            attempt: current.attempt,
            generation: current.generation,
          },
          callId: `agent-junk-${index}`,
          request: { name: "submit_result", arguments: { ok: "not-a-boolean" } },
          ok: false as const,
          errors: [{ path: "/ok", message: "expected boolean" }],
        });
      }
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
          ok: true,
          output: { ok: true },
          schemaHash: "schema",
        });
      }
      for (const event of spec.events ?? []) await hooks.onEvent(event);
      if (spec.afterEventsSleepMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, spec.afterEventsSleepMs));
      }
      if (spec.abortDuringRun === true) abortController.abort();
      if (spec.throwAfterEvents === "stop") throw new StopSignal("user");
      const tail = spec.exit?.tail ?? { stdout: "", stderr: "" };
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
        tail,
      };
    },
  );

  const ctx = new EngineContext({
    store,
    adapters: registryFor(specs, seen, options.planError, options.omitCheckpoint),
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
        acquires += 1;
        const dir = join(dataDir, "scratch", request.path as string);
        mkdirSync(dir, { recursive: true });
        const generation =
          options.generationOverride !== undefined && acquires === 1
            ? options.generationOverride
            : (request.generation as number);
        return ok({
          mode: "scratch",
          dataDir,
          projectId: request.projectId,
          runId: request.runId,
          path: request.path as Path,
          attempt: request.attempt as number,
          generation,
          dir,
          markerFile: join(dir, `.marker-${request.attempt as number}-${generation}`),
          reused: (request as { requireExisting?: boolean }).requireExisting === true,
          projectRoot: null,
        } as never);
      },
      finalize: async (target, request) => {
        finalizes.push({
          outcome: request.outcome as string,
          reason: (request.process as { reason?: string }).reason ?? "",
        });
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
        releases += 1;
      },
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => {
        let revoked = false;
        return {
          token: GATEWAY_TOKEN,
          revoke: () => {
            // Match ExecTokenRegistry: count effective revocations, not cleanup calls.
            if (revoked) return;
            revoked = true;
            revokes += 1;
          },
        };
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: { ...process.env, DEVCHESTRA_ALLOW_FAKE: "1" },
    ...(options.allowExperimentalClis === undefined
      ? {}
      : { allowExperimentalClis: options.allowExperimentalClis }),
    ...(options.finishGraceMs === undefined ? {} : { finishGraceMs: options.finishGraceMs }),
  });
  const active: ActiveRunState = { abort: abortController, reason: null, tokens: new Set() };
  return {
    ctx,
    store,
    runId: created.runId as string,
    plan,
    node: node as PlanNode,
    active,
    runAgentCalls: () => runAgentCalls,
    prompts: () => seen.prompts,
    modes: () => seen.modes,
    execDirs: () => seen.execDirs,
    revokes: () => revokes,
    acquires: () => acquires,
    releases: () => releases,
    finalizes: () => finalizes,
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

function stoppedReasons(harness: Harness): unknown[] {
  return harness.events("node.process.stopped").map((event) => event.payload.reason);
}

describe("runAttempts pre-flight policy checks", () => {
  it("rejects an unregistered cli id before any dispatch", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }], { cli: "nope" });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_MISSING" });
    expect(String((error as Error).message)).toContain("not available");
    expect(h.runAgentCalls()).toBe(0);
    expect(h.events("node.process.spawned")).toHaveLength(0);
    // TD-007: the CLI gate used to throw after workspace acquisition and
    // outside the release try/finally (acquire without release, a leak). The
    // gate now runs before beginInvocation/acquire, so nothing is acquired
    // and no durable attempt is recorded on this path.
    expect(h.acquires()).toBe(0);
    expect(h.releases()).toBe(0);
    expect(h.events("workspace.created")).toHaveLength(0);
    expect(h.events("node.attempt.started")).toHaveLength(0);
    expect(h.active.tokens.size).toBe(0);
  });

  it("lets an official real cli through without any opt-in", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }], {
      cli: "codex",
    });
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
  });

  it("aborts before the first attempt when already cancelled", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }]);
    h.active.abort.abort();
    h.active.reason = "user";
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.runAgentCalls()).toBe(0);
    expect(h.events("node.process.spawned")).toHaveLength(0);
  });

  it("a failing adapter plan rejects without dispatch and still revokes", async () => {
    const h = setup([{ classify: { kind: "crash", exitCode: 1, signal: null } }], {
      planError: { code: "E_WORKSPACE", message: "bad plan" },
    });
    const { error } = await runAgent(h);
    // Lifecycle fix: setup/planning failures persist Failed with the
    // original error (no Running left behind) instead of only revoking.
    expect(error).toMatchObject({ code: "E_WORKSPACE", message: "bad plan" });
    expect(h.runAgentCalls()).toBe(0);
    expect(h.revokes()).toBe(1);
    expect(h.active.tokens.size).toBe(0);
    expect(h.finalizes()).toEqual([{ outcome: "failed", reason: "crash" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("failed");
    expect(h.events("error.logged").some((event) => event.payload.code === "E_WORKSPACE")).toBe(
      true,
    );
  });
});

describe("runAttempts single-attempt mechanics", () => {
  it("records spawn, input, stop and transcript refs for one attempt", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    const spawned = h.events("node.process.spawned");
    expect(spawned).toHaveLength(1);
    // ensure() seeds generation 1, so the first beginInvocation yields 2.
    expect(spawned[0]?.payload).toMatchObject({
      attempt: 1,
      generation: 2,
      pid: 1000,
      pidStart: "test:1000",
      binary: "/bin/agent",
    });
    expect(h.events("node.input.resolved")).toHaveLength(1);
    expect(stoppedReasons(h)).toEqual(["exited"]);
    const refs = h.events("node.transcript.ref");
    expect(refs).toHaveLength(1);
    expect(typeof refs[0]?.payload.file).toBe("string");
    // Fencing: exec dir is locked down and the token is revoked.
    const execDir = (spawned[0]?.payload.cwd as string) ?? "";
    expect(execDir.length).toBeGreaterThan(0);
    expect(h.revokes()).toBe(1);
    expect(h.active.tokens.size).toBe(0);
  });

  it("creates the exec dir with mode 0700", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }]);
    await runAgent(h);
    // Fencing: the planned exec dir is created locked down (no group/other).
    expect(h.execDirs()).toHaveLength(1);
    expect(statSync(h.execDirs()[0] as string).mode & 0o777).toBe(0o700);
  });

  it("settles cumulative usage into per-attempt deltas", async () => {
    const h = setup([
      {
        classify: { kind: "quota_window", source: "parsed" },
        events: [
          { t: "usage", tokensIn: 100, tokensOut: 50, costUsd: 2, cumulative: true },
          { t: "usage", tokensIn: 120, tokensOut: 70, costUsd: 3, cumulative: true },
          { t: "usage", tokensIn: 5, tokensOut: 6, cumulative: false },
          // A repeat cumulative report settles to an all-zero delta (no keys).
          { t: "usage", tokensIn: 120, tokensOut: 70, costUsd: 3, cumulative: true },
          // A usage report without counters defaults them to zero.
          { t: "usage", cumulative: true },
          // Unhandled event kinds fall through without affecting the run.
          { t: "notice", level: "info", text: "hello" },
        ],
      },
    ]);
    await runAgent(h);
    const usage = h.events("node.usage").map((event) => event.payload);
    expect(usage).toEqual([
      expect.objectContaining({ tokensIn: 100, tokensOut: 50, costUsd: 2, costSource: "reported" }),
      expect.objectContaining({ tokensIn: 20, tokensOut: 20, costUsd: 1, costSource: "reported" }),
      expect.objectContaining({ tokensIn: 5, tokensOut: 6, costSource: "none" }),
      expect.objectContaining({ costSource: "reported" }),
      expect.objectContaining({ costSource: "none" }),
    ]);
    // The zero-delta report carries no usage keys at all.
    expect(usage[3]).not.toHaveProperty("tokensIn");
    expect(usage[3]).not.toHaveProperty("tokensOut");
    expect(usage[3]).not.toHaveProperty("costUsd");
    expect(usage[4]).toEqual(expect.objectContaining({ attempt: 1, costSource: "none" }));
  });

  it("dedups repeat session events and keeps the latest session", async () => {
    const h = setup([
      {
        classify: { kind: "quota_window", source: "parsed" },
        events: [
          { t: "session", sessionId: "s1" },
          { t: "session", sessionId: "s1" },
          { t: "session", sessionId: "s2" },
        ],
      },
    ]);
    await runAgent(h);
    const sessions = h.events("node.session.captured");
    expect(sessions.map((event) => event.payload.sessionId)).toEqual(["s1", "s2"]);
    expect(h.ctx.execution(h.runId, "a").sessionId).toBe("s2");
  });

  it("re-acquires the workspace when the generation moved on", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }], {
      generationOverride: 999,
    });
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(h.events("workspace.created")).toHaveLength(2);
    // Old workspace released in the loop, current one on the way out.
    expect(h.releases()).toBe(2);
  });
});

describe("runAttempts outcome classification", () => {
  it("quota pauses the run and marks the execution interrupted", async () => {
    const h = setup([{ classify: { kind: "quota_window", source: "parsed" } }]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    const paused = h.events("run.paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.payload).toMatchObject({ reason: "quota" });
    const states = h.events("node.state").filter((event) => event.payload.to === "interrupted");
    expect(states.map((event) => event.payload.reason)).toEqual(["quota"]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("interrupted");
  });

  it("auth pauses with the budget reason", async () => {
    const h = setup([{ classify: { kind: "auth" } }]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.events("run.paused")[0]?.payload).toMatchObject({ reason: "budget" });
  });

  it("credits map to the auth pause path", async () => {
    const h = setup([{ classify: { kind: "credits" } }]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(h.events("run.paused")[0]?.payload).toMatchObject({ reason: "budget" });
    const states = h.events("node.state").filter((event) => event.payload.to === "interrupted");
    expect(states.map((event) => event.payload.reason)).toEqual(["auth"]);
  });

  it("rate_limit retries instead of pausing", async () => {
    const h = setup([
      { classify: { kind: "rate_limit" } },
      { classify: { kind: "quota_window", source: "parsed" } },
    ]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(2);
    expect(h.modes()).toEqual(["fresh", "fresh"]);
    // First decision block interrupts for rate_limit, then the retry's stop
    // for quota interrupts again. The retry-loop transition for the first
    // attempt is suppressed: the execution is already interrupted, and
    // transitionInterrupted only fires from running/validating.
    const reasons = h
      .events("node.state")
      .filter((event) => event.payload.to === "interrupted")
      .map((event) => event.payload.reason);
    expect(reasons).toEqual(["rate_limit", "quota"]);
    expect(h.events("run.paused")).toHaveLength(1);
  });

  it("cli_missing surfaces E_CLI_MISSING without retry", async () => {
    const h = setup([{ classify: { kind: "cli_missing" } }]);
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_MISSING" });
    expect(String((error as Error).message)).toContain("binary is missing");
    expect(h.runAgentCalls()).toBe(1);
    // Cleanup may revoke repeatedly, but the issued token is invalidated once.
    expect(h.revokes()).toBe(1);
  });

  it("cancel kills the execution, finalizes cancelled and throws StopSignal", async () => {
    const h = setup([
      { classify: { kind: "cancelled" }, exit: { killedBy: "cancel", signal: "SIGTERM" } },
    ]);
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.finalizes()).toEqual([{ outcome: "cancelled", reason: "killed" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("cancelled");
    expect(stoppedReasons(h)).toEqual(["killed"]);
    // Stop and catch cleanup share the same idempotent revocation.
    expect(h.revokes()).toBe(1);
    expect(h.active.tokens.size).toBe(0);
  });

  it("a shutdown cancel interrupts instead of cancelling", async () => {
    const h = setup([
      { classify: { kind: "cancelled" }, exit: { killedBy: "cancel", signal: "SIGTERM" } },
    ]);
    h.active.reason = "shutdown";
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.finalizes()).toEqual([{ outcome: "cancelled", reason: "killed" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("interrupted");
    expect(stoppedReasons(h)).toEqual(["killed"]);
  });

  it("a live process group after the kill grace pauses with shutdown", async () => {
    const h = setup([
      {
        classify: { kind: "crash", exitCode: 1, signal: null },
        exit: { groupStopped: false, tail: { stdout: "", stderr: "" } },
      },
    ]);
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(ProcessGroupAliveError);
    expect(h.events("run.paused")[0]?.payload).toMatchObject({ reason: "shutdown" });
    expect(h.events("error.logged").some((event) => event.payload.code === "E_WORKSPACE")).toBe(
      true,
    );
    expect(h.finalizes()).toHaveLength(0);
  });

  it("a crash with no retries left fails fast with E_CLI_CRASH", async () => {
    const h = setup([{ classify: { kind: "crash", exitCode: 1, signal: "SIGSEGV" } }], {
      limits: { crashRetries: 0 },
    });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_CRASH" });
    expect(h.runAgentCalls()).toBe(1);
    expect(stoppedReasons(h)).toEqual(["crash"]);
    expect(h.finalizes()).toEqual([{ outcome: "failed", reason: "crash" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("failed");
  });

  it("timeout consumes the crash budget and then fails", async () => {
    const h = setup([{ classify: { kind: "timeout" } }], { limits: { crashRetries: 0 } });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_CRASH" });
    // stopReason maps an unaccepted timeout to "crash", spending crash budget.
    expect(stoppedReasons(h)).toEqual(["crash"]);
  });

  it("repeated crashes with a session resume until the crash budget is spent", async () => {
    const h = setup(
      [
        {
          classify: { kind: "crash", exitCode: 1, signal: null },
          events: [{ t: "session", sessionId: "s1" }],
        },
        { classify: { kind: "crash", exitCode: 1, signal: null } },
        { classify: { kind: "crash", exitCode: 1, signal: null } },
      ],
      { limits: { crashRetries: 2 } },
    );
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_CLI_CRASH" });
    expect(h.runAgentCalls()).toBe(3);
    expect(h.modes()).toEqual(["fresh", "resume", "resume"]);
    // Second attempt resumes with the base prompt, not the no-submit prompt.
    expect(h.prompts()[1]).not.toContain("without calling submit_result");
    // Every crash stop spends budget: two crashes then the limit trips.
    expect(stoppedReasons(h)).toEqual(["crash", "crash", "crash"]);
  });

  it("context_overflow retries fresh without a session", async () => {
    const h = setup(
      [
        // A signaled non-timeout, non-crash exit still records a crash stop.
        { classify: { kind: "context_overflow" }, exit: { signal: "SIGKILL" } },
        { classify: { kind: "quota_window", source: "parsed" } },
      ],
      { limits: { crashRetries: 5 } },
    );
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(2);
    expect(h.modes()).toEqual(["fresh", "fresh"]);
    expect(stoppedReasons(h)).toEqual(["crash", "exited"]);
  });

  it("an adapter-reported cancellation stops gracefully without throwing", async () => {
    // classify says cancelled but nothing was killed: this exercises the
    // cancelled arm of the failure mapping (not the killedBy fast path) and
    // the stop branch of the retry decision.
    const h = setup([{ classify: { kind: "cancelled" } }]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(stoppedReasons(h)).toEqual(["exited"]);
    expect(h.finalizes()).toHaveLength(0);
    expect(h.revokes()).toBe(1);
    expect(h.events("run.paused")).toHaveLength(0);
  });

  it("a no-submit with no validation budget left fails immediately", async () => {
    const longStderr = `leak ${GATEWAY_TOKEN} ${"x".repeat(3000)}`;
    const h = setup(
      [
        {
          classify: { kind: "ok" },
          exit: { tail: { stdout: "", stderr: longStderr } },
        },
      ],
      { limits: { validationRetries: 0, crashRetries: 5 } },
    );
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_ATTEMPTS_EXHAUSTED" });
    expect(h.runAgentCalls()).toBe(1);
    const logged = h.events("error.logged");
    expect(logged.length).toBeGreaterThan(0);
    const details = logged[logged.length - 1]?.payload as {
      details?: { stderr?: string };
      error?: { details?: { stderr?: string } };
    };
    const stderr =
      details.details?.stderr ?? details.error?.details?.stderr ?? JSON.stringify(details);
    // Fencing: the exec token is redacted and the diagnostic is bounded.
    expect(stderr).not.toContain(GATEWAY_TOKEN);
    expect(stderr).toContain("[redacted]");
    expect(stderr.endsWith("…[truncated]")).toBe(true);
    expect(stderr.length).toBeLessThan(2200);
  });

  it("a no-submit after a rejected submit hits the exhausted-consume path", async () => {
    const h = setup([{ classify: { kind: "ok" }, preSubmitInvalid: true }], {
      limits: { validationRetries: 0, crashRetries: 5 },
    });
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_ATTEMPTS_EXHAUSTED" });
    expect(h.runAgentCalls()).toBe(1);
    // The agent's junk submit is durably recorded before the no-submit.
    expect(h.events("node.output.rejected")).toHaveLength(1);
  });

  it("resume degrades to fresh when the fake checkpoint is missing", async () => {
    const h = setup(
      [
        {
          classify: { kind: "crash", exitCode: 1, signal: null },
          events: [{ t: "session", sessionId: "s1" }],
        },
        { classify: { kind: "quota_window", source: "parsed" } },
      ],
      { limits: { crashRetries: 5 }, omitCheckpoint: true },
    );
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(2);
    // The retry decision is resume (session present), but without the
    // checkpoint file the fake adapter restarts fresh.
    expect(h.modes()).toEqual(["fresh", "fresh"]);
    expect(stoppedReasons(h)).toEqual(["crash", "exited"]);
  });

  it("resume with pending no-submits re-prompts to submit", async () => {
    const h = setup(
      [
        {
          classify: { kind: "ok" },
          events: [{ t: "session", sessionId: "s1" }],
        },
        { classify: { kind: "ok" } },
      ],
      { limits: { validationRetries: 1, crashRetries: 5 } },
    );
    const { error } = await runAgent(h);
    expect(error).toMatchObject({ code: "E_ATTEMPTS_EXHAUSTED" });
    expect(h.runAgentCalls()).toBe(2);
    expect(h.modes()).toEqual(["fresh", "resume"]);
    expect(h.prompts()[1]).toContain("without calling submit_result");
  });

  it("StopSignal mid-run finalizes cancelled and rethrows", async () => {
    const h = setup([{ classify: { kind: "crash", exitCode: 1, signal: null } }]);
    mocks.runAgent.mockImplementationOnce(async () => {
      throw new StopSignal("user");
    });
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.finalizes()).toEqual([{ outcome: "cancelled", reason: "killed" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("cancelled");
    expect(h.revokes()).toBe(1);
    expect(h.active.tokens.size).toBe(0);
  });

  it("an early accepted result finalizes without dispatch", async () => {
    const h = setup([{ classify: { kind: "crash", exitCode: 1, signal: null } }]);
    const execution = h.store.executions.ensure({
      runId: h.runId as never,
      path: "a" as Path,
      nodeId: "a",
      kind: "agent",
      validationLimit: 2,
    });
    const identity = h.store.executions.beginInvocation({
      runId: h.runId as never,
      path: "a" as Path,
      attempt: execution.attempt,
    });
    h.store.submissions.submit({
      identity,
      callId: "valid-1",
      request: { name: "submit_result", arguments: { ok: true } },
      ok: true,
      output: { ok: true },
      schemaHash: "schema",
    });
    const first = await runAgent(h);
    expect(first.error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(0);
    expect(h.ctx.execution(h.runId, "a").status).toBe("succeeded");
    // A second run is a no-op once the execution has succeeded.
    const second = await runAgent(h);
    expect(second.error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(0);
  });

  it("a timeout with an accepted result records a grace stop", async () => {
    const h = setup([
      {
        classify: { kind: "timeout" },
        acceptMidRun: true,
        exit: { code: 1, signal: null, tail: { stdout: "", stderr: "" } },
      },
    ]);
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(stoppedReasons(h)).toEqual(["grace_timeout"]);
    expect(h.finalizes()).toEqual([{ outcome: "success", reason: "grace_timeout" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("succeeded");
  });

  it("an acceptance mid-run finalizes success after the grace kill", async () => {
    const h = setup(
      [
        {
          classify: { kind: "ok" },
          acceptMidRun: true,
          events: [{ t: "tool_result", id: "1", ok: true, summary: "done" }],
          afterEventsSleepMs: 300,
          exit: { code: 0, tail: { stdout: "", stderr: "" } },
        },
      ],
      { finishGraceMs: 50 },
    );
    const { error } = await runAgent(h);
    expect(error).toBeUndefined();
    expect(h.runAgentCalls()).toBe(1);
    expect(stoppedReasons(h)).toEqual(["grace_timeout"]);
    expect(h.finalizes()).toEqual([{ outcome: "success", reason: "grace_timeout" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("succeeded");
  });

  it("a cancel after a mid-run acceptance still cancels", async () => {
    const h = setup(
      [
        {
          classify: { kind: "ok" },
          acceptMidRun: true,
          events: [{ t: "tool_result", id: "1", ok: true, summary: "done" }],
          afterEventsSleepMs: 300,
          throwAfterEvents: "stop",
        },
      ],
      { finishGraceMs: 50 },
    );
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.finalizes()).toEqual([{ outcome: "cancelled", reason: "killed" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("cancelled");
    expect(stoppedReasons(h)).toEqual([]);
  });

  it("an abort between attempts stops the loop at the generation boundary", async () => {
    const h = setup([{ classify: { kind: "crash", exitCode: 1, signal: null } }], {
      limits: { crashRetries: 5 },
    });
    // Abort on the first attempt: the loop top converts it to StopSignal.
    h.active.abort.abort();
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.runAgentCalls()).toBe(0);
  });

  it("an abort during an attempt surfaces at the next loop top", async () => {
    const h = setup(
      [
        { classify: { kind: "crash", exitCode: 1, signal: null }, abortDuringRun: true },
        { classify: { kind: "crash", exitCode: 1, signal: null } },
      ],
      { limits: { crashRetries: 5 } },
    );
    const { error } = await runAgent(h);
    expect(error).toBeInstanceOf(StopSignal);
    expect(h.runAgentCalls()).toBe(1);
    expect(h.finalizes()).toEqual([{ outcome: "cancelled", reason: "killed" }]);
    expect(h.ctx.execution(h.runId, "a").status).toBe("cancelled");
  });
});
