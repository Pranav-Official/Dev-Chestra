import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "../src/workflow.js";

let root: string;
let project: string;

function dag(
  branches = [
    { id: "yes", when: "true" },
    { id: "no", otherwise: true },
  ],
) {
  const shell = (id: string) => ({
    id,
    type: "shell",
    name: id,
    command: "true",
    workspace: { mode: "scratch" },
    timeoutMin: 1,
  });
  return {
    schemaVersion: 1,
    id: "dag",
    name: "DAG",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "gate", type: "gate", name: "Gate", branches },
        shell("left"),
        shell("right"),
        { id: "join", type: "join", name: "Join", mode: "all", inputs: ["left", "right"] },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "gate" },
        { id: "e2", from: "gate.yes", to: "left" },
        { id: "e3", from: "gate.no", to: "right" },
        { id: "e4", from: "left", to: "join.left" },
        { id: "e5", from: "right", to: "join.right" },
        { id: "e6", from: "join", to: "end" },
      ],
    },
  };
}

async function write(workflow: unknown): Promise<void> {
  const dir = join(project, ".relay", "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "dag.json"), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-cli-dag-"));
  project = join(root, "project");
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CLI DAG loading", () => {
  it("accepts and normalizes a gate/join workflow through the shared schema", async () => {
    await write(dag());
    const loaded = await loadWorkflow(project, ".relay/workflows/dag.json");
    expect(loaded.normalized.graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["start", "shell", "gate", "join", "end"]),
    );
    const gate = loaded.normalized.graph.nodes.find((node) => node.type === "gate");
    expect(gate).toMatchObject({
      branches: [
        { id: "yes", when: "true" },
        { id: "no", otherwise: true },
      ],
    });
  });

  it("rejects an invalid gate before the engine sees it", async () => {
    await write(
      dag([
        { id: "yes", when: "true" },
        { id: "also", when: "false" },
      ]),
    );
    await expect(loadWorkflow(project, ".relay/workflows/dag.json")).rejects.toMatchObject({
      code: "E_WORKFLOW_INVALID",
    });
  });
});
