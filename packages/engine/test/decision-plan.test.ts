import { describe, expect, it } from "vitest";
import { analyzeWorkflowPlan } from "../src/graph-plan.js";

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  ...extra,
});

const decision = (id: string) =>
  node(id, "decision", {
    provider: "typesafe-jev",
    state: "x",
    instructions: "pick one",
    mode: { kind: "boolean" },
    onError: "fail",
  });

function graph(nodes: unknown[], edges: [string, string][]): unknown {
  return {
    graph: {
      nodes,
      edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to })),
    },
  };
}

describe("decision plan", () => {
  it("accepts a decision node with named handles", () => {
    const plan = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          decision("d"),
          node("sa", "shell", { command: "true", timeoutMin: 1 }),
          node("done", "end", { status: "success", result: "{}" }),
        ],
        [
          ["start", "d"],
          ["d.true", "sa"],
          ["sa", "done"],
        ],
      ),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.byId.get("d")?.type).toBe("decision");
  });

  it("rejects a decision source edge without a handle", () => {
    const plan = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          decision("d"),
          node("done", "end", { status: "success", result: "{}" }),
        ],
        [
          ["start", "d"],
          ["d", "done"],
        ],
      ),
    );
    expect(plan.ok).toBe(false);
  });

  it("rejects a handle on a non-routing source", () => {
    const plan = analyzeWorkflowPlan(
      graph(
        [
          node("start", "start", { params: [] }),
          node("sa", "shell", { command: "true", timeoutMin: 1 }),
          node("done", "end", { status: "success", result: "{}" }),
        ],
        [
          ["start", "sa"],
          ["sa.bogus", "done"],
        ],
      ),
    );
    expect(plan.ok).toBe(false);
  });

  it("dispatch for decision fails closed without a decision service", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openStore } = await import("@devchestra/store");
    const { normalizeWorkflow, parseWorkflow } = await import("@devchestra/schema");
    const { acquireScratch, finalizeScratch, prepareRunWorkspace, releaseScratch } = await import(
      "@devchestra/workspaces"
    );
    const { createEngine } = await import("../src/index.js");
    const temp = mkdtempSync(join(tmpdir(), "devchestra-decplan-"));
    const store = openStore({ file: join(temp, "db.sqlite") });
    store.projects.ensure({ id: "p1", name: "P1", path: temp, kind: "folder" });
    const engine = createEngine({
      store,
      dataDir: temp,
      workspaces: {
        prepare: prepareRunWorkspace,
        acquire: acquireScratch,
        finalize: finalizeScratch,
        release: releaseScratch,
      },
    } as never);
    try {
      await engine.start();
      const raw = {
        schemaVersion: 1 as const,
        id: "dec",
        name: "Dec",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            {
              id: "d",
              type: "decision",
              name: "D",
              provider: "typesafe-jev",
              state: "x",
              instructions: "pick one",
              mode: { kind: "boolean" },
              onError: "fail",
            },
            { id: "done", type: "end", name: "Done", status: "success", result: "'ok'" },
          ],
          edges: [
            { id: "e1", from: "start", to: "d" },
            { id: "e2", from: "d.true", to: "done" },
          ],
        },
      };
      const parsed = parseWorkflow(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const normalized = normalizeWorkflow(parsed.value);
      expect(normalized.ok).toBe(true);
      const launched = await engine.launch({
        projectId: "p1",
        workflowId: "dec",
        snapshot: parsed.value,
        snapshotRaw: JSON.stringify(raw),
        params: {},
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok) return;
      const outcome = await launched.value.completion;
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.code).toBe("E_PROVIDER");
      const errors = store.view.get(launched.value.runId as never).errors;
      expect(errors.some((e) => e.message.includes("decision service"))).toBe(true);
      await engine.stop();
    } finally {
      store.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
