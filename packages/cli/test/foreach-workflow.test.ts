import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@devchestra/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCliWorkflowResolver,
  loadChildWorkflowResolved,
  loadWorkflow,
} from "../src/workflow.js";

let root: string;
let dataDir: string;

function workflowFile(id: string, workflowId: string | null): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        ...(workflowId
          ? [{ id: "call", type: "workflow", name: "Call", workflowId, inputs: {} }]
          : []),
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: workflowId ? "call" : "start",
        },
      ],
      edges:
        workflowId === null
          ? [{ id: "e1", from: "start", to: "end" }]
          : [
              { id: "e1", from: "start", to: "call" },
              { id: "e2", from: "call", to: "end" },
            ],
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-foreach-"));
  dataDir = await mkdtemp(join(tmpdir(), "cli-foreach-db-"));
  await mkdir(join(root, ".devchestra", "workflows"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("CLI child-workflow resolver (engine owns freeze)", () => {
  it("reads one child by id with no transitive walk", async () => {
    await writeFile(
      join(root, ".devchestra", "workflows", "leaf.json"),
      workflowFile("leaf", null),
    );
    await writeFile(
      join(root, ".devchestra", "workflows", "main.json"),
      workflowFile("main", "leaf"),
    );
    const loaded = await loadWorkflow(root, ".devchestra/workflows/main.json");
    expect(loaded.workflowId).toBe("main");
    const resolved = await loadChildWorkflowResolved(root, "leaf");
    expect(resolved.id).toBe("leaf");
    expect(resolved.normalized.id).toBe("leaf");
    expect(typeof resolved.hash).toBe("string");
  });

  it("missing child fails explicitly via the project-bound resolver", async () => {
    await writeFile(
      join(root, ".devchestra", "workflows", "main.json"),
      workflowFile("main", "ghost"),
    );
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    try {
      const projectId = "p1-test-missing-child";
      store.projects.ensure({ id: projectId, name: "proj", path: root, kind: "folder" });
      const resolver = createCliWorkflowResolver(store);
      const result = await resolver.resolve(projectId, "ghost");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("E_NOT_FOUND");
    } finally {
      store.close();
    }
  });
});
