import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Path } from "@relay/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AcquireScratchRequest,
  acquireScratch,
  finalizeScratch,
  listProjectWorkspaces,
  prepareRunWorkspace,
  releaseScratch,
  removeScratch,
  type ScratchWorkspace,
  validateRunWorkspace,
} from "../src/index.js";
import { cleanup, expectError, tempDir, unwrap } from "./helpers.js";

afterEach(cleanup);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(): { root: string; base: string } {
  const root = join(tempDir("relay-run-repo-"), "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "relay@example.invalid");
  git(root, "config", "user.name", "Relay Test");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function dataDir(): string {
  return join(tempDir("relay-run-data-"), "data");
}

type Selection =
  | { mode: "project" }
  | { mode: "existing-worktree"; path: string }
  | { mode: "new-worktree" };

function acquire(
  data: string,
  binding: { selection: Selection; projectRoot: string },
  overrides: Partial<AcquireScratchRequest> = {},
) {
  return acquireScratch({
    dataDir: data,
    projectId: "proj-1",
    runId: "run-1",
    path: "agent" as Path,
    attempt: 1,
    generation: 1,
    ...overrides,
    runWorkspace: binding,
  });
}

function runSelection(root: string, selection: Selection) {
  return { selection, projectRoot: root };
}

function stopped(attempt = 1, generation = 1) {
  return { attempt, generation, stopped: true as const, reason: "exited" as const, exitCode: 0 };
}

function finalize(ws: ScratchWorkspace, attempt = 1, generation = 1) {
  return finalizeScratch(ws, { outcome: "success", process: stopped(attempt, generation) });
}

function runDir(ws: ScratchWorkspace): string {
  return join(ws.dataDir, "projects", ws.projectId, "runs", ws.runId);
}

describe("project root run workspace", () => {
  it("runs every node in the registered root, sees dirty files, and never removes it", async () => {
    const root = tempDir("relay-run-project-");
    writeFileSync(join(root, "README.md"), "project\n");
    writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
    writeFileSync(join(root, "README.md"), "modified\n");
    const data = dataDir();

    const agent = unwrap(await acquire(data, runSelection(root, { mode: "project" })));
    const shell = unwrap(
      await acquire(data, runSelection(root, { mode: "project" }), {
        path: "shell" as Path,
        attempt: 2,
      }),
    );

    expect(agent.mode).toBe("project");
    expect(agent.dir).toBe(realpathSync(root));
    expect(shell.dir).toBe(agent.dir);
    expect(agent.projectRoot).toBe(realpathSync(root));
    expect(agent.selection).toEqual({ mode: "project" });
    expect(readFileSync(join(agent.dir, "README.md"), "utf8")).toBe("modified\n");
    expect(readFileSync(join(agent.dir, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    expect(agent.markerFile.startsWith(data)).toBe(true);
    expect(existsSync(join(root, "README.md"))).toBe(true);

    expect(unwrap(await finalize(agent)).dir).toBe(realpathSync(root));
    expect(existsSync(agent.markerFile)).toBe(true);
    expect(readdirSync(root).sort()).toEqual(["README.md", "dirty.txt"]);

    const removed = unwrap(await removeScratch(agent));
    expect(removed.removed).toBe(false);
    expect(existsSync(root)).toBe(true);
    releaseScratch(agent);
  });

  it("does not require Git for a project folder", async () => {
    const root = tempDir("relay-run-folder-");
    writeFileSync(join(root, "note.txt"), "hello\n");
    const ws = unwrap(await acquire(dataDir(), runSelection(root, { mode: "project" })));
    expect(ws.mode).toBe("project");
    expect(readFileSync(join(ws.dir, "note.txt"), "utf8")).toBe("hello\n");
    const catalog = unwrap(await listProjectWorkspaces(root));
    expect(catalog.git).toBe(false);
    expect(catalog.worktrees).toEqual([]);
  });
});

describe("existing worktree run workspace", () => {
  it("lists alternatives without the main root and selects a canonical listed worktree", async () => {
    const { root, base } = makeRepo();
    const wt = join(tempDir("relay-run-wt-"), "existing");
    git(root, "worktree", "add", "-q", "-b", "feature", wt, base);
    writeFileSync(join(wt, "dirty.txt"), "dirty in worktree\n");

    const catalog = unwrap(await listProjectWorkspaces(root));
    expect(catalog.git).toBe(true);
    expect(catalog.projectRoot).toBe(root);
    expect(catalog.worktrees.map((entry) => entry.path)).toEqual([realpathSync(wt)]);
    expect(catalog.worktrees[0]).toMatchObject({
      branch: "feature",
      head: base,
      detached: false,
    });

    const ws = unwrap(
      await acquire(dataDir(), runSelection(root, { mode: "existing-worktree", path: wt })),
    );
    expect(ws.mode).toBe("existing-worktree");
    expect(ws.dir).toBe(realpathSync(wt));
    expect(readFileSync(join(ws.dir, "dirty.txt"), "utf8")).toBe("dirty in worktree\n");
    expect(ws.markerFile.startsWith(ws.dataDir)).toBe(true);
    expect(existsSync(join(wt, ".relay-finalized.1.1.json"))).toBe(false);
    expect(readdirSync(wt).sort()).toEqual([".git", "dirty.txt", "tracked.txt"]);
  });

  it("keeps the frozen base but allows ordinary commits and resume in the user's tree", async () => {
    const { root, base } = makeRepo();
    const wt = join(tempDir("relay-run-wt-"), "existing");
    git(root, "worktree", "add", "-q", "-b", "feature", wt, base);
    const data = dataDir();
    const first = unwrap(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt })),
    );
    expect(first.baseSha).toBe(base);

    writeFileSync(join(wt, "work.txt"), "committed by workflow\n");
    git(wt, "add", "work.txt");
    git(wt, "commit", "-q", "-m", "workflow commit");
    const moved = git(wt, "rev-parse", "HEAD");
    expect(moved).not.toBe(base);

    const resumed = unwrap(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt }), {
        attempt: 2,
        generation: 2,
      }),
    );
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.baseSha).toBe(base);
    expect(readFileSync(join(resumed.dir, "work.txt"), "utf8")).toBe("committed by workflow\n");
    expect(unwrap(await finalize(resumed, 2, 2)).dir).toBe(realpathSync(wt));
    expect(git(wt, "rev-parse", "HEAD")).toBe(moved);
    expect(existsSync(join(wt, ".relay-finalized.2.2.json"))).toBe(false);
  });

  it("rejects unlisted directories, symlinked paths and the main root", async () => {
    const { root } = makeRepo();
    const outside = join(tempDir("relay-run-outside-"), "other");
    mkdirSync(outside);
    const data = dataDir();

    for (const path of [outside, root, `${root}/`]) {
      const error = expectError(
        await validateRunWorkspace(root, { mode: "existing-worktree", path }),
      );
      expect(error.code).toBe("E_VALIDATION");
    }

    const link = join(tempDir("relay-run-link-"), "link");
    symlinkSync(root, link);
    const linked = expectError(
      await validateRunWorkspace(root, { mode: "existing-worktree", path: link }),
    );
    expect(linked.code).toBe("E_VALIDATION");
    expect(
      expectError(
        await acquire(data, runSelection(root, { mode: "existing-worktree", path: outside })),
      ).code,
    ).toBe("E_VALIDATION");
  });
});

describe("new worktree run workspace", () => {
  it("creates a detached worktree under dataDir and reuses it across nodes", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(data, runSelection(root, { mode: "new-worktree" })));
    const shell = unwrap(
      await acquire(data, runSelection(root, { mode: "new-worktree" }), {
        path: "shell" as Path,
        attempt: 2,
      }),
    );

    expect(agent.mode).toBe("new-worktree");
    expect(agent.dir).toBe(join(runDir(agent), "worktree"));
    expect(agent.dir.startsWith(data)).toBe(true);
    expect(agent.dir).toBe(shell.dir);
    expect(agent.baseSha).toBe(base);
    expect(() => git(agent.dir, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(existsSync(join(agent.dir, "tracked.txt"))).toBe(true);
    expect(readdirSync(root).sort()).toEqual([".git", "tracked.txt"]);
    expect(unwrap(await finalize(agent)).dir).toBe(agent.dir);
  });

  it("survives workflow branch creation and commits, then reacquires/finalizes", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(data, runSelection(root, { mode: "new-worktree" })));
    git(first.dir, "switch", "-c", "workflow-branch");
    writeFileSync(join(first.dir, "work.txt"), "kept\n");
    git(first.dir, "add", "work.txt");
    git(first.dir, "commit", "-q", "-m", "workflow commit");
    const moved = git(first.dir, "rev-parse", "HEAD");
    expect(moved).not.toBe(base);

    const resumed = unwrap(
      await acquire(data, runSelection(root, { mode: "new-worktree" }), {
        attempt: 2,
        generation: 2,
        requireExisting: true,
      }),
    );
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.baseSha).toBe(base);
    expect(git(resumed.dir, "branch", "--show-current")).toBe("workflow-branch");
    expect(unwrap(await finalize(resumed, 2, 2)).dir).toBe(first.dir);
    expect(git(resumed.dir, "rev-parse", "HEAD")).toBe(moved);

    const removed = unwrap(await removeScratch(resumed));
    expect(removed.removed).toBe(true);
    expect(existsSync(first.dir)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

describe("run workspace identity and recovery", () => {
  it("prepare persists the frozen identity before the first dispatch", async () => {
    const root = tempDir("relay-run-prepare-");
    const data = dataDir();
    const identity = unwrap(
      await prepareRunWorkspace({
        dataDir: data,
        projectId: "proj-1",
        runId: "run-1",
        projectRoot: root,
        selection: { mode: "project" },
      }),
    );
    expect(identity.dir).toBe(realpathSync(root));
    expect(identity.mode).toBe("project");
    const file = join(data, "projects", "proj-1", "runs", "run-1", "run-workspace.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      selection: { mode: "project" },
      projectRoot: realpathSync(root),
      dir: realpathSync(root),
    });
  });

  it("fails closed when the run selection or project root changes", async () => {
    const root = tempDir("relay-run-frozen-");
    const other = tempDir("relay-run-other-");
    const data = dataDir();
    unwrap(await acquire(data, runSelection(root, { mode: "project" })));

    const changed = expectError(
      await acquire(data, runSelection(other, { mode: "project" }), { attempt: 2 }),
    );
    expect(changed.code).toBe("E_CONFLICT");
    expect(changed.details).toMatchObject({ step: "run_binding_conflict" });
  });

  it("prepare then acquires first and downstream nodes with requireExisting in project mode", async () => {
    const root = tempDir("relay-run-recover-");
    const data = dataDir();
    unwrap(
      await prepareRunWorkspace({
        dataDir: data,
        projectId: "proj-1",
        runId: "run-1",
        projectRoot: root,
        selection: { mode: "project" },
      }),
    );
    const first = unwrap(
      await acquire(data, runSelection(root, { mode: "project" }), {
        path: "first" as Path,
        requireExisting: true,
      }),
    );
    const second = unwrap(
      await acquire(data, runSelection(root, { mode: "project" }), {
        path: "second" as Path,
        attempt: 2,
        requireExisting: true,
      }),
    );
    expect(first.dir).toBe(realpathSync(root));
    expect(second.dir).toBe(first.dir);
    expect(first.markerFile.startsWith(data)).toBe(true);
    expect(existsSync(root)).toBe(true);

    rmSync(join(data, "projects", "proj-1", "runs", "run-1", "ws"), {
      recursive: true,
      force: true,
    });
    const again = unwrap(
      await acquire(data, runSelection(root, { mode: "project" }), {
        path: "first" as Path,
        requireExisting: true,
      }),
    );
    expect(again.dir).toBe(realpathSync(root));
    expect(existsSync(again.markerFile)).toBe(false);
  });

  it("prepare then acquires first and downstream nodes with requireExisting in existing-worktree mode", async () => {
    const { root, base } = makeRepo();
    const wt = join(tempDir("relay-run-recover-wt-"), "existing");
    git(root, "worktree", "add", "-q", "-b", "feature", wt, base);
    const data = dataDir();
    unwrap(
      await prepareRunWorkspace({
        dataDir: data,
        projectId: "proj-1",
        runId: "run-1",
        projectRoot: root,
        selection: { mode: "existing-worktree", path: wt },
      }),
    );
    const first = unwrap(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt }), {
        path: "first" as Path,
        requireExisting: true,
      }),
    );
    const second = unwrap(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt }), {
        path: "second" as Path,
        attempt: 2,
        requireExisting: true,
      }),
    );
    expect(first.dir).toBe(realpathSync(wt));
    expect(second.dir).toBe(first.dir);
    expect(existsSync(join(wt, ".relay-finalized.1.1.json"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("prepare then acquires first and downstream nodes with requireExisting in new-worktree mode", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    unwrap(
      await prepareRunWorkspace({
        dataDir: data,
        projectId: "proj-1",
        runId: "run-1",
        projectRoot: root,
        selection: { mode: "new-worktree" },
      }),
    );
    const first = unwrap(
      await acquire(data, runSelection(root, { mode: "new-worktree" }), {
        path: "first" as Path,
        requireExisting: true,
      }),
    );
    const second = unwrap(
      await acquire(data, runSelection(root, { mode: "new-worktree" }), {
        path: "second" as Path,
        attempt: 2,
        requireExisting: true,
      }),
    );
    expect(first.dir).toBe(join(data, "projects", "proj-1", "runs", "run-1", "worktree"));
    expect(second.dir).toBe(first.dir);
    expect(existsSync(join(first.dir, "tracked.txt"))).toBe(true);
  });

  it("rejects a missing run binding on resume and never recreates it", async () => {
    const root = tempDir("relay-run-missing-binding-");
    const data = dataDir();
    unwrap(await acquire(data, runSelection(root, { mode: "project" })));
    const file = join(data, "projects", "proj-1", "runs", "run-1", "run-workspace.json");
    rmSync(file);
    const error = expectError(
      await acquire(data, runSelection(root, { mode: "project" }), {
        attempt: 2,
        requireExisting: true,
      }),
    );
    expect(error.code).toBe("E_WORKSPACE");
    expect(error.details).toMatchObject({ step: "run_binding_missing" });
    expect(existsSync(file)).toBe(false);

    const prepared = expectError(
      await prepareRunWorkspace({
        dataDir: data,
        projectId: "proj-1",
        runId: "run-1",
        projectRoot: root,
        selection: { mode: "project" },
        requireExisting: true,
      }),
    );
    expect(prepared.code).toBe("E_WORKSPACE");
    expect(prepared.details).toMatchObject({ step: "run_binding_missing" });
  });

  it("detects a project root replaced at the frozen path on acquire and finalize", async () => {
    const root = join(tempDir("relay-run-replaced-"), "project");
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "keep\n");
    const data = dataDir();
    const ws = unwrap(await acquire(data, runSelection(root, { mode: "project" })));

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    const acquireError = expectError(
      await acquire(data, runSelection(root, { mode: "project" }), { attempt: 2 }),
    );
    expect(acquireError.code).toBe("E_CONFLICT");
    expect(acquireError.details).toMatchObject({ step: "project_identity" });

    const finalizeError = expectError(await finalize(ws));
    expect(finalizeError.code).toBe("E_CONFLICT");
    expect(finalizeError.details).toMatchObject({ step: "project_identity" });
  });

  it("detects a selected worktree replaced at the frozen path before finalize", async () => {
    const { root, base } = makeRepo();
    const wt = join(tempDir("relay-run-replaced-wt-"), "existing");
    git(root, "worktree", "add", "-q", "-b", "feature", wt, base);
    const data = dataDir();
    const ws = unwrap(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt })),
    );

    git(root, "worktree", "remove", "--force", wt);
    git(root, "worktree", "add", "-q", "--detach", wt, base);
    const resumed = expectError(
      await acquire(data, runSelection(root, { mode: "existing-worktree", path: wt }), {
        attempt: 2,
      }),
    );
    expect(resumed.code).toBe("E_CONFLICT");
    expect(resumed.details).toMatchObject({ step: "workspace_identity" });
    const finalized = expectError(await finalize(ws));
    expect(finalized.code).toBe("E_CONFLICT");
    expect(finalized.details).toMatchObject({ step: "workspace_identity" });
  });

  it("rejects a tampered binding and a missing new worktree on recovery", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const ws = unwrap(await acquire(data, runSelection(root, { mode: "new-worktree" })));
    const file = join(data, "projects", "proj-1", "runs", "run-1", "run-workspace.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stored, dirId: "0:0" }));

    const tampered = expectError(await finalize(ws));
    expect(tampered.code).toBe("E_CONFLICT");
    expect(tampered.details).toMatchObject({ step: "run_binding_conflict" });

    rmSync(ws.dir, { recursive: true, force: true });
    const missing = expectError(
      await acquire(data, runSelection(root, { mode: "new-worktree" }), {
        attempt: 2,
        requireExisting: true,
      }),
    );
    expect(missing.code).toBe("E_WORKSPACE");
  });

  it("rejects malformed selections and missing project roots", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    expect(
      expectError(
        await acquire(data, { selection: { mode: "scratch" }, projectRoot: root } as never),
      ).code,
    ).toBe("E_VALIDATION");
    expect(
      expectError(
        await acquire(data, { selection: { mode: "project" }, projectRoot: "/nonexistent/x" }),
      ).code,
    ).toBe("E_VALIDATION");
  });
});
