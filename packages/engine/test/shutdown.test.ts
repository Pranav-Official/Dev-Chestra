import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { openStore, type Store } from "@devchestra/store";
import { acquireScratch, finalizeScratch, releaseScratch } from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, StartRunInput } from "../src/types.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Harness {
  engine: Engine;
  store: Store;
}

function hangingPrepareHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-shutdown-"));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const engine = createEngine({
    store,
    adapters: createAdapterRegistry({ ids: [] }),
    workspaces: {
      // Never settles and ignores the abort signal: simulates a drive that
      // never observes shutdown, so `stop` must enforce its deadline.
      prepare: () => new Promise<never>(() => undefined),
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "unused", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused-shim.js"),
    env: process.env,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { engine, store };
}

function snapshot(): unknown {
  return {
    schemaVersion: 1,
    id: "shutdown-test",
    name: "Shutdown test",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [{ id: "e1", from: "start", to: "end" }],
    },
  };
}

function input(snap: unknown): StartRunInput {
  return {
    projectId: "p1",
    workflowId: "shutdown-test",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
  };
}

describe("engine shutdown deadline", () => {
  it("stop returns after graceMs when a drive never observes the abort", async () => {
    const { engine } = hangingPrepareHarness();
    await engine.start();
    const launched = await engine.launch(input(snapshot()));
    if (!launched.ok) throw launched.error;

    const began = Date.now();
    await engine.stop({ graceMs: 50 });
    expect(Date.now() - began).toBeLessThan(10_000);

    // The drive is still stuck in prepare: completion must not have settled.
    let settled = false;
    void launched.value.completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });

  it("stop with no active runs returns immediately", async () => {
    const { engine } = hangingPrepareHarness();
    await engine.start();
    const began = Date.now();
    await engine.stop({ graceMs: 50 });
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});
