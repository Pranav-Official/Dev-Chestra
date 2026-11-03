import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeIdGen, type Path, type RunId } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(): Store {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-usage-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("t"),
  });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function createRun(store: Store, projectId: string) {
  return store.runs.create({
    projectId,
    workflowId: "wf",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
    params: {},
    budgets: {},
  });
}

function track(
  store: Store,
  runId: RunId,
  path: string,
  opts: { cli?: string; model?: string; tokensIn: number; tokensOut: number; costUsd: number },
): void {
  store.executions.ensure({
    runId,
    path: path as Path,
    nodeId: path,
    kind: "agent",
  });
  const identity = store.executions.beginInvocation({
    runId,
    path: path as Path,
    attempt: 1,
    pid: 4242,
    lstart: "start",
    resolvedConfigHash: "cfg",
  });
  if (opts.cli !== undefined) {
    store.events.append(runId, [
      {
        runId,
        path: path as Path,
        type: "node.session.captured",
        actor: "system",
        payload: {
          attempt: identity.attempt,
          generation: identity.generation,
          cli: opts.cli,
          sessionId: "sess",
          cwd: "/tmp",
          ...(opts.model === undefined ? {} : { model: opts.model }),
        },
      } as never,
    ]);
  }
  store.events.append(runId, [
    {
      runId,
      path: path as Path,
      type: "node.usage",
      actor: "system",
      payload: {
        attempt: identity.attempt,
        generation: identity.generation,
        tokensIn: opts.tokensIn,
        tokensOut: opts.tokensOut,
        costUsd: opts.costUsd,
        costSource: "reported",
      },
    } as never,
  ]);
}

describe("usage summary", () => {
  it("returns zeros for an empty database", () => {
    const store = setup();
    expect(store.usage.summary()).toEqual({
      total: { usd: 0, tokens: 0 },
      byProvider: [],
      byProject: [],
    });
    expect(store.usage.summary({ projectId: "missing" })).toEqual({
      total: { usd: 0, tokens: 0 },
      byProvider: [],
      byProject: [],
    });
  });

  it("groups by provider then model with totals from the runs table", () => {
    const store = setup();
    store.projects.ensure({ id: "proj", name: "Project", path: "/tmp", kind: "folder" });
    const run = createRun(store, "proj");
    track(store, run.runId, "a", {
      cli: "claude",
      model: "sonnet",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 1.5,
    });
    track(store, run.runId, "b", {
      cli: "claude",
      model: "opus",
      tokensIn: 200,
      tokensOut: 0,
      costUsd: 0.5,
    });

    const summary = store.usage.summary();
    expect(summary.total).toEqual({ usd: 2, tokens: 350 });
    expect(summary.byProvider).toEqual([
      {
        provider: "claude",
        usd: 2,
        tokens: 350,
        byModel: [
          { model: "sonnet", usd: 1.5, tokens: 150 },
          { model: "opus", usd: 0.5, tokens: 200 },
        ],
      },
    ]);
  });

  it("buckets executions without cli/model as unknown", () => {
    const store = setup();
    store.projects.ensure({ id: "proj", name: "Project", path: "/tmp", kind: "folder" });
    const run = createRun(store, "proj");
    track(store, run.runId, "decision", { tokensIn: 10, tokensOut: 10, costUsd: 0 });

    const summary = store.usage.summary();
    expect(summary.total).toEqual({ usd: 0, tokens: 20 });
    expect(summary.byProvider).toEqual([
      {
        provider: "unknown",
        usd: 0,
        tokens: 20,
        byModel: [{ model: "unknown", usd: 0, tokens: 20 }],
      },
    ]);
  });

  it("scopes totals and breakdown by projectId", () => {
    const store = setup();
    store.projects.ensure({ id: "proj-1", name: "One", path: "/tmp/1", kind: "folder" });
    store.projects.ensure({ id: "proj-2", name: "Two", path: "/tmp/2", kind: "folder" });
    const run1 = createRun(store, "proj-1");
    const run2 = createRun(store, "proj-2");
    track(store, run1.runId, "a", {
      cli: "claude",
      model: "sonnet",
      tokensIn: 100,
      tokensOut: 0,
      costUsd: 1,
    });
    track(store, run2.runId, "a", {
      cli: "codex",
      model: "gpt",
      tokensIn: 50,
      tokensOut: 0,
      costUsd: 0.25,
    });

    const scoped = store.usage.summary({ projectId: "proj-1" });
    expect(scoped.total).toEqual({ usd: 1, tokens: 100 });
    expect(scoped.byProvider.map((p) => p.provider)).toEqual(["claude"]);

    const global = store.usage.summary();
    expect(global.total).toEqual({ usd: 1.25, tokens: 150 });
    expect(global.byProvider.map((p) => p.provider).sort()).toEqual(["claude", "codex"]);
  });

  it("splits spend by project, with each project's own providers, removed ones included", () => {
    const store = setup();
    store.projects.ensure({ id: "proj-1", name: "One", path: "/tmp/1", kind: "folder" });
    store.projects.ensure({ id: "proj-2", name: "Two", path: "/tmp/2", kind: "folder" });
    store.projects.ensure({ id: "proj-3", name: "Three", path: "/tmp/3", kind: "folder" });
    const run1 = createRun(store, "proj-1");
    const run2 = createRun(store, "proj-2");
    const run3 = createRun(store, "proj-3");
    track(store, run1.runId, "a", {
      cli: "claude",
      model: "sonnet",
      tokensIn: 100,
      tokensOut: 0,
      costUsd: 1,
    });
    track(store, run1.runId, "b", {
      cli: "codex",
      model: "gpt",
      tokensIn: 400,
      tokensOut: 0,
      costUsd: 0.25,
    });
    track(store, run2.runId, "a", {
      cli: "claude",
      model: "opus",
      tokensIn: 50,
      tokensOut: 0,
      costUsd: 3,
    });
    track(store, run3.runId, "a", {
      cli: "pi",
      model: "m",
      tokensIn: 10,
      tokensOut: 0,
      costUsd: 0.1,
    });
    // A project can only be removed once its runs are finished.
    store.events.append(run3.runId, [
      { runId: run3.runId, path: "" as Path, type: "run.cancelled", actor: "user", payload: {} },
    ]);
    store.projects.remove("proj-3");

    const summary = store.usage.summary();
    expect(summary.byProject.map((p) => [p.projectId, p.name, p.removed, p.usd, p.tokens])).toEqual(
      [
        ["proj-2", "Two", false, 3, 50],
        ["proj-1", "One", false, 1.25, 500],
        ["proj-3", "Three", true, 0.1, 10],
      ],
    );
    expect(summary.byProject[1]?.byProvider.map((p) => [p.provider, p.usd, p.tokens])).toEqual([
      ["claude", 1, 100],
      ["codex", 0.25, 400],
    ]);
    expect(summary.byProject.reduce((sum, p) => sum + p.tokens, 0)).toBe(summary.total.tokens);
    expect(summary.byProject.reduce((sum, p) => sum + p.usd, 0)).toBeCloseTo(summary.total.usd);

    const scoped = store.usage.summary({ projectId: "proj-1" });
    expect(scoped.byProject.map((p) => p.projectId)).toEqual(["proj-1"]);
  });
});
