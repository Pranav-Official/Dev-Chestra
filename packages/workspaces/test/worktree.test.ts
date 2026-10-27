import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Path } from "@relay/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AcquireScratchRequest,
  acquireScratch,
  type FinalizeScratchRequest,
  finalizeScratch,
  releaseScratch,
  type ScratchWorkspace,
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
  const root = join(tempDir("relay-wt-repo-"), "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "relay@example.invalid");
  git(root, "config", "user.name", "Relay Test");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "file.txt"), "sub\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function dataDir(): string {
  return join(tempDir("relay-wt-data-"), "data");
}

function acquire(root: string, data: string, overrides: Partial<AcquireScratchRequest> = {}) {
  return acquireScratch({
    dataDir: data,
    projectId: "proj-1",
    runId: "run-1",
    path: "agent" as Path,
    attempt: 1,
    generation: 1,
    mode: "worktree",
    projectRoot: root,
    ...overrides,
  });
}

function stopped(attempt = 1, generation = 1): FinalizeScratchRequest["process"] {
  return { attempt, generation, stopped: true, reason: "exited", exitCode: 0 };
}

function runDir(ws: ScratchWorkspace): string {
  return join(ws.dataDir, "projects", ws.projectId, "runs", ws.runId);
}

const bindingName = "project-worktree.json";
const intentName = "project-worktree.intent.json";

function readBindingFile(ws: ScratchWorkspace): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir(ws), bindingName), "utf8")) as Record<string, unknown>;
}

function writeIntent(ws: ScratchWorkspace, binding: Record<string, unknown>): void {
  writeFileSync(
    join(runDir(ws), intentName),
    `${JSON.stringify({ ...binding, kind: "relay.worktree.intent" })}\n`,
    { mode: 0o600 },
  );
}

function removeBinding(ws: ScratchWorkspace): void {
  rmSync(join(runDir(ws), bindingName));
}

describe("worktree isolation and sharing", () => {
  it("creates one detached shared worktree from committed files and leaves the dirty project untouched", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    writeFileSync(join(root, "tracked.txt"), "modified\n");

    const first = unwrap(await acquire(root, data));
    const second = unwrap(await acquire(root, data, { path: "shell" as Path, attempt: 2 }));

    expect(first.mode).toBe("worktree");
    expect(first.dir).toBe(second.dir);
    expect(first.dir).toBe(join(first.dataDir, "projects", "proj-1", "runs", "run-1", "worktree"));
    expect(first.baseSha).toBe(base);
    expect(second.baseSha).toBe(base);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(readFileSync(join(first.dir, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(first.dir, "dirty.txt"))).toBe(false);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(readFileSync(join(root, "dirty.txt"), "utf8")).toBe("dirty\n");
    expect(() => git(first.dir, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(git(root, "worktree", "list", "--porcelain")).toContain("detached");

    releaseScratch(first);
    releaseScratch(first);
    releaseScratch(second);
    expect(existsSync(first.dir)).toBe(true);
  });

  it("serializes concurrent acquisitions to one worktree", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((name, index) =>
        acquire(root, data, { path: name as Path, attempt: index + 1 }),
      ),
    );
    const workspaces = results.map(unwrap);
    expect(new Set(workspaces.map((workspace) => workspace.dir)).size).toBe(1);
    expect(workspaces.filter((workspace) => !workspace.reused)).toHaveLength(1);
    expect(workspaces.every((workspace) => workspace.baseSha === base)).toBe(true);
  });
});

describe("worktree continuity", () => {
  it("preserves directory, identity and pinned base when the project HEAD moves", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    writeFileSync(join(first.dir, "work.txt"), "kept");

    writeFileSync(join(root, "later.txt"), "later\n");
    git(root, "add", "later.txt");
    git(root, "commit", "-q", "-m", "later");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(base);

    const resumed = unwrap(await acquire(root, data, { attempt: 2, generation: 2 }));
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.reused).toBe(true);
    expect(resumed.baseSha).toBe(base);
    expect(readFileSync(join(resumed.dir, "work.txt"), "utf8")).toBe("kept");
    expect(git(resumed.dir, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(resumed.dir, "later.txt"))).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).not.toBe(base);
  });

  it("relinks a creation interrupted before binding from the durable intent", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const binding = readBindingFile(first);
    removeBinding(first);
    writeIntent(first, binding);

    const resumed = unwrap(await acquire(root, data, { attempt: 2 }));
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.reused).toBe(true);
    expect(resumed.baseSha).toBe(base);
    expect(git(resumed.dir, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(runDir(first), bindingName))).toBe(true);
    expect(existsSync(join(runDir(first), intentName))).toBe(false);
  });

  it("recreates only a never-completed intent at its pinned base", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const binding = readBindingFile(first);
    removeBinding(first);
    writeIntent(first, binding);
    git(root, "worktree", "remove", "--force", first.dir);
    expect(existsSync(first.dir)).toBe(false);

    const resumed = unwrap(await acquire(root, data, { attempt: 2 }));
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.reused).toBe(false);
    expect(resumed.baseSha).toBe(base);
    expect(git(resumed.dir, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(runDir(first), bindingName))).toBe(true);
  });
});

describe("worktree recovery is fail-closed", () => {
  it("reuses a valid binding under requireExisting without rewriting it", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const before = readFileSync(join(runDir(first), bindingName), "utf8");
    const again = unwrap(await acquire(root, data, { requireExisting: true }));
    expect(again.dir).toBe(first.dir);
    expect(again.reused).toBe(true);
    expect(again.baseSha).toBe(first.baseSha);
    expect(readFileSync(join(runDir(first), bindingName), "utf8")).toBe(before);
  });

  it("rejects a missing worktree or binding without recreating or adopting", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    rmSync(first.dir, { recursive: true, force: true });

    expect(expectError(await acquire(root, data, { requireExisting: true })).details).toMatchObject(
      {
        step: "worktree_missing",
      },
    );
    expect(expectError(await acquire(root, data)).details).toMatchObject({
      step: "worktree_missing",
    });
    expect(existsSync(first.dir)).toBe(false);

    const otherData = dataDir();
    const second = unwrap(await acquire(root, otherData));
    removeBinding(second);
    expect(expectError(await acquire(root, otherData)).details).toMatchObject({
      step: "binding_missing",
    });
    expect(existsSync(join(runDir(second), bindingName))).toBe(false);
  });

  it("does not adopt an existing worktree directory without a binding or intent", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    removeBinding(first);
    git(root, "worktree", "remove", "--force", first.dir);
    mkdirSync(first.dir);
    writeFileSync(join(first.dir, "substituted.txt"), "substitute\n");

    const error = expectError(await acquire(root, data));
    expect(error.code).toBe("E_WORKSPACE");
    expect(error.details).toMatchObject({ step: "binding_missing" });
    expect(readFileSync(join(first.dir, "substituted.txt"), "utf8")).toBe("substitute\n");
    expect(existsSync(join(runDir(first), bindingName))).toBe(false);
    expect(existsSync(join(runDir(first), intentName))).toBe(false);
  });

  it("does not recreate a lost per-node marker directory under requireExisting", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const markerDir = dirname(first.markerFile);
    rmSync(markerDir, { recursive: true, force: true });

    const error = expectError(await acquire(root, data, { requireExisting: true }));
    expect(error.code).toBe("E_WORKSPACE");
    expect(existsSync(markerDir)).toBe(false);
    expect(existsSync(first.dir)).toBe(true);
  });

  it("rejects requireExisting for a downstream node that never acquired", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    unwrap(await acquire(root, data));
    const error = expectError(
      await acquire(root, data, { path: "downstream" as Path, requireExisting: true }),
    );
    expect(error.code).toBe("E_WORKSPACE");
  });

  it("refuses an intent that does not match the current project identity", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const binding = readBindingFile(first);
    removeBinding(first);
    writeIntent(first, { ...binding, projectRootId: "1:1" });
    const before = readFileSync(join(runDir(first), intentName), "utf8");

    const error = expectError(await acquire(root, data));
    expect(error.code).toBe("E_CONFLICT");
    expect(error.details).toMatchObject({ step: "project_identity" });
    expect(existsSync(join(runDir(first), bindingName))).toBe(false);
    expect(readFileSync(join(runDir(first), intentName), "utf8")).toBe(before);
  });

  it("rejects an intent whose worktree HEAD was substituted", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const first = unwrap(await acquire(root, data));
    const binding = readBindingFile(first);
    removeBinding(first);
    writeIntent(first, binding);
    writeFileSync(join(root, "other.txt"), "other\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-q", "-m", "other");
    git(first.dir, "checkout", "--detach", git(root, "rev-parse", "HEAD"));

    const error = expectError(await acquire(root, data));
    expect(error.code).toBe("E_CONFLICT");
    expect(error.details).toMatchObject({ step: "worktree_identity" });
    expect(existsSync(join(runDir(first), bindingName))).toBe(false);
  });
});

describe("worktree finalization", () => {
  it("finalizes each node independently against the shared worktree", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    const shell = unwrap(await acquire(root, data, { path: "shell" as Path }));
    expect(agent.dir).toBe(shell.dir);

    const first = unwrap(await finalizeScratch(agent, { outcome: "success", process: stopped() }));
    const second = unwrap(
      await finalizeScratch(shell, {
        outcome: "failed",
        process: { attempt: 1, generation: 1, stopped: true, reason: "killed" },
      }),
    );
    expect(first.dir).toBe(agent.dir);
    expect(second.dir).toBe(agent.dir);
    expect(first.markerFile).not.toBe(second.markerFile);
    expect(existsSync(first.markerFile)).toBe(true);
    expect(existsSync(second.markerFile)).toBe(true);
    expect(existsSync(join(agent.dir, first.markerFile.split("/").pop() as string))).toBe(false);

    const again = unwrap(await finalizeScratch(agent, { outcome: "success", process: stopped() }));
    expect(again.alreadyFinalized).toBe(true);
    expect(
      expectError(await finalizeScratch(agent, { outcome: "failed", process: stopped() })).code,
    ).toBe("E_CONFLICT");
    expect(existsSync(agent.dir)).toBe(true);
  });

  it("requires a matching stopped process before writing a marker", async () => {
    const { root } = makeRepo();
    const agent = unwrap(await acquire(root, dataDir()));
    const running = await finalizeScratch(agent, {
      outcome: "success",
      process: { ...stopped(), stopped: false as unknown as true },
    });
    expect(expectError(running).code).toBe("E_WORKSPACE");
    expect(existsSync(agent.markerFile)).toBe(false);
    const mismatch = await finalizeScratch(agent, { outcome: "success", process: stopped(2, 1) });
    expect(expectError(mismatch).code).toBe("E_CONFLICT");
  });

  it("refuses cloned, forged or tampered worktree capabilities", async () => {
    const { root } = makeRepo();
    const agent = unwrap(await acquire(root, dataDir()));
    const clone = { ...agent } as ScratchWorkspace;
    expect(
      expectError(await finalizeScratch(clone, { outcome: "success", process: stopped() })).code,
    ).toBe("E_FORBIDDEN_PATH");

    const bindingFile = join(runDir(agent), bindingName);
    const binding = readBindingFile(agent);
    writeFileSync(bindingFile, `${JSON.stringify({ ...binding, base: "0".repeat(40) })}\n`, {
      mode: 0o600,
    });
    const tampered = expectError(
      await finalizeScratch(agent, { outcome: "success", process: stopped() }),
    );
    expect(tampered.code).toBe("E_CONFLICT");
    expect(existsSync(agent.markerFile)).toBe(false);
  });

  it("rejects a worktree HEAD moved away from the pinned base before finalize", async () => {
    const { root } = makeRepo();
    const agent = unwrap(await acquire(root, dataDir()));
    writeFileSync(join(root, "next.txt"), "next\n");
    git(root, "add", "next.txt");
    git(root, "commit", "-q", "-m", "next");
    git(agent.dir, "checkout", "--detach", git(root, "rev-parse", "HEAD"));

    const error = expectError(
      await finalizeScratch(agent, { outcome: "success", process: stopped() }),
    );
    expect(error.code).toBe("E_CONFLICT");
    expect(existsSync(agent.markerFile)).toBe(false);
  });
});

describe("worktree tamper and errors", () => {
  it("rejects project, repository and directory identity changes", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    const bindingFile = join(runDir(agent), bindingName);
    const original = readBindingFile(agent);

    writeFileSync(bindingFile, `${JSON.stringify({ ...original, projectRootId: "1:1" })}\n`, {
      mode: 0o600,
    });
    expect(expectError(await acquire(root, data)).code).toBe("E_CONFLICT");

    writeFileSync(bindingFile, `${JSON.stringify({ ...original, commonDirId: "2:2" })}\n`, {
      mode: 0o600,
    });
    expect(expectError(await acquire(root, data)).code).toBe("E_CONFLICT");

    writeFileSync(
      bindingFile,
      `${JSON.stringify({ ...original, dir: join(data, "elsewhere") })}\n`,
      {
        mode: 0o600,
      },
    );
    expect(expectError(await acquire(root, data)).code).toBe("E_CONFLICT");
  });

  it("rejects a replaced repository at the same path", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    expect(agent.baseSha).toBe(base);

    const previous = `${root}.previous`;
    renameSync(root, previous);
    mkdirSync(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "relay@example.invalid");
    git(root, "config", "user.name", "Relay Test");
    writeFileSync(join(root, "tracked.txt"), "other\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "other");

    const error = expectError(await acquire(root, data));
    expect(error.code).toBe("E_CONFLICT");
    expect(error.details).toMatchObject({ step: "project_identity" });
  });

  it("rejects symlinked binding, worktree and lock paths", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    const outside = tempDir("relay-wt-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");

    const bindingFile = join(runDir(agent), bindingName);
    renameSync(bindingFile, `${bindingFile}.real`);
    symlinkSync(`${bindingFile}.real`, bindingFile);
    expect(expectError(await acquire(root, data)).code).toBe("E_FORBIDDEN_PATH");
    rmSync(bindingFile);

    renameSync(agent.dir, `${agent.dir}.real`);
    symlinkSync(outside, agent.dir);
    expect(expectError(await acquire(root, data)).code).toBe("E_FORBIDDEN_PATH");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("rejects unsupported modes and options, non-git and nested projects", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const plain = tempDir("relay-wt-plain-");
    const nested = join(root, "sub");

    expect(expectError(await acquire(root, data, { mode: "project" })).details).toMatchObject({
      step: "unsupported_mode",
    });
    for (const option of ["base", "setup", "from"] as const) {
      const error = expectError(await acquire(root, data, { [option]: "x" }));
      expect(error.details).toMatchObject({ step: "unsupported_option" });
    }
    expect(expectError(await acquire(plain, data)).details).toMatchObject({ step: "not_git" });
    expect(expectError(await acquire(nested, data)).details).toMatchObject({
      step: "not_toplevel",
    });
    expect(expectError(await acquire(root, data, { projectRoot: "relative" })).code).toBe(
      "E_VALIDATION",
    );
  });

  it("rejects an unborn repository and cancellation before creation", async () => {
    const unborn = tempDir("relay-wt-unborn-");
    git(unborn, "init", "-q");
    const data = dataDir();
    expect(expectError(await acquire(unborn, data)).code).toBe("E_WORKSPACE");

    const controller = new AbortController();
    controller.abort();
    expect(expectError(await acquire(unborn, dataDir(), { signal: controller.signal })).code).toBe(
      "E_CANCELLED",
    );
  });

  it("ignores inherited GIT_* redirection", async () => {
    const { root, base } = makeRepo();
    const data = dataDir();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tempDir("relay-wt-bogus-"), "not-a-repo");
    try {
      const agent = unwrap(await acquire(root, data));
      expect(agent.baseSha).toBe(base);
      expect(git(agent.dir, "rev-parse", "HEAD")).toBe(base);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("does not reclaim a stale lock while another reclaimer holds the guard", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    const run = runDir(agent);
    const lock = join(run, "project-worktree.lock");
    const guard = `${lock}.reclaim`;
    writeFileSync(lock, `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`, { mode: 0o600 });
    mkdirSync(guard, { mode: 0o700 });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = expectError(await acquire(root, data, { signal: controller.signal }));
    expect(error.code).toBe("E_CANCELLED");
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ token: "dead" });

    rmSync(guard, { recursive: true, force: true });
    const resumed = unwrap(await acquire(root, data));
    expect(resumed.dir).toBe(agent.dir);
    expect(existsSync(lock)).toBe(false);
  });

  it("reclaims a dead lock owner but never deletes a live owner lock", async () => {
    const { root } = makeRepo();
    const data = dataDir();
    const agent = unwrap(await acquire(root, data));
    const lock = join(runDir(agent), "project-worktree.lock");

    writeFileSync(lock, `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`, { mode: 0o600 });
    const resumed = unwrap(await acquire(root, data));
    expect(resumed.dir).toBe(agent.dir);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, token: "live" })}\n`, {
      mode: 0o600,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = expectError(await acquire(root, data, { signal: controller.signal }));
    expect(error.code).toBe("E_CANCELLED");
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ token: "live" });
  });
});
