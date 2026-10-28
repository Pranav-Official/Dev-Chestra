import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@relay/adapters";
import { createDecisionService } from "@relay/decisions";
import { normalizeWorkflow, parseWorkflow } from "@relay/schema";
import { openStore, type RunRecord, type Store } from "@relay/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@relay/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { StopSignal } from "../src/stop.js";
import { createEngine } from "../src/engine.js";
import { executeDecision } from "../src/exec-decision.js";
import { executeDeterministic } from "../src/exec-deterministic.js";
import { analyzeWorkflowPlan, type WorkflowPlan } from "../src/graph-plan.js";
import type { EngineDeps } from "../src/types.js";

const FAKE_ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};
const LEAK_NEEDLES = ["test-typesafe-key", "test-cf-token", "test-cf-account"];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

function trackStandin(standin: StandinHandle): StandinHandle {
  cleanups.push(() => standin.close());
  return standin;
}

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});
const start = () => node("start", "start", { params: [] });
const shell = (id: string, command: string) =>
  node(id, "shell", { command, workspace: { mode: "scratch" }, timeoutMin: 2 });
const end = (id: string, result = '"ok"') => node(id, "end", { status: "success", result });
const decision = (id: string, extra: Record<string, unknown> = {}) =>
  node(id, "decision", {
    provider: "typesafe-jev",
    state: "case {{start.topic}}",
    instructions: "Should we proceed?",
    mode: { kind: "boolean" },
    onError: "fail",
    ...extra,
  });

function snapshot(nodes: unknown[], edges: [string, string][]): unknown {
  return {
    schemaVersion: 1,
    id: "dec",
    name: "Dec",
    graph: {
      nodes,
      edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to })),
    },
  };
}

function setup(standin: StandinHandle): {
  store: Store;
  file: string;
  dataDir: string;
  deps: EngineDeps;
} {
  const base = mkdtempSync(join(tmpdir(), "relay-engine-decision-"));
  const dataDir = join(base, "data");
  const project = join(base, "project");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const file = join(dataDir, "relay.db");
  const store = openStore({ file });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const deps: EngineDeps = {
    store,
    adapters: createAdapterRegistry({ ids: ["fake"] }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: { url: "http://127.0.0.1:1", issue: () => ({ token: "t", revoke: () => undefined }) },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: process.env,
    decisions: createDecisionService({
      env: { ...FAKE_ENV },
      dotenvPath: null,
      baseUrlOverride: standin.origin,
    }),
  };
  return { store, file, dataDir, deps };
}

function launchInput(snap: unknown) {
  const parsed = parseWorkflow(snap);
  if (!parsed.ok) throw parsed.error;
  const normalized = normalizeWorkflow(parsed.value);
  if (!normalized.ok) throw normalized.error;
  return {
    projectId: "p1",
    workflowId: "dec",
    snapshot: parsed.value,
    snapshotRaw: JSON.stringify(snap),
    params: {},
  };
}

function events(store: Store, runId: string, type: string) {
  return store.events.list(runId as never, { limit: 10_000 }).filter((e) => e.type === type);
}

function activeState(): ActiveRunState {
  return { abort: new AbortController(), reason: null, tokens: new Set() };
}

function scanForKeys(store: Store, runId: string, extra: unknown[] = []): string[] {
  const haystacks = [
    JSON.stringify(store.events.list(runId as never, { limit: 10_000 })),
    ...extra.map((value) => JSON.stringify(value)),
  ];
  return LEAK_NEEDLES.filter((needle) => haystacks.some((hay) => hay.includes(needle)));
}

describe("engine decision executor", () => {
  it("routes boolean true, skips the other branches, and persists the full answer", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d"),
        shell("sa", "printf A"),
        shell("sb", "printf B"),
        end("ea", '"yes"'),
        end("eb", '"no"'),
      ],
      [
        ["start", "d"],
        ["d.true", "sa"],
        ["sa", "ea"],
        ["d.false", "sb"],
        ["sb", "eb"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("yes");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.sb?.status).toBe("skipped");
    expect(view.executions.d?.decision?.routing).toEqual({ branch: "true", reason: "matched" });
    expect(
      store.outputs.get({
        runId: result.value.runId as never,
        path: "d" as never,
        attempt: 1,
      })?.json,
    ).toMatchObject({
      branch: "true",
      value: true,
      probability: 0.75,
      confidence: 0.75,
      confidenceSource: "derived",
      model: "jev-latest",
    });
    expect(events(store, result.value.runId, "decision.requested")).toHaveLength(1);
    expect(events(store, result.value.runId, "decision.answered")).toHaveLength(1);
    expect(scanForKeys(store, result.value.runId)).toEqual([]);
    await engine.stop();
  });

  it("routes choice to the branch holding the picked option", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d", {
          mode: {
            kind: "choice",
            options: [{ value: "red" }, { value: "blue", description: "cool blue" }],
            branches: [
              { id: "warm", values: ["red"] },
              { id: "cool", values: ["blue"] },
            ],
          },
        }),
        shell("sw", "printf W"),
        shell("sc", "printf C"),
        end("ew", '"warm"'),
        end("ec", '"cool"'),
      ],
      [
        ["start", "d"],
        ["d.warm", "sw"],
        ["sw", "ew"],
        ["d.cool", "sc"],
        ["sc", "ec"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("warm");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.sc?.status).toBe("skipped");
    expect(view.executions.d?.decision?.routing).toEqual({ branch: "warm", reason: "matched" });
    // The state template renders with the same scope machinery as prompts.
    expect(String(standin.lastRequest()?.bodyText ?? "")).toContain("case ");
    await engine.stop();
  });

  it("routes score to the matching band with probabilities by level label", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d", {
          mode: {
            kind: "score",
            levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
            bands: [
              { id: "top", atLeast: 2 },
              { id: "rest", atLeast: null },
            ],
          },
        }),
        end("et", '"top"'),
        end("er", '"rest"'),
      ],
      [
        ["start", "d"],
        ["d.top", "et"],
        ["d.rest", "er"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("rest");
    expect(
      store.outputs.get({
        runId: result.value.runId as never,
        path: "d" as never,
        attempt: 1,
      })?.json,
    ).toMatchObject({
      branch: "rest",
      value: "mid",
      score: 1.2,
      probabilities: { low: expect.any(Number), mid: 0.6, high: expect.any(Number) },
      model: "jev-latest",
    });
    await engine.stop();
  });

  it("takes the wired uncertain route on low confidence", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d", { mode: { kind: "boolean", trueAt: 0.9, falseAt: 0.5 } }),
        end("eu", '"unsure"'),
        end("et", '"sure"'),
      ],
      [
        ["start", "d"],
        ["d.uncertain", "eu"],
        ["d.true", "et"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("unsure");
    expect(store.view.get(result.value.runId as never).executions.d?.decision?.routing).toEqual({
      branch: "uncertain",
      reason: "low_confidence",
    });
    await engine.stop();
  });

  it("fails with an actionable error when uncertain is reached but unwired", async () => {
    // F5: wiring is decided before committing, so the answer persists with a
    // failed (branch null) routing and the node fails instead of succeeding
    // with routing.branch = "uncertain" and no error on it.
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d", { mode: { kind: "boolean", trueAt: 0.9, falseAt: 0.5 } }),
        end("et", '"sure"'),
      ],
      [
        ["start", "d"],
        ["d.true", "et"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_WORKFLOW_INVALID");
    expect(result.value.error?.message).toContain("d.uncertain");
    const answered = events(store, result.value.runId, "decision.answered");
    expect(answered).toHaveLength(1);
    expect((answered[0] as { payload: { routing: unknown } }).payload.routing).toEqual({
      branch: null,
      reason: "low_confidence",
    });
    expect(store.view.get(result.value.runId as never).executions.d?.status).toBe("failed");
    await engine.stop();
  });

  it("reproduces the unwired-uncertain error on redrive without calling the provider again", async () => {
    // F5: a crash between the branch-null commit and the throw leaves the
    // answer persisted with the execution still running; the redrive must hit
    // the same clear E_WORKFLOW_INVALID with no provider call (no re-ask).
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const snap = snapshot(
      [
        start(),
        decision("d", { mode: { kind: "boolean", trueAt: 0.9, falseAt: 0.5 } }),
        end("et", '"sure"'),
      ],
      [
        ["start", "d"],
        ["d.true", "et"],
      ],
    );
    const created = store.runs.create({
      projectId: "p1",
      workflowId: "dec",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: {},
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const ctx = new EngineContext(deps);
    const run = store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, planResult.value, planResult.value.byId.get("start") as never, activeState());
    const nodeD = planResult.value.byId.get("d") as never;
    // The branch-null commit as executeDecision performs it, then a crash
    // before the throw: the answer survives, the execution never failed.
    const ensured = store.executions.ensure({
      runId: created.runId as never,
      path: "d" as never,
      nodeId: "d",
      kind: "decision",
      requireSubmission: false,
    });
    const started = store.executions.beginInvocation({
      runId: created.runId as never,
      path: "d" as never,
      attempt: ensured.attempt,
      resolvedConfigHash: "cfg",
    });
    store.routing.recordDecision({
      identity: started,
      provider: "typesafe-jev",
      model: "jev-latest",
      questionIds: ["q0"],
      output: {
        kind: "boolean",
        value: true,
        probability: 0.75,
        confidence: 0.75,
        confidenceSource: "derived",
        model: "jev-latest",
      },
      routing: { branch: null, reason: "low_confidence" },
    });
    // Boot recovery parks a running execution as interrupted before redrive.
    store.events.append(created.runId as never, [
      {
        runId: created.runId as never,
        path: "d" as never,
        type: "node.state" as never,
        actor: "engine" as never,
        payload: {
          from: "running",
          to: "interrupted",
          attempt: started.attempt,
          generation: started.generation,
        },
      } as never,
    ]);
    await expect(
      executeDecision(ctx, run, planResult.value, nodeD, activeState()),
    ).rejects.toMatchObject({ code: "E_WORKFLOW_INVALID", message: /d\.uncertain/ });
    expect(standin.requests()).toHaveLength(0);
    expect(events(store, created.runId, "decision.answered")).toHaveLength(1);
  });

  it("persists the answer when abort lands after the provider responded, then resumes without re-asking", async () => {
    // F7a: an interrupt after the answer arrived must not discard it.
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const service = deps.decisions;
    if (service === undefined) throw new Error("decisions service missing");
    const interrupted = activeState();
    const wrapped: typeof service = {
      client: (provider) => {
        const inner = service.client(provider);
        return {
          ...inner,
          ask: async (request, signal) => {
            const result = await inner.ask(request, signal);
            if (result.ok) {
              // The provider answered; the interrupt lands before the
              // executor persists.
              interrupted.abort.abort();
            }
            return result;
          },
        };
      },
    };
    const snap = snapshot(
      [start(), decision("d"), end("done", '"ok"')],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const created = store.runs.create({
      projectId: "p1",
      workflowId: "dec",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: {},
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const ctx = new EngineContext({ ...deps, decisions: wrapped });
    const run = store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, planResult.value, planResult.value.byId.get("start") as never, activeState());
    const nodeD = planResult.value.byId.get("d") as never;
    let stopped: unknown;
    try {
      await executeDecision(ctx, run, planResult.value, nodeD, interrupted);
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(StopSignal);
    expect(standin.requests()).toHaveLength(1);
    expect(events(store, created.runId, "decision.answered")).toHaveLength(1);
    expect(store.view.get(created.runId as never).executions.d?.status).toBe("succeeded");
    // Resume reuses the stored answer: no second provider call.
    const ctx2 = new EngineContext(deps);
    await executeDecision(ctx2, run, planResult.value, nodeD, activeState());
    expect(standin.requests()).toHaveLength(1);
    expect(events(store, created.runId, "decision.answered")).toHaveLength(1);
  });

  it("always fails the node on missing secrets even with onError uncertain", async () => {
    // F7c: configuration errors never route uncertain; only provider or
    // transport failures after retries do.
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const engine = createEngine({
      ...deps,
      decisions: createDecisionService({
        env: {},
        dotenvPath: null,
        baseUrlOverride: standin.origin,
      }),
    });
    const snap = snapshot(
      [start(), decision("d", { onError: "uncertain" }), end("eu", '"unsure"')],
      [
        ["start", "d"],
        ["d.uncertain", "eu"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_PROVIDER");
    expect(result.value.error?.message).toContain("TYPESAFE_API_KEY");
    expect(store.view.get(result.value.runId as never).executions.d?.decision).toBeNull();
    expect(standin.requests()).toHaveLength(0);
    await engine.stop();
  });

  it("fails the node with the provider error when onError is fail", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["error-400"]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [start(), decision("d"), end("done")],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_PROVIDER");
    expect(scanForKeys(store, result.value.runId, [result.value.error])).toEqual([]);
    await engine.stop();
  });

  it("records uncertain/error with a refusal-style output when onError is uncertain", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["error-500", "error-500", "error-500"]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [start(), decision("d", { onError: "uncertain" }), end("eu", '"unsure"')],
      [
        ["start", "d"],
        ["d.uncertain", "eu"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("unsure");
    const view = store.view.get(result.value.runId as never);
    expect(view.executions.d?.decision?.routing).toEqual({ branch: "uncertain", reason: "error" });
    expect(
      store.outputs.get({ runId: result.value.runId as never, path: "d" as never, attempt: 1 })
        ?.json,
    ).toMatchObject({
      branch: "uncertain",
      value: null,
      confidence: null,
      confidenceSource: null,
      model: "jev-latest",
    });
    expect(scanForKeys(store, result.value.runId)).toEqual([]);
    await engine.stop();
  });

  it("routes a provider refusal to uncertain/refused", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["refusal-missing"]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [start(), decision("d"), end("eu", '"unsure"'), end("et", '"sure"')],
      [
        ["start", "d"],
        ["d.uncertain", "eu"],
        ["d.true", "et"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("unsure");
    expect(store.view.get(result.value.runId as never).executions.d?.decision?.routing).toEqual({
      branch: "uncertain",
      reason: "refused",
    });
    await engine.stop();
  });

  it("fails closed without a decision service", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { deps } = setup(standin);
    const { decisions: _omitted, ...withoutDecisions } = deps;
    void _omitted;
    const engine = createEngine(withoutDecisions);
    const snap = snapshot(
      [start(), decision("d"), end("done")],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.code).toBe("E_PROVIDER");
    expect(result.value.error?.message).toContain("decision service");
    expect(standin.requests()).toHaveLength(0);
    await engine.stop();
  });

  it("exposes value and confidence to downstream expressions, null comparing false", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d"),
        node("g", "gate", {
          branches: [
            { id: "sure", when: "d.confidence >= 0.8" },
            { id: "unsure", otherwise: true },
          ],
        }),
        end("es", '"sure"'),
        end("eu", '{ "picked": d.value, "conf": d.confidence }'),
      ],
      [
        ["start", "d"],
        ["d.true", "g"],
        ["g.sure", "es"],
        ["g.unsure", "eu"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    // Stand-in boolean confidence is 0.75: >= 0.8 is false, otherwise wins.
    expect(result.value.result).toEqual({ picked: true, conf: 0.75 });
    await engine.stop();
  });

  it("treats a null confidence as false in downstream expressions", async () => {
    // F3: the worker retry is gone; the engine exposes a refused decision's
    // null confidence as 0 in expression scope, so >= 0.8 reads false here
    // while the persisted output keeps null.
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["refusal-missing"]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d"),
        node("g", "gate", {
          branches: [
            { id: "sure", when: "d.confidence >= 0.8" },
            { id: "unsure", otherwise: true },
          ],
        }),
        end("es", '"sure"'),
        end("eu", '"unsure"'),
      ],
      [
        ["start", "d"],
        ["d.uncertain", "g"],
        ["g.sure", "es"],
        ["g.unsure", "eu"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toBe("unsure");
    expect(
      store.outputs.get({ runId: result.value.runId as never, path: "d" as never, attempt: 1 })
        ?.json,
    ).toMatchObject({ confidence: null, confidenceSource: null });
    await engine.stop();
  });

  it("reads a refused decision in a gate with unknown confidence as 0, never high", async () => {
    // F3: unknown confidence is never mistaken for high confidence, but
    // low-side comparisons see it: < 0.5 is true while confidenceSource
    // stays null so authors can still detect "unknown".
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["refusal-missing"]);
    const { deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [
        start(),
        decision("d"),
        node("g", "gate", {
          branches: [
            { id: "low", when: "d.confidence < 0.5" },
            { id: "high", otherwise: true },
          ],
        }),
        end("el", '{ "conf": d.confidence, "src": d.confidenceSource }'),
        end("eh", '"high"'),
      ],
      [
        ["start", "d"],
        ["d.uncertain", "g"],
        ["g.low", "el"],
        ["g.high", "eh"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("succeeded");
    expect(result.value.result).toEqual({ conf: 0, src: null });
    await engine.stop();
  });

  it("redacts key material from provider errors", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext(["echo-key"]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [start(), decision("d"), end("done")],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const result = await engine.run(launchInput(snap));
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(JSON.stringify(result.value.error)).toContain("[redacted]");
    expect(scanForKeys(store, result.value.runId, [result.value.error])).toEqual([]);
    await engine.stop();
  });

  it("interrupts (not fails) on abort during the provider call, then asks again on resume", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    standin.setNext([{ scenario: "slow", delayMs: 1500 }]);
    const { store, deps } = setup(standin);
    const engine = createEngine(deps);
    const snap = snapshot(
      [start(), decision("d"), end("done", '"ok"')],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const launched = await engine.launch(launchInput(snap));
    if (!launched.ok) throw launched.error;
    // Wait until the provider call is actually in flight, so the abort lands
    // mid-call rather than before the request is issued.
    for (let i = 0; i < 400; i += 1) {
      if (standin.requests().length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(standin.requests().length).toBe(1);
    await engine.stop();
    const stopped = store.view.get(launched.value.runId as never);
    expect(stopped.status).toBe("paused");
    expect(stopped.executions.d?.status).toBe("interrupted");
    expect(events(store, launched.value.runId, "decision.answered")).toHaveLength(0);
    await standin.drain();

    const resumed = createEngine({ ...deps });
    const outcome = await resumed.resume(launched.value.runId);
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.status).toBe("succeeded");
    // Requested-only state asks again: the slow call plus the retry.
    expect(standin.requests().length).toBe(2);
    await resumed.stop();
  });

  it("reuses a persisted answer after a restart without calling the provider again", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const first = setup(standin);
    const snap = snapshot(
      [start(), decision("d"), end("done", '"ok"')],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const created = first.store.runs.create({
      projectId: "p1",
      workflowId: "dec",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: {},
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const plan: WorkflowPlan = planResult.value;
    const ctx = new EngineContext(first.deps);
    const run = first.store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(ctx, run, plan, plan.byId.get("start") as never, activeState());
    await executeDecision(ctx, run, plan, plan.byId.get("d") as never, activeState());
    expect(standin.requests().length).toBe(1);
    first.store.close();

    // Reopen with a broken provider: resume must reuse the stored answer.
    const store = openStore({ file: first.file });
    cleanups.push(() => store.close());
    standin.setNext(["error-500", "error-500", "error-500"]);
    const engine = createEngine({
      ...first.deps,
      store,
      decisions: createDecisionService({
        env: { ...FAKE_ENV },
        dotenvPath: null,
        baseUrlOverride: standin.origin,
      }),
    });
    const resumed = await engine.resume(created.runId);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    expect(standin.requests().length).toBe(1);
    expect(events(store, created.runId, "decision.answered")).toHaveLength(1);
    await engine.stop();
  });

  it("asks again when only decision.requested is persisted", async () => {
    const standin = await startStandin();
    trackStandin(standin);
    const { store, deps } = setup(standin);
    const snap = snapshot(
      [start(), decision("d"), end("done", '"ok"')],
      [
        ["start", "d"],
        ["d.true", "done"],
      ],
    );
    const created = store.runs.create({
      projectId: "p1",
      workflowId: "dec",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      params: {},
    });
    const planResult = analyzeWorkflowPlan(snap);
    if (!planResult.ok) throw planResult.error;
    const ctx = new EngineContext(deps);
    const run = store.runs.get(created.runId) as RunRecord;
    await executeDeterministic(
      ctx,
      run,
      planResult.value,
      planResult.value.byId.get("start") as never,
      activeState(),
    );
    // Crash between request and answer: only the audit event survives.
    const ensured = store.executions.ensure({
      runId: created.runId as never,
      path: "d" as never,
      nodeId: "d",
      kind: "decision",
      requireSubmission: false,
    });
    const started = store.executions.beginInvocation({
      runId: created.runId as never,
      path: "d" as never,
      attempt: ensured.attempt,
      resolvedConfigHash: "cfg",
    });
    store.events.append(created.runId as never, [
      {
        runId: created.runId as never,
        path: "d" as never,
        type: "decision.requested" as never,
        actor: "engine" as never,
        payload: {
          provider: "typesafe-jev",
          model: "jev-latest",
          questionIds: ["q0"],
          attempt: started.attempt,
          generation: started.generation,
        },
      } as never,
    ]);
    // Boot recovery parks a running execution as interrupted before redrive.
    store.events.append(created.runId as never, [
      {
        runId: created.runId as never,
        path: "d" as never,
        type: "node.state" as never,
        actor: "engine" as never,
        payload: {
          from: "running",
          to: "interrupted",
          attempt: started.attempt,
          generation: started.generation,
        },
      } as never,
    ]);
    await executeDecision(
      ctx,
      run,
      planResult.value,
      planResult.value.byId.get("d") as never,
      activeState(),
    );
    expect(standin.requests().length).toBe(1);
    expect(events(store, created.runId, "decision.answered")).toHaveLength(1);
  });
});
