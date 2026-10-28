import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fsSlug, type Path } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AcquireScratchRequest,
  acquireScratch,
  finalizeScratch,
  releaseScratch,
  removeScratch,
  type ScratchWorkspace,
} from "../src/index.js";
import { cleanup, expectError, tempDir, unwrap } from "./helpers.js";

afterEach(cleanup);

function acquire(dataDir: string, overrides: Partial<AcquireScratchRequest> = {}) {
  return acquireScratch({
    dataDir,
    projectId: "proj-1",
    runId: "run-1",
    path: "agent" as Path,
    attempt: 1,
    generation: 1,
    ...overrides,
  });
}

function dataDir(): string {
  return join(tempDir(), "data");
}

function stopped(attempt = 1, generation = 1) {
  return { attempt, generation, stopped: true as const, reason: "exited" as const, exitCode: 0 };
}

describe("scratch workspaces", () => {
  it("creates a stable owner-only directory and reuses it", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    expect(ws.mode).toBe("scratch");
    expect(ws.dir).toBe(join(ws.dataDir, "projects", "proj-1", "runs", "run-1", "ws", "agent"));
    expect(statSync(ws.dir).mode & 0o777).toBe(0o700);
    expect(statSync(ws.dataDir).mode & 0o777).toBe(0o700);
    expect(ws.reused).toBe(false);
    expect(ws.markerFile).toBe(join(ws.dir, ".devchestra-finalized.1.1.json"));
    expect(existsSync(ws.markerFile)).toBe(false);
    expect(Object.isFrozen(ws)).toBe(true);

    const again = unwrap(await acquire(dir));
    expect(again.dir).toBe(ws.dir);
    expect(again.reused).toBe(true);
    releaseScratch(again);
    releaseScratch(again);
  });

  it("uses collision-free fsSlug names", async () => {
    const dir = dataDir();
    const paths = ["x[1]", "x-1", "x#1", "x-r1", "a/b", "a__b"];
    const dirs = new Set<string>();
    for (const path of paths) {
      const ws = unwrap(await acquire(dir, { path: path as Path }));
      expect(ws.dir.endsWith(fsSlug(path as Path))).toBe(true);
      dirs.add(ws.dir);
      expect(unwrap(await acquire(dir, { path: path as Path })).dir).toBe(ws.dir);
    }
    expect(dirs.size).toBe(paths.length);
  });

  it("rejects unsafe ids, paths, data dirs and unsupported modes", async () => {
    const dir = dataDir();
    for (const projectId of ["../evil", "a/b", "..", "", "a".repeat(129), "a\0b"]) {
      expect(expectError(await acquire(dir, { projectId })).code, projectId).toBe("E_VALIDATION");
    }
    for (const runId of ["../evil", "a/b", "..", "", "a".repeat(129), "a\0b"]) {
      expect(expectError(await acquire(dir, { runId })).code, runId).toBe("E_VALIDATION");
    }
    for (const path of ["", "../evil", "a//b", "A", "a[01]"]) {
      expect(expectError(await acquire(dir, { path })).code, path).toBe("E_VALIDATION");
    }
    expect(expectError(await acquire("relative")).code).toBe("E_VALIDATION");
    expect(expectError(await acquire("/")).code).toBe("E_VALIDATION");

    const worktree = await acquire(dir, { mode: "worktree" });
    expect(expectError(worktree).code).toBe("E_WORKSPACE");
    expect(expectError(worktree).details).toMatchObject({ step: "project_root_required" });
    const project = expectError(await acquire(dir, { mode: "project" }));
    expect(project.code).toBe("E_WORKSPACE");
    expect(project.details).toMatchObject({ step: "unsupported_mode", mode: "project" });
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the registered project root read-only and never uses it as cwd", async () => {
    const projectRoot = tempDir("devchestra-project-");
    writeFileSync(join(projectRoot, "README.md"), "project");
    const ws = unwrap(await acquire(dataDir(), { projectRoot }));
    expect(ws.projectRoot).toBe(realpathSync(projectRoot));
    expect(ws.dir.startsWith(ws.dataDir)).toBe(true);
    expect(ws.dir.startsWith(projectRoot)).toBe(false);
    expect(readdirSync(projectRoot)).toEqual(["README.md"]);
  });

  it("cancels before creating an explicit data directory", async () => {
    const dir = dataDir();
    const controller = new AbortController();
    controller.abort();
    expect(expectError(await acquire(dir, { signal: controller.signal })).code).toBe("E_CANCELLED");
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the same directory and files across reacquire, retry and restart", async () => {
    const dir = dataDir();
    const first = unwrap(await acquire(dir));
    writeFileSync(join(first.dir, "work.txt"), "kept");
    const restarted = unwrap(await acquire(dir));
    expect(restarted.dir).toBe(first.dir);
    expect(restarted.reused).toBe(true);
    expect(readFileSync(join(restarted.dir, "work.txt"), "utf8")).toBe("kept");
    const retry = unwrap(await acquire(dir, { attempt: 2 }));
    expect(retry.dir).toBe(first.dir);
    expect(retry.attempt).toBe(2);
    expect(existsSync(join(retry.dir, "work.txt"))).toBe(true);
  });
});

describe("scratch finalization", () => {
  it("requires observed process evidence and records an immutable idempotent marker", async () => {
    const ws = unwrap(await acquire(dataDir()));
    const running = await finalizeScratch(ws, {
      outcome: "success",
      process: { attempt: 1, generation: 1, stopped: false as unknown as true },
    });
    expect(expectError(running).code).toBe("E_WORKSPACE");
    expect(existsSync(ws.markerFile)).toBe(false);

    const wrong = await finalizeScratch(ws, {
      outcome: "success",
      process: stopped(2, 1),
    });
    expect(expectError(wrong).code).toBe("E_CONFLICT");

    const first = unwrap(await finalizeScratch(ws, { outcome: "success", process: stopped() }));
    expect(first.alreadyFinalized).toBe(false);
    expect(first.markerFile).toBe(ws.markerFile);
    expect(statSync(first.markerFile).mode & 0o777).toBe(0o600);
    const content = readFileSync(first.markerFile, "utf8");

    const again = unwrap(await finalizeScratch(ws, { outcome: "success", process: stopped() }));
    expect(again.alreadyFinalized).toBe(true);
    expect(readFileSync(first.markerFile, "utf8")).toBe(content);
    const evidenceConflict = await finalizeScratch(ws, {
      outcome: "success",
      process: { attempt: 1, generation: 1, stopped: true, reason: "grace_timeout", exitCode: 1 },
    });
    expect(expectError(evidenceConflict).code).toBe("E_CONFLICT");
    expect(readFileSync(first.markerFile, "utf8")).toBe(content);

    const conflict = await finalizeScratch(ws, { outcome: "failed", process: stopped() });
    expect(expectError(conflict).code).toBe("E_CONFLICT");
    expect(readFileSync(first.markerFile, "utf8")).toBe(content);
    expect(existsSync(ws.dir)).toBe(true);
  });

  it("records separate markers per attempt and generation", async () => {
    const dir = dataDir();
    const one = unwrap(await acquire(dir, { attempt: 1 }));
    const two = unwrap(await acquire(dir, { attempt: 2, generation: 1 }));
    const first = unwrap(
      await finalizeScratch(one, {
        outcome: "failed",
        process: { attempt: 1, generation: 1, stopped: true, reason: "killed" },
      }),
    );
    const second = unwrap(await finalizeScratch(two, { outcome: "success", process: stopped(2) }));
    expect(first.markerFile).not.toBe(second.markerFile);
    expect(existsSync(first.markerFile)).toBe(true);
    expect(existsSync(second.markerFile)).toBe(true);
    expect(existsSync(one.dir)).toBe(true);
  });

  it("rejects cloned or forged workspace objects", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    const clone = { ...ws } as ScratchWorkspace;
    expect(
      expectError(await finalizeScratch(clone, { outcome: "success", process: stopped() })).code,
    ).toBe("E_FORBIDDEN_PATH");
    expect(expectError(await removeScratch(clone)).code).toBe("E_FORBIDDEN_PATH");

    const victim = tempDir("devchestra-victim-");
    writeFileSync(join(victim, "keep.txt"), "keep");
    const forged = { ...ws, dir: victim } as ScratchWorkspace;
    expect(expectError(await removeScratch(forged)).code).toBe("E_FORBIDDEN_PATH");
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });
});

describe("requireExisting recovery", () => {
  it("reuses a valid existing workspace without creating dirs or markers", async () => {
    const dir = dataDir();
    const first = unwrap(await acquire(dir));
    const before = readdirSync(first.dir).sort();
    const again = unwrap(await acquire(dir, { requireExisting: true }));
    expect(again.dir).toBe(first.dir);
    expect(again.reused).toBe(true);
    expect(existsSync(again.markerFile)).toBe(false);
    expect(readdirSync(first.dir).sort()).toEqual(before);
  });

  it("rejects a missing workspace without recreating it", async () => {
    const dir = dataDir();
    const first = unwrap(await acquire(dir));
    rmSync(first.dir, { recursive: true, force: true });
    expect(expectError(await acquire(dir, { requireExisting: true })).code).toBe("E_WORKSPACE");
    expect(existsSync(first.dir)).toBe(false);
    expect(existsSync(first.markerFile)).toBe(false);
  });

  it("rejects missing data, project and run paths without creating them", async () => {
    const dir = dataDir();
    expect(expectError(await acquire(dir, { requireExisting: true })).code).toBe("E_WORKSPACE");
    expect(existsSync(dir)).toBe(false);
    mkdirSync(dir, { recursive: true });
    expect(expectError(await acquire(dir, { requireExisting: true })).code).toBe("E_WORKSPACE");
    expect(existsSync(join(dir, "projects"))).toBe(false);
  });

  it("rejects a symlinked existing workspace without touching outside", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    const outside = tempDir("devchestra-outside-");
    renameSync(ws.dir, `${ws.dir}.real`);
    symlinkSync(outside, ws.dir);
    expect(expectError(await acquire(dir, { requireExisting: true })).code).toBe(
      "E_FORBIDDEN_PATH",
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("scratch cleanup", () => {
  it("removes only the owned workspace, idempotently, and keeps siblings", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    writeFileSync(join(ws.dir, "owned.txt"), "owned");
    const runDir = dirname(ws.dir);
    writeFileSync(join(runDir, "sibling.txt"), "keep");

    const removed = unwrap(await removeScratch(ws));
    expect(removed.removed).toBe(true);
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(join(runDir, "sibling.txt"))).toBe(true);

    const absent = unwrap(await removeScratch(ws));
    expect(absent.alreadyAbsent).toBe(true);

    const again = unwrap(await acquire(dir));
    expect(again.dir).toBe(ws.dir);
    expect(again.reused).toBe(false);
  });

  it("rejects a symlink swapped workspace on acquire, finalize and remove", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    const outside = tempDir("devchestra-outside-");
    writeFileSync(join(outside, "secret.txt"), "keep");
    renameSync(ws.dir, `${ws.dir}.real`);
    symlinkSync(outside, ws.dir);

    expect(expectError(await acquire(dir)).code).toBe("E_FORBIDDEN_PATH");
    expect(
      expectError(await finalizeScratch(ws, { outcome: "success", process: stopped() })).code,
    ).toBe("E_FORBIDDEN_PATH");
    expect(expectError(await removeScratch(ws)).code).toBe("E_FORBIDDEN_PATH");
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
  });

  it("rejects a symlinked owned ancestor before creating anything under it", async () => {
    const outside = tempDir("devchestra-outside-");
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "projects"));
    expect(expectError(await acquire(dir)).code).toBe("E_FORBIDDEN_PATH");
    expect(existsSync(join(outside, "proj-1"))).toBe(false);
  });

  it("revalidates the data directory before finalize and remove", async () => {
    const dir = dataDir();
    const ws = unwrap(await acquire(dir));
    const outside = tempDir("devchestra-outside-");
    renameSync(dir, `${dir}.real`);
    symlinkSync(outside, dir);

    expect(
      expectError(await finalizeScratch(ws, { outcome: "success", process: stopped() })).code,
    ).toBe("E_CONFLICT");
    expect(expectError(await removeScratch(ws)).code).toBe("E_CONFLICT");
    expect(readdirSync(outside)).toEqual([]);
  });
});
