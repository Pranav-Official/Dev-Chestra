import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAdapterRegistry } from "@devchestra/adapters";
import { DevChestraError, err, ok, type Path } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import {
  type AcquireScratchRequest,
  acquireScratch,
  type FinalizeScratchRequest,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
  type ScratchWorkspace,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeAccepted } from "../src/agent-support.js";
import { type ActiveRunState, EngineContext } from "../src/context.js";
import { createEngine } from "../src/engine.js";
import type { Engine, WorkspacePort } from "../src/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempRepo(): { project: string; dataDir: string; head: string } {
  const base = mkdtempSync(join(tmpdir(), "devchestra-worktree-"));
  const project = join(base, "project");
  const dataDir = join(base, "data");
  mkdirSync(project);
  mkdirSync(dataDir);
  git(project, "init", "-q");
  git(project, "config", "user.email", "devchestra@test.invalid");
  git(project, "config", "user.name", "DevChestra Test");
  writeFileSync(join(project, "committed.txt"), "committed\n");
  git(project, "add", "committed.txt");
  git(project, "commit", "-q", "-m", "initial");
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return {
    project: realpathSync.native(project),
    dataDir: realpathSync.native(dataDir),
    head: git(project, "rev-parse", "HEAD"),
  };
}

type RunRequest = AcquireScratchRequest & {
  runWorkspace?: {
    selection:
      | { mode: "project" }
      | { mode: "existing-worktree"; path: string }
      | { mode: "new-worktree" };
    projectRoot: string;
  };
};

/**
 * Contract-faithful test adapter: one workspace per run, reused across nodes
 * and after restart. Legacy runs (no runWorkspace) keep per-node scratch.
 */
function testPort(dataDir: string) {
  const worktrees = new Map<string, string>();
  const requests: AcquireScratchRequest[] = [];
  const workspace = (request: AcquireScratchRequest, mode: string, dir: string): ScratchWorkspace =>
    ({
      mode,
      dataDir,
      projectId: request.projectId,
      runId: request.runId,
      path: request.path as Path,
      attempt: request.attempt,
      generation: request.generation,
      dir,
      markerFile: join(dir, `.devchestra-finalized.${request.attempt}.${request.generation}.json`),
      reused: request.requireExisting === true,
      projectRoot: request.projectRoot ?? null,
    }) as unknown as ScratchWorkspace;
  const port: WorkspacePort = {
    prepare: async (request) => {
      const selection = request.selection;
      if (selection.mode === "project") {
        return ok({
          projectRoot: request.projectRoot,
          selection,
          dir: request.projectRoot,
          mode: "project",
          baseSha: null,
          git: true,
        });
      }
      if (selection.mode === "existing-worktree") {
        return ok({
          projectRoot: request.projectRoot,
          selection,
          dir: selection.path,
          mode: "existing-worktree",
          baseSha: null,
          git: true,
        });
      }
      const existing = worktrees.get(request.runId);
      if (existing !== undefined) {
        return ok({
          projectRoot: request.projectRoot,
          selection,
          dir: existing,
          mode: "new-worktree",
          baseSha: git(existing, "rev-parse", "HEAD"),
          git: true,
        });
      }
      if (request.requireExisting) {
        return err(
          new DevChestraError("E_WORKSPACE", "worktree is missing", {
            details: { step: "workspace_lost" },
          }),
        );
      }
      const dir = join(dataDir, "worktrees", request.runId);
      mkdirSync(dirname(dir), { recursive: true });
      git(
        request.projectRoot,
        "worktree",
        "add",
        "--detach",
        dir,
        git(request.projectRoot, "rev-parse", "HEAD"),
      );
      worktrees.set(request.runId, dir);
      return ok({
        projectRoot: request.projectRoot,
        selection,
        dir,
        mode: "new-worktree",
        baseSha: git(dir, "rev-parse", "HEAD"),
        git: true,
      });
    },
    acquire: async (request) => {
      requests.push(request);
      const runWorkspace = (request as RunRequest).runWorkspace;
      if (runWorkspace !== undefined) {
        const selection = runWorkspace.selection;
        if (selection.mode === "project") {
          return ok(workspace(request, "project", runWorkspace.projectRoot));
        }
        if (selection.mode === "existing-worktree") {
          return ok(workspace(request, "existing-worktree", selection.path));
        }
        const existing = worktrees.get(request.runId);
        if (existing !== undefined) return ok(workspace(request, "new-worktree", existing));
        if (request.requireExisting) {
          return err(
            new DevChestraError("E_WORKSPACE", "worktree is missing", {
              details: { step: "workspace_lost" },
            }),
          );
        }
        const dir = join(dataDir, "worktrees", request.runId);
        mkdirSync(dirname(dir), { recursive: true });
        git(
          runWorkspace.projectRoot,
          "worktree",
          "add",
          "--detach",
          dir,
          git(runWorkspace.projectRoot, "rev-parse", "HEAD"),
        );
        worktrees.set(request.runId, dir);
        return ok(workspace(request, "new-worktree", dir));
      }
      if (request.mode === "worktree") {
        const existing = worktrees.get(request.runId);
        if (existing !== undefined) return ok(workspace(request, "worktree", existing));
        if (request.requireExisting) {
          return err(
            new DevChestraError("E_WORKSPACE", "worktree is missing", {
              details: { step: "workspace_lost" },
            }),
          );
        }
        if (request.projectRoot === undefined) {
          return err(new DevChestraError("E_WORKSPACE", "projectRoot is required"));
        }
        const dir = join(dataDir, "worktrees", request.runId);
        mkdirSync(dirname(dir), { recursive: true });
        git(
          request.projectRoot,
          "worktree",
          "add",
          "--detach",
          dir,
          git(request.projectRoot, "rev-parse", "HEAD"),
        );
        worktrees.set(request.runId, dir);
        return ok(workspace(request, "worktree", dir));
      }
      const dir = join(dataDir, "scratch", request.runId, String(request.path));
      mkdirSync(dir, { recursive: true });
      return ok(workspace(request, "scratch", dir));
    },
    finalize: async (target, request: FinalizeScratchRequest) =>
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
  return { port, requests };
}

const realPort: WorkspacePort = {
  prepare: prepareRunWorkspace,
  acquire: acquireScratch,
  finalize: finalizeScratch,
  release: releaseScratch,
};

function harness(kind: "real" | "fake" = "real") {
  const repo = tempRepo();
  const store = openStore({ file: join(repo.dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: repo.project, kind: "git" });
  cleanups.push(() => store.close());
  const fake = testPort(repo.dataDir);
  const port = kind === "real" ? realPort : fake.port;
  return { ...repo, store, fake, port, engine: engineFor(store, repo.dataDir, port) };
}

function engineFor(store: Store, dataDir: string, workspaces: WorkspacePort): Engine {
  return createEngine({
    store,
    adapters: createAdapterRegistry({ ids: [] }),
    workspaces,
    gateway: {
      url: "http://127.0.0.1:1",
      issue() {
        throw new Error("not used");
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused-shim.js"),
    env: process.env,
  });
}

function workflow(nodes: { id: string; mode: "scratch" | "worktree"; command: string }[]): unknown {
  const all = [
    { id: "start", type: "start", name: "Start", params: [] },
    ...nodes.map((node) => ({
      id: node.id,
      type: "shell",
      name: node.id,
      command: node.command,
      workspace: { mode: node.mode },
      timeoutMin: 1,
      allowFailure: false,
    })),
    { id: "end", type: "end", name: "End", status: "success", result: "{}" },
  ];
  const edges = all.slice(1).map((node, index) => ({
    id: `e${index + 1}`,
    from: all[index]?.id,
    to: node.id,
  }));
  return {
    schemaVersion: 1,
    id: "worktree-test",
    name: "Worktree test",
    graph: { nodes: all, edges },
  };
}

type Selection =
  | { mode: "project" }
  | { mode: "existing-worktree"; path: string }
  | { mode: "new-worktree" };

function input(snapshot: unknown, workspace?: Selection) {
  return {
    projectId: "p1",
    workflowId: "worktree-test",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/** Seed a pre-run-level (workspace=null) run so legacy node routing is used. */
function legacyRun(store: Store, snapshot: unknown) {
  return store.runs.create({
    projectId: "p1",
    workflowId: "worktree-test",
    workflowHash: "legacy",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
  });
}

function stdout(store: Store, runId: string, path: string): string {
  const output = store.outputs.get({ runId: runId as never, path: path as Path, attempt: 1 });
  return String((output?.json as { stdout?: string } | undefined)?.stdout ?? "");
}

function created(store: Store, runId: string, path: string) {
  return store.events
    .list(runId as never, { limit: 10_000 })
    .find(
      (event) =>
        event.type === "workspace.created" &&
        event.path === path &&
        (event.payload as { attempt?: number }).attempt === 1,
    )?.payload as { mode?: string; dir?: string; baseSha?: string } | undefined;
}

describe("run-level workspaces", () => {
  it("uses one new worktree for every node and never the project checkout", async () => {
    const { store, engine, dataDir, project, head } = harness("fake");
    await engine.start();
    const run = await engine.run(
      input(
        workflow([
          {
            id: "prepare",
            mode: "worktree",
            command: "printf 'shared\\n' > shared.txt; git rev-parse HEAD; cat committed.txt; pwd",
          },
          { id: "verify", mode: "worktree", command: "cat shared.txt; git rev-parse HEAD; pwd" },
        ]),
        { mode: "new-worktree" },
      ),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) throw run.error;
    expect(run.value.status).toBe("succeeded");
    const runId = run.value.runId;

    const prepare = stdout(store, runId, "prepare").split("\n");
    const verify = stdout(store, runId, "verify").split("\n");
    expect(prepare[0]).toBe(head);
    expect(prepare[1]).toBe("committed");
    expect(verify[0]).toBe("shared");
    expect(verify[1]).toBe(head);
    expect(verify[2]).toBe(prepare[2]);
    expect(prepare[2]).not.toBe(project);
    expect(prepare[2]?.startsWith(dataDir)).toBe(true);
    expect(git(project, "status", "--porcelain")).toBe("");

    const prepareCreated = created(store, runId, "prepare");
    expect(prepareCreated).toMatchObject({ mode: "new-worktree", dir: prepare[2] });
    expect(created(store, runId, "verify")).toMatchObject({
      mode: "new-worktree",
      dir: prepare[2],
    });
    await engine.stop();
  }, 20_000);

  it("keeps the same worktree directory and committed files across stop and resume", async () => {
    const { store, engine, dataDir, port } = harness("fake");
    await engine.start();
    const launched = await engine.launch(
      input(
        workflow([
          { id: "prepare", mode: "worktree", command: "printf 'kept\\n' > kept.txt; pwd" },
          { id: "hold", mode: "worktree", command: "sleep 10" },
          { id: "after", mode: "worktree", command: "cat kept.txt; pwd" },
        ]),
        { mode: "new-worktree" },
      ),
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const runId = launched.value.runId;

    let ready = false;
    for (let i = 0; i < 500 && !ready; i += 1) {
      const executions = store.view.get(runId as never).executions;
      ready = executions.prepare?.status === "succeeded" && executions.hold?.status === "running";
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready).toBe(true);
    await engine.stop();
    expect((await engine.getRun(runId))?.status).toBe("paused");

    const resumedEngine = engineFor(store, dataDir, port);
    await resumedEngine.start();
    const resumed = await resumedEngine.resume(runId, { allowUncertainSideEffectRetry: true });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("succeeded");
    await resumedEngine.stop();

    const prepareDir = created(store, runId, "prepare")?.dir;
    expect(created(store, runId, "hold")?.dir).toBe(prepareDir);
    expect(created(store, runId, "after")?.dir).toBe(prepareDir);
    const after = stdout(store, runId, "after").split("\n");
    expect(after[0]).toBe("kept");
    expect(after[1]).toBe(prepareDir);
    expect(created(store, runId, "hold")?.mode).toBe("new-worktree");
    expect(created(store, runId, "after")?.mode).toBe("new-worktree");
  }, 25_000);

  it("keeps legacy node workspace routing for runs frozen before the feature", async () => {
    const { store, engine } = harness();
    await engine.start();
    const snapshot = workflow([
      { id: "prepare", mode: "worktree", command: "printf 'legacy\\n' > legacy.txt; pwd" },
      { id: "after", mode: "worktree", command: "cat legacy.txt; pwd" },
    ]);
    const seeded = legacyRun(store, snapshot);
    expect(store.runs.get(seeded.runId)?.workspace).toBeNull();
    const run = await engine.resume(seeded.runId);
    expect(run.ok).toBe(true);
    if (!run.ok) throw run.error;
    expect(run.value.status).toBe("succeeded");
    const prepare = created(store, seeded.runId, "prepare");
    expect(prepare?.mode).toBe("worktree");
    expect(created(store, seeded.runId, "after")?.dir).toBe(prepare?.dir);
    expect(stdout(store, seeded.runId, "after").split("\n")[0]).toBe("legacy");
    await engine.stop();
  }, 20_000);
});

describe("legacy worktree identity", () => {
  it("rejects a legacy resume when the persisted project identity changed", async () => {
    const { store, engine, dataDir } = harness();
    await engine.start();
    const seeded = legacyRun(
      store,
      workflow([{ id: "hold", mode: "worktree", command: "sleep 10" }]),
    );
    const launched = await engine.launchResume(seeded.runId);
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    const runId = seeded.runId;
    let ready = false;
    for (let i = 0; i < 500 && !ready; i += 1) {
      ready = store.view.get(runId as never).executions.hold?.status === "running";
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready).toBe(true);
    await engine.stop();

    const bindingFile = join(dataDir, "projects", "p1", "runs", runId, "project-worktree.json");
    const binding = JSON.parse(readFileSync(bindingFile, "utf8")) as { projectRoot: string };
    binding.projectRoot = join(dataDir, "different-project");
    writeFileSync(bindingFile, `${JSON.stringify(binding)}\n`);

    const resumedEngine = engineFor(store, dataDir, realPort);
    await resumedEngine.start();
    const resumed = await resumedEngine.resume(runId, { allowUncertainSideEffectRetry: true });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw resumed.error;
    expect(resumed.value.status).toBe("failed");
    expect(resumed.value.error?.code).toMatch(/^E_(WORKSPACE|CONFLICT)$/);
    await resumedEngine.stop();
  }, 20_000);
});

describe("worktree acquisition mode", () => {
  it("fails closed without a snapshot workspace and uses worktree for accepted output", async () => {
    const { store, dataDir, fake } = harness("fake");
    const snapshot = workflow([{ id: "work", mode: "worktree", command: "true" }]) as {
      graph: { nodes: { id: string; workspace?: { mode: string } }[] };
    };
    const createdRun = store.runs.create({
      projectId: "p1",
      workflowId: "worktree-test",
      workflowHash: "hash",
      snapshot,
      snapshotRaw: JSON.stringify(snapshot),
    });
    const run = store.runs.get(createdRun.runId);
    if (run === null) throw new Error("missing run");
    const ctx = new EngineContext({
      store,
      adapters: {
        get() {
          throw new Error("not used");
        },
        has: () => false,
        ids: () => [],
      },
      workspaces: fake.port,
      gateway: {
        url: "http://127.0.0.1:1",
        issue() {
          throw new Error("not used");
        },
      },
      dataDir,
      nodeBin: process.execPath,
      mcpShimEntry: "/unused",
    });
    const acquired = await ctx.acquire(run, "work", 1, 1, new AbortController().signal);
    expect(acquired.mode).toBe("worktree");
    expect(fake.requests.at(-1)).toMatchObject({ mode: "worktree", projectRoot: run.project.path });

    const missing = structuredClone(snapshot);
    const work = missing.graph.nodes.find((node) => node.id === "work");
    if (work === undefined) throw new Error("missing node");
    delete work.workspace;
    const missingRun = store.runs.create({
      projectId: "p1",
      workflowId: "worktree-test",
      workflowHash: "hash2",
      snapshot: missing,
      snapshotRaw: JSON.stringify(missing),
    });
    const broken = store.runs.get(missingRun.runId);
    if (broken === null) throw new Error("missing run");
    const before = fake.requests.length;
    await expect(
      ctx.acquire(broken, "work", 1, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "E_WORKFLOW_INVALID",
    });
    expect(fake.requests.length).toBe(before);

    const execution = store.executions.ensure({
      runId: createdRun.runId,
      path: "work" as Path,
      nodeId: "work",
      kind: "agent",
      validationLimit: 2,
    });
    const identity = store.executions.beginInvocation({
      runId: createdRun.runId,
      path: "work" as Path,
      attempt: execution.attempt,
    });
    store.submissions.submit({
      identity,
      callId: "accepted-1",
      request: { name: "submit_result", arguments: { summary: "ok" } },
      ok: true,
      output: { summary: "ok" },
      schemaHash: "schema",
    });
    const active: ActiveRunState = {
      abort: new AbortController(),
      reason: null,
      tokens: new Set(),
    };
    const beforeAccepted = fake.requests.length;
    await finalizeAccepted(ctx, run, { id: "work", type: "agent", raw: {} }, active, {
      runId: createdRun.runId,
      path: "work" as Path,
      outputId: "out",
      outputHash: "hash",
      schemaHash: "schema",
      attempt: identity.attempt,
      generation: identity.generation,
      acceptedEventId: 0,
    });
    expect(fake.requests.length).toBe(beforeAccepted + 1);
    expect(fake.requests.at(-1)).toMatchObject({ mode: "worktree", requireExisting: true });
    expect(store.view.get(createdRun.runId).executions.work?.status).toBe("succeeded");
  });
});
