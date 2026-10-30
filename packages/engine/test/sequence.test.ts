import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeLinearWorkflow } from "../src/sequence.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../tools/fixtures/engine/${name}`, import.meta.url), "utf8"),
  );

interface TestNode extends Record<string, unknown> {
  id: string;
  type?: string;
  workspace?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  output?: Record<string, unknown>;
  promptFile?: string;
}

interface TestEdge extends Record<string, unknown> {
  from: string;
  to: string;
}

type MutableSnapshot = { graph: { nodes: TestNode[]; edges: TestEdge[] } };

function nodeAt(snapshot: MutableSnapshot, index: number): TestNode {
  const node = snapshot.graph.nodes[index];
  if (node === undefined) throw new Error(`Missing node ${index}`);
  return node;
}

function edgeAt(snapshot: MutableSnapshot, index: number): TestEdge {
  const edge = snapshot.graph.edges[index];
  if (edge === undefined) throw new Error(`Missing edge ${index}`);
  return edge;
}

function record(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = owner[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing object ${key}`);
  }
  return value as Record<string, unknown>;
}

function mutate(change: (snapshot: MutableSnapshot) => void): unknown {
  const snapshot = fixture("linear-research.json") as MutableSnapshot;
  change(snapshot);
  return snapshot;
}

describe("analyzeLinearWorkflow", () => {
  it("accepts the linear fixture in start/agent/shell/end order", () => {
    const result = analyzeLinearWorkflow(fixture("linear-research.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.map((node) => node.id)).toEqual([
      "start",
      "research",
      "report",
      "end",
    ]);
    expect(result.value.start.id).toBe("start");
    expect(result.value.end.id).toBe("end");
  });

  it("rejects unsupported node types even when the shape is a chain", () => {
    const result = analyzeLinearWorkflow(
      mutate((snapshot) => {
        nodeAt(snapshot, 1).type = "gate";
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_WORKFLOW_INVALID");
    expect(result.error.message).toContain("not supported");
  });

  it("accepts worktree workspaces and rejects their unsupported options", () => {
    const accepted = analyzeLinearWorkflow(
      mutate((snapshot) => {
        nodeAt(snapshot, 1).workspace = { mode: "worktree" };
        nodeAt(snapshot, 2).workspace = { mode: "worktree" };
      }),
    );
    expect(accepted.ok).toBe(true);

    for (const key of ["base", "setup", "from"] as const) {
      const result = analyzeLinearWorkflow(
        mutate((snapshot) => {
          nodeAt(snapshot, 1).workspace = { mode: "worktree", [key]: "x" };
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain(key);
    }
  });

  it("accepts legacy project workspace metadata that fresh runs ignore", () => {
    for (const workspace of [
      { mode: "project", access: "read" },
      { mode: "project", access: "write" },
    ]) {
      const result = analyzeLinearWorkflow(
        mutate((snapshot) => {
          nodeAt(snapshot, 1).workspace = workspace;
        }),
      );
      expect(result.ok).toBe(true);
    }
  });

  it("accepts context pool reads and rejects context writes to static pools", () => {
    const read = analyzeLinearWorkflow(
      mutate((snapshot) => {
        record(nodeAt(snapshot, 1), "context").project = "read";
      }),
    );
    expect(read.ok).toBe(true);

    const executionWrite = analyzeLinearWorkflow(
      mutate((snapshot) => {
        record(nodeAt(snapshot, 1), "context").execution = "readwrite";
      }),
    );
    expect(executionWrite.ok).toBe(true);

    const projectWrite = analyzeLinearWorkflow(
      mutate((snapshot) => {
        record(nodeAt(snapshot, 1), "context").project = "readwrite";
      }),
    );
    expect(projectWrite.ok).toBe(false);

    const write = analyzeLinearWorkflow(
      mutate((snapshot) => {
        record(nodeAt(snapshot, 1), "permissions").write = ["project"];
      }),
    );
    expect(write.ok).toBe(false);
  });

  it("rejects artifact outputs and prompt files", () => {
    const artifact = analyzeLinearWorkflow(
      mutate((snapshot) => {
        nodeAt(snapshot, 1).output = {
          type: "object",
          properties: { file: { type: "string", format: "devchestra-artifact" } },
        };
      }),
    );
    expect(artifact.ok).toBe(false);

    const promptFile = analyzeLinearWorkflow(
      mutate((snapshot) => {
        nodeAt(snapshot, 1).promptFile = "research.md";
      }),
    );
    expect(promptFile.ok).toBe(false);
  });

  it("rejects forks, cycles, unreachable nodes and bad endpoints", () => {
    const fork = analyzeLinearWorkflow(
      mutate((snapshot) => {
        snapshot.graph.edges.push({ id: "e4", from: "research", to: "end" });
      }),
    );
    expect(fork.ok).toBe(false);

    const cycle = analyzeLinearWorkflow(
      mutate((snapshot) => {
        snapshot.graph.edges = [
          { id: "e1", from: "start", to: "research" },
          { id: "e2", from: "research", to: "report" },
          { id: "e3", from: "report", to: "research" },
        ];
        snapshot.graph.nodes = snapshot.graph.nodes.filter((node) => node.id !== "end");
      }),
    );
    expect(cycle.ok).toBe(false);

    const unreachable = analyzeLinearWorkflow(
      mutate((snapshot) => {
        snapshot.graph.nodes.push({
          id: "orphan",
          type: "shell",
          command: "true",
          workspace: { mode: "scratch" },
          timeoutMin: 1,
        });
      }),
    );
    expect(unreachable.ok).toBe(false);

    const badEdge = analyzeLinearWorkflow(
      mutate((snapshot) => {
        edgeAt(snapshot, 0).to = "missing";
      }),
    );
    expect(badEdge.ok).toBe(false);

    const branchEdge = analyzeLinearWorkflow(
      mutate((snapshot) => {
        edgeAt(snapshot, 0).from = "start.otherwise";
      }),
    );
    expect(branchEdge.ok).toBe(false);
  });

  it("rejects multiple starts or ends and missing terminals", () => {
    const twoStarts = analyzeLinearWorkflow(
      mutate((snapshot) => {
        snapshot.graph.nodes.push({ id: "start2", type: "start", params: [] });
      }),
    );
    expect(twoStarts.ok).toBe(false);

    const noEnd = analyzeLinearWorkflow(
      mutate((snapshot) => {
        snapshot.graph.nodes = snapshot.graph.nodes.filter((node) => node.id !== "end");
        snapshot.graph.edges = snapshot.graph.edges.filter((edge) => edge.to !== "end");
      }),
    );
    expect(noEnd.ok).toBe(false);
  });
});

describe("validateRunOptions", () => {
  it("rejects unenforced budgets, baseSha, node_test and unsupported kinds", async () => {
    const { validateRunOptions } = await import("../src/sequence.js");
    expect(validateRunOptions({ snapshot: {}, budgets: { maxActiveMinutes: 5 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, budgets: { maxUsd: 1 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, budgets: { maxTokens: 100 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, baseSha: "abc" }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, kind: "node_test" }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, kind: "run" }).ok).toBe(true);
  });
});
