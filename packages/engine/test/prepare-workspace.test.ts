import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { DevChestraError, err, ok } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import type {
  AcquireScratchRequest,
  PrepareRunWorkspaceRequest,
  RunWorkspaceIdentity,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, WorkspacePort } from "../src/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Harness {
  engine: Engine;
  store: Store;
  dataDir: string;
  project: string;
  prepares: PrepareRunWorkspaceRequest[];
  acquires: AcquireScratchRequest[];
}

function harness(options: { failPrepare?: boolean } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), "devchestra-engine-prepare-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project);
  mkdirSync(dataDir);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  cleanups.push(() => store.close());
  store.projects.ensure({ id: "p1", name: "P1", path: project, kind: "folder" });
  const prepares: PrepareRunWorkspaceRequest[] = [];
  const acquires: AcquireScratchRequest[] = [];
  const port: WorkspacePort = {
    prepare: async (request) => {
      prepares.push(request);
      if (options.failPrepare === true) {
        return err(
          new DevChestraError("E_WORKSPACE", "prepare failed", { details: { step: "test" } }),
        );
      }
      const dir =
        request.selection.mode === "existing-worktree"
          ? request.selection.path
          : request.projectRoot;
      const identity: RunWorkspaceIdentity = {
        projectRoot: request.projectRoot,
        selection: request.selection,
        dir,
        mode: request.selection.mode,
        baseSha: null,
        git: false,
      };
      return ok(identity);
    },
    acquire: async (request) => {
      acquires.push(request);
      return ok({
        mode: "project",
        dataDir,
        projectId: request.projectId,
        runId: request.runId,
        path: request.path as never,
        attempt: request.attempt,
        generation: request.generation,
        dir:
          request.runWorkspace?.selection.mode === "existing-worktree"
            ? request.runWorkspace.selection.path
            : (request.runWorkspace?.projectRoot ?? project),
        markerFile: join(dataDir, "marker"),
        reused: true,
        projectRoot: request.projectRoot ?? null,
      });
    },
    finalize: async (target, request) =>
      ok({
        dir: target.dir,
        attempt: request.process.attempt,
        generation: request.process.generation,
        outcome: request.outcome,
        alreadyFinalized: false,
        markerFile: target.markerFile,
        process: request.process,
      }),
    release: () => undefined,
  };
  const engine = createEngine({
    store,
    adapters: createAdapterRegistry({ ids: [] }),
    workspaces: port,
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "token-value", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused.js"),
    env: process.env,
  });
  return { engine, store, dataDir, project, prepares, acquires };
}

function snapshot(): unknown {
  return {
    schemaVersion: 1,
    id: "prepare",
    name: "Prepare",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "work",
          type: "shell",
          name: "Work",
          command: "true",
          timeoutMin: 1,
          allowFailure: false,
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "work" },
        { id: "e2", from: "work", to: "end" },
      ],
    },
  };
}

function input(snap: unknown) {
  return {
    projectId: "p1",
    workflowId: "prepare",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
  };
}

describe("run workspace preparation", () => {
  it("binds the frozen project root before any node acquisition", async () => {
    const s = harness();
    await s.engine.start();
    const launched = await s.engine.launch(input(snapshot()));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("succeeded");
    expect(s.prepares).toHaveLength(1);
    expect(s.prepares[0]).toMatchObject({
      projectRoot: s.project,
      selection: { mode: "project" },
    });
    expect(s.prepares[0]?.requireExisting ?? false).toBe(false);
    expect(s.acquires).toHaveLength(1);
    expect(s.acquires[0]?.requireExisting).toBe(true);
    const run = s.store.runs.get(launched.value.runId as never);
    expect(run?.workspace).toEqual({
      selection: { mode: "project" },
      projectRoot: s.project,
    });
    await s.engine.stop();
  });

  it("fails durably before dispatch when preparation fails", async () => {
    const s = harness({ failPrepare: true });
    await s.engine.start();
    const launched = await s.engine.launch(input(snapshot()));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(s.acquires).toHaveLength(0);
    expect(
      s.store.events
        .list(launched.value.runId as never, { limit: 100 })
        .some((event) => event.type === "node.process.spawned"),
    ).toBe(false);
    await s.engine.stop();
  });

  it("freezes an existing worktree selection and reuses it on resume", async () => {
    const s = harness();
    await s.engine.start();
    const worktree = join(s.dataDir, "user-worktree");
    mkdirSync(worktree);
    const launched = await s.engine.launch({
      ...input(snapshot()),
      workspace: { mode: "existing-worktree", path: worktree },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("succeeded");
    expect(s.prepares[0]).toMatchObject({
      selection: { mode: "existing-worktree", path: worktree },
      projectRoot: s.project,
    });
    expect(s.acquires[0]?.runWorkspace).toEqual({
      selection: { mode: "existing-worktree", path: worktree },
      projectRoot: s.project,
    });
    expect(s.acquires[0]?.requireExisting).toBe(true);
    await s.engine.stop();
  });

  it("rejects an invalid selection before any run is created", async () => {
    const s = harness();
    await s.engine.start();
    const launched = await s.engine.launch({
      ...input(snapshot()),
      workspace: { mode: "scratch" } as never,
    });
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected invalid selection");
    expect(launched.error.code).toBe("E_VALIDATION");
    expect(s.store.runs.list({ limit: 10 }).items).toHaveLength(0);
    expect(s.prepares).toHaveLength(0);
    await s.engine.stop();
  });

  it("resume is validate-only and never creates a missing binding", async () => {
    const s = harness({ failPrepare: true });
    await s.engine.start();
    const snap = snapshot();
    const created = s.store.runs.create({
      projectId: "p1",
      workflowId: "prepare",
      workflowHash: "hash",
      snapshot: snap,
      snapshotRaw: JSON.stringify(snap),
      workspace: {
        selection: { mode: "new-worktree" },
        projectRoot: s.project,
      },
    });
    const outcome = await s.engine.resume(created.runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.status).toBe("failed");
    expect(s.prepares).toHaveLength(1);
    expect(s.prepares[0]?.requireExisting).toBe(true);
    expect(s.acquires).toHaveLength(0);
    await s.engine.stop();
  });
});
