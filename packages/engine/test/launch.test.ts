import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
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
  dataDir: string;
}

function harness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-launch-"));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const engine = createEngine({
    store,
    adapters: createAdapterRegistry({ ids: [] }),
    workspaces: {
      prepare: prepareRunWorkspace,
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
  return { engine, store, dataDir };
}

function snapshot(sleepSeconds: number): unknown {
  return {
    schemaVersion: 1,
    id: "launch-test",
    name: "Launch test",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "wait",
          type: "shell",
          name: "Wait",
          command: `sleep ${sleepSeconds}`,
          workspace: { mode: "scratch" },
          timeoutMin: 1,
          allowFailure: false,
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "wait" },
        { id: "e2", from: "wait", to: "end" },
      ],
    },
  };
}

function input(snap: unknown, idempotency?: StartRunInput["idempotency"]): StartRunInput {
  return {
    projectId: "p1",
    workflowId: "launch-test",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
    ...(idempotency === undefined ? {} : { idempotency }),
  };
}

describe("engine launch", () => {
  it("returns a durable run id before the workflow completes", async () => {
    const { engine } = harness();
    await engine.start();
    const began = Date.now();
    const launched = await engine.launch(input(snapshot(1)));
    const launchMs = Date.now() - began;
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    expect(launched.value.duplicate).toBe(false);
    expect(launchMs).toBeLessThan(700);

    const outcome = await launched.value.completion;
    expect(Date.now() - began).toBeGreaterThanOrEqual(900);
    expect(outcome.runId).toBe(launched.value.runId);
    expect(outcome.status).toBe("succeeded");
    await engine.stop();
  }, 15_000);

  it("replays the same idempotency key without spawning a second child", async () => {
    const { engine, store } = harness();
    await engine.start();
    const idempotency = { scope: "p1", key: "same-key", fingerprint: "fingerprint-1" };
    const first = await engine.launch(input(snapshot(1), idempotency));
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const replay = await engine.launch(input(snapshot(1), idempotency));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw replay.error;

    const [a, b] = await Promise.all([first.value.completion, replay.value.completion]);
    await engine.stop();
    expect(replay.value.duplicate).toBe(true);
    expect(replay.value.runId).toBe(first.value.runId);
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    const spawns = store.events
      .list(a.runId as never, { limit: 10_000 })
      .filter((event) => event.type === "node.process.spawned" && event.path === "wait");
    expect(spawns).toHaveLength(1);

    const mismatch = await engine.launch(
      input(snapshot(1), { ...idempotency, fingerprint: "fingerprint-2" }),
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("E_CONFLICT");
    await engine.stop();
  }, 15_000);
});
