import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeWorkflow } from "@relay/schema";
import { openStore } from "@relay/store";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreQueryPort } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("run layout", () => {
  it("derives coordinates from the immutable run snapshot, not the live file", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-layout-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const store = openStore({ file: join(root, "relay.db") });
    cleanups.push(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    store.projects.ensure({ id: "p", name: "P", path: projectDir, kind: "folder" });
    const normalized = normalizeWorkflow({
      schemaVersion: 1,
      id: "wf",
      name: "W",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Start", params: [] },
          { id: "done", type: "end", name: "Done", status: "success", result: "{}" },
        ],
        edges: [{ id: "e1", from: "start", to: "done" }],
      },
    });
    if (!normalized.ok) throw normalized.error;
    const raw = JSON.stringify({
      schemaVersion: 1,
      id: "wf",
      name: "W",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Start", params: [], ui: { x: 10, y: 20 } },
          {
            id: "done",
            type: "end",
            name: "Done",
            status: "success",
            result: "{}",
            ui: { x: 30, y: 40 },
          },
          { id: "outside", type: "start", name: "X", params: [], ui: { x: 999, y: 999 } },
        ],
        edges: [{ id: "e1", from: "start", to: "done" }],
      },
    });
    const created = store.runs.create({
      projectId: "p",
      workflowId: "wf",
      workflowHash: "hash",
      snapshot: normalized.value,
      snapshotRaw: raw,
    });
    const port = createStoreQueryPort(store);
    const first = await port.runDetail(created.runId);
    expect(first?.layout).toEqual({ start: { x: 10, y: 20 }, done: { x: 30, y: 40 } });

    await mkdir(join(projectDir, ".relay", "workflows"), { recursive: true });
    await writeFile(
      join(projectDir, ".relay", "workflows", "wf.json"),
      JSON.stringify({ graph: { nodes: [{ id: "start", ui: { x: 1, y: 2 } }] } }),
    );
    const second = await port.runDetail(created.runId);
    expect(second?.layout).toEqual({ start: { x: 10, y: 20 }, done: { x: 30, y: 40 } });
  });
});
