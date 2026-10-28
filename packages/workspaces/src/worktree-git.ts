import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DevChestraError, isRecord } from "@devchestra/core";

export const BINDING_NAME = "project-worktree.json";
export const INTENT_NAME = "project-worktree.intent.json";
export const LOCK_NAME = "project-worktree.lock";
export const WORKTREE_NAME = "worktree";
export const SHA_RE = /^[0-9a-f]{40,64}$/;

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_ORPHAN_MS = 5_000;
const LOCK_POLL_MS = 25;

export interface WorktreeRecord {
  version: 1;
  kind: "devchestra.worktree" | "devchestra.worktree.intent";
  projectRoot: string;
  projectRootId: string;
  commonDir: string;
  commonDirId: string;
  base: string;
  dir: string;
}

export interface Binding extends WorktreeRecord {
  kind: "devchestra.worktree";
}
export interface WorktreeIntent extends WorktreeRecord {
  kind: "devchestra.worktree.intent";
}
export interface ProjectRepo {
  root: string;
  rootId: string;
  commonDir: string;
  commonId: string;
}
export interface LockHandle {
  file: string;
  token: string;
}

export const missing = (e: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | undefined)?.code ?? "");
export const exists = (e: unknown): boolean =>
  (e as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
export const werr = (message: string, details?: unknown): DevChestraError =>
  new DevChestraError("E_WORKSPACE", message, details === undefined ? {} : { details });
export const ferr = (message: string, details?: unknown): DevChestraError =>
  new DevChestraError("E_FORBIDDEN_PATH", message, details === undefined ? {} : { details });
export const conflict = (message: string, details?: unknown): DevChestraError =>
  new DevChestraError("E_CONFLICT", message, details === undefined ? {} : { details });
export function toDevChestraError(e: unknown): DevChestraError {
  if (e instanceof DevChestraError) return e;
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  return werr(`Worktree operation failed (${code})`, { step: "io", code });
}
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function tail(value: string): string {
  const text = value.trim();
  return text.length > 400 ? text.slice(-400) : text;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

export function gitRaw(
  cwd: string,
  args: string[],
  step: string,
  timeout = GIT_TIMEOUT_MS,
): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-C",
      cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (result.error) {
    throw werr("Git is not available for this workspace", {
      step: "not_git",
      code: (result.error as NodeJS.ErrnoException).code,
      message: result.error.message,
    });
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw werr("Git command was terminated", { step: "git_timeout", signal: result.signal });
  }
  if (result.status !== 0) {
    throw werr("Git command failed", {
      step,
      status: result.status,
      stderr: tail(result.stderr ?? ""),
    });
  }
  return result.stdout ?? "";
}

export const gitText = (cwd: string, args: string[], step: string, timeout?: number): string =>
  gitRaw(cwd, args, step, timeout).trim();

function idOf(target: string): string {
  const stat = fs.statSync(target, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

/** Stable directory identity (device:inode) for crash/resume tamper checks. */
export function dirIdentity(target: string): string {
  return idOf(target);
}

export function projectRepo(root: string): ProjectRepo {
  const toplevel = fs.realpathSync.native(
    gitText(root, ["rev-parse", "--show-toplevel"], "not_git"),
  );
  if (toplevel !== root) {
    throw werr("projectRoot must be the Git repository toplevel", {
      step: "not_toplevel",
      projectRoot: root,
      toplevel,
    });
  }
  const relative = gitText(root, ["rev-parse", "--git-common-dir"], "not_git");
  const commonDir = fs.realpathSync.native(path.resolve(root, relative));
  if (!fs.statSync(commonDir).isDirectory()) {
    throw werr("Git common directory is not a directory", { step: "not_git" });
  }
  return { root, rootId: idOf(root), commonDir, commonId: idOf(commonDir) };
}

export function projectHead(root: string): string {
  const head = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"], "not_git");
  if (!SHA_RE.test(head)) throw werr("Project HEAD is not a commit", { step: "not_git", head });
  return head;
}

function isAbsolute(p: unknown): p is string {
  return typeof p === "string" && p.length <= 4096 && !p.includes("\0") && path.isAbsolute(p);
}

function parseRecord(value: unknown, kind: WorktreeRecord["kind"]): WorktreeRecord {
  const invalid = (): DevChestraError =>
    werr("Worktree record is invalid", {
      step: kind === "devchestra.worktree" ? "binding_invalid" : "intent_invalid",
    });
  if (!isRecord(value)) throw invalid();
  const record = value;
  if (
    record.version !== RECORD_VERSION ||
    record.kind !== kind ||
    !isAbsolute(record.projectRoot) ||
    typeof record.projectRootId !== "string" ||
    record.projectRootId.length === 0 ||
    !isAbsolute(record.commonDir) ||
    typeof record.commonDirId !== "string" ||
    record.commonDirId.length === 0 ||
    typeof record.base !== "string" ||
    !SHA_RE.test(record.base) ||
    !isAbsolute(record.dir)
  ) {
    throw invalid();
  }
  return record as unknown as WorktreeRecord;
}

function readRecord(file: string, kind: WorktreeRecord["kind"]): WorktreeRecord | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  if (stat.isSymbolicLink()) throw ferr("Worktree record is a symlink", { path: file });
  if (!stat.isFile())
    throw werr("Worktree record is not a regular file", { step: "record_invalid" });
  if (stat.size > MAX_RECORD_BYTES)
    throw werr("Worktree record is too large", { step: "record_invalid" });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES) {
      throw werr("Worktree record changed while reading", { step: "record_invalid" });
    }
    const text = fs.readFileSync(fd, "utf8");
    try {
      return parseRecord(JSON.parse(text) as unknown, kind);
    } catch (e) {
      if (e instanceof DevChestraError) throw e;
      throw werr("Worktree record is not valid JSON", { step: "record_invalid" });
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function readBinding(file: string): Binding | null {
  return readRecord(file, "devchestra.worktree") as Binding | null;
}
export function readIntent(file: string): WorktreeIntent | null {
  return readRecord(file, "devchestra.worktree.intent") as WorktreeIntent | null;
}

export function sameRecord(a: WorktreeRecord, b: WorktreeRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function writeExclusive(file: string, record: WorktreeRecord): boolean {
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
    return true;
  } catch (e) {
    if (exists(e)) return false;
    throw e;
  }
}

export function removeRecord(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (!missing(e)) throw e;
  }
}

export function assertRecordIdentity(record: WorktreeRecord, repo: ProjectRepo, dir: string): void {
  if (record.projectRoot !== repo.root || record.projectRootId !== repo.rootId) {
    throw conflict("Worktree project identity changed", {
      step: "project_identity",
      expected: repo.root,
      actual: record.projectRoot,
    });
  }
  if (record.commonDir !== repo.commonDir || record.commonDirId !== repo.commonId) {
    throw conflict("Worktree repository identity changed", {
      step: "repo_identity",
      expected: repo.commonDir,
      actual: record.commonDir,
    });
  }
  if (record.dir !== dir) {
    throw conflict("Worktree directory identity changed", { step: "worktree_identity" });
  }
}

export function ownedDir(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (e) {
    if (missing(e)) throw werr(`${label} is missing`, { step: "workspace_missing", path: dir });
    throw e;
  }
  if (stat.isSymbolicLink()) throw ferr(`${label} is a symlink`, { path: dir });
  if (!stat.isDirectory()) throw werr(`${label} is not a directory`, { path: dir });
  if (fs.realpathSync.native(dir) !== dir) {
    throw ferr(`${label} traverses a symlink`, { path: dir });
  }
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
}

export function worktreeList(root: string): WorktreeEntry[] {
  const tokens = gitRaw(root, ["worktree", "list", "--porcelain", "-z"], "worktree_list").split(
    "\0",
  );
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const token of tokens) {
    if (token === "") {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    const split = token.indexOf(" ");
    const key = split < 0 ? token : token.slice(0, split);
    const value = split < 0 ? "" : token.slice(split + 1);
    if (key === "worktree") {
      if (current !== null) entries.push(current);
      current = { path: value, head: null, branch: null, detached: false };
    } else if (current !== null && key === "HEAD") {
      current.head = value.toLowerCase();
    } else if (current !== null && key === "branch") {
      current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (current !== null && key === "detached") {
      current.detached = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

export function inspectWorktree(dir: string, commonDir: string, requireDetached = true): string {
  const toplevel = fs.realpathSync.native(
    gitText(dir, ["rev-parse", "--show-toplevel"], "worktree_identity"),
  );
  if (toplevel !== dir) {
    throw conflict("Worktree toplevel does not match its owned path", {
      step: "worktree_identity",
    });
  }
  const actualCommon = fs.realpathSync.native(
    path.resolve(dir, gitText(dir, ["rev-parse", "--git-common-dir"], "worktree_identity")),
  );
  if (actualCommon !== commonDir) {
    throw conflict("Worktree belongs to another repository", { step: "repo_identity" });
  }
  const head = gitText(dir, ["rev-parse", "--verify", "HEAD^{commit}"], "worktree_identity");
  if (!SHA_RE.test(head))
    throw conflict("Worktree HEAD is not a commit", { step: "worktree_identity" });
  const entry = worktreeList(dir).find((candidate) => {
    try {
      return fs.realpathSync.native(candidate.path) === dir;
    } catch {
      return false;
    }
  });
  if (entry === undefined) {
    throw conflict("Worktree is not registered with its repository", {
      step: "worktree_identity",
    });
  }
  if (
    requireDetached &&
    (!entry.detached || entry.head === null || entry.head !== head.toLowerCase())
  ) {
    throw conflict("Worktree is not registered as a detached worktree", {
      step: "worktree_identity",
    });
  }
  return head;
}

export function validateWorktree(binding: Binding, pinHead = true): void {
  if (readLstat(binding.dir) === null) {
    throw werr("Worktree is missing", { step: "worktree_missing", path: binding.dir });
  }
  ownedDir(binding.dir, "Worktree");
  const head = inspectWorktree(binding.dir, binding.commonDir, pinHead);
  if (pinHead && head !== binding.base) {
    throw conflict("Worktree HEAD does not match the pinned base", {
      step: "worktree_identity",
      expected: binding.base,
      actual: head,
    });
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

function readOwner(file: string): LockOwner | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return null;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(value)) return null;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null;
    if (typeof value.token !== "string" || value.token.length === 0) return null;
    return { pid: value.pid as number, token: value.token };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function fileAge(file: string): number {
  try {
    return Date.now() - fs.lstatSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function writeOwner(file: string, owner: LockOwner): void {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function tryGuard(guard: string): boolean {
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
    return true;
  } catch (e) {
    if (!exists(e)) throw e;
    if (fileAge(guard) > LOCK_ORPHAN_MS) {
      try {
        fs.rmdirSync(guard);
      } catch {
        return false;
      }
      try {
        fs.mkdirSync(guard, { mode: 0o700 });
        return true;
      } catch (again) {
        if (!exists(again)) throw again;
      }
    }
    return false;
  }
}

export async function acquireLock(
  runDir: string,
  signal: AbortSignal | undefined,
): Promise<LockHandle> {
  const file = path.join(runDir, LOCK_NAME);
  const guard = `${file}.reclaim`;
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    if (signal?.aborted === true) {
      throw new DevChestraError("E_CANCELLED", "Worktree acquisition cancelled");
    }
    try {
      writeOwner(file, { pid: process.pid, token });
      return { file, token };
    } catch (e) {
      if (!exists(e)) throw e;
    }
    const owner = readOwner(file);
    const stale = owner === null ? fileAge(file) > LOCK_ORPHAN_MS : !pidAlive(owner.pid);
    if (stale && tryGuard(guard)) {
      try {
        const again = readOwner(file);
        const still = again === null ? fileAge(file) > LOCK_ORPHAN_MS : !pidAlive(again.pid);
        if (still) {
          try {
            fs.unlinkSync(file);
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
      } finally {
        try {
          fs.rmdirSync(guard);
        } catch {
          // A later waiter reclaims the guard after it goes stale.
        }
      }
      continue;
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) {
      throw new DevChestraError("E_LOCKED", "Timed out waiting for the shared worktree lock", {
        details: { step: "lock_timeout", path: file },
      });
    }
    await sleep(LOCK_POLL_MS);
  }
}

export function releaseLock(lock: LockHandle): void {
  const owner = readOwner(lock.file);
  if (owner === null || owner.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.file);
  } catch {
    // Best effort: a stale lock is reclaimed by the next acquisition.
  }
}

export const readLstat = (target: string): fs.Stats | null => {
  try {
    return fs.lstatSync(target);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
};
