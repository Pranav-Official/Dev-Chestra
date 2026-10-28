import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunWorkspaceRepo {
  /** Main repository root (the registered project). */
  root: string;
  /** Commit every workspace starts from. */
  base: string;
  /** Existing linked worktree of `root`. */
  existingWorktree: string;
  existingBranch: string;
  /** Committed-then-dirty tracked file content in `root`. */
  dirty: string;
  /** Untracked file content visible only in `root`. */
  untracked: string;
  /** Temporary HOME/GIT_CONFIG_GLOBAL used by git calls. */
  home: string;
}

export interface TempRoot {
  dir: string;
  cleanup: () => void;
}

const cleanups: (() => void)[] = [];

export function tempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return {
    dir,
    cleanup: () => {
      const index = cleanups.indexOf(cleanup);
      if (index !== -1) cleanups.splice(index, 1);
      cleanup();
    },
  };
}

/** Best-effort removal of every temp root still registered by this module. */
export function cleanupTempRoots(): void {
  const failures: unknown[] = [];
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "temp root cleanup failed");
}

export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  const gitConfig = join(home, "gitconfig");
  writeFileSync(gitConfig, "");
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function gitMaybe(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
}

/** Parses `git worktree list --porcelain` without trusting locale output. */
export function worktreeList(cwd: string, env: NodeJS.ProcessEnv): WorktreeEntry[] {
  const output = git(cwd, ["worktree", "list", "--porcelain"], env);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of output.split("\n")) {
    if (line === "") {
      if (current.path !== undefined && current.head !== undefined) {
        entries.push({
          path: current.path,
          head: current.head,
          branch: current.branch ?? null,
          detached: current.detached ?? true,
        });
      }
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    } else if (line === "detached") current.detached = true;
  }
  if (current.path !== undefined && current.head !== undefined) {
    entries.push({
      path: current.path,
      head: current.head,
      branch: current.branch ?? null,
      detached: current.detached ?? true,
    });
  }
  return entries;
}

export interface MakeRepoOptions {
  /** Add a linked branch worktree at `<root>/../existing-worktree`. */
  existingWorktree?: boolean;
}

/**
 * A real temp repository with committed base, dirty tracked edit, untracked and
 * ignored files, plus an optional existing linked worktree.
 */
export function makeRunWorkspaceRepo(
  prefix: string,
  options: MakeRepoOptions = {},
): RunWorkspaceRepo {
  const root = tempRoot(prefix);
  const home = tempRoot(`${prefix}home-`).dir;
  const env = isolatedGitEnv(home);
  git(root.dir, ["init", "-q"], env);
  git(root.dir, ["config", "user.email", "run-workspace-qa@example.invalid"], env);
  git(root.dir, ["config", "user.name", "Run Workspace QA"], env);
  writeFileSync(join(root.dir, "tracked.txt"), "base\n");
  writeFileSync(join(root.dir, "dirty.txt"), "committed\n");
  writeFileSync(join(root.dir, ".gitignore"), "ignored/\n");
  mkdirSync(join(root.dir, "ignored"));
  writeFileSync(join(root.dir, "ignored", "cache.txt"), "ignored\n");
  git(root.dir, ["add", "."], env);
  git(root.dir, ["commit", "-qm", "base"], env);
  const base = git(root.dir, ["rev-parse", "HEAD"], env);
  const dirty = "dirty-local\n";
  const untracked = "untracked-local\n";
  writeFileSync(join(root.dir, "dirty.txt"), dirty);
  writeFileSync(join(root.dir, "untracked.txt"), untracked);

  let existingWorktree = "";
  let existingBranch = "";
  if (options.existingWorktree !== false) {
    existingBranch = "qa-existing";
    const worktreeRoot = tempRoot(`${prefix}existing-`);
    rmSync(worktreeRoot.dir, { recursive: true, force: true });
    existingWorktree = worktreeRoot.dir;
    git(root.dir, ["worktree", "add", "-q", "-b", existingBranch, existingWorktree, base], env);
  }

  return { root: root.dir, base, existingWorktree, existingBranch, dirty, untracked, home };
}

export function readRepoFile(repo: RunWorkspaceRepo, name: string): string {
  return readFileSync(join(repo.root, name), "utf8");
}

export interface RunOutputLike {
  type?: string;
  path?: string;
  payload?: { cwd?: string };
}

export function cwdsFromEvents(stdout: string): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: RunOutputLike;
    try {
      event = JSON.parse(line) as RunOutputLike;
    } catch {
      continue;
    }
    if (event.type === "node.process.spawned" && event.path && event.payload?.cwd) {
      cwds.set(event.path, event.payload.cwd);
    }
  }
  return cwds;
}

export function runNode(
  entry: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(entry, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    env: options.env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function execNode(
  entry: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): string {
  return execFileSync(entry, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: options.env,
  });
}
