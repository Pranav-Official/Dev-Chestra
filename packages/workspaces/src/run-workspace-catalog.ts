import * as fs from "node:fs";
import * as path from "node:path";
import {
  DevChestraError,
  err,
  isRunWorkspaceSelection,
  ok,
  type Result,
  type RunWorkspaceSelection,
} from "@devchestra/core";
import type { ProjectWorkspaces, ValidatedRunWorkspace, WorktreeInfo } from "./types.js";
import {
  inspectWorktree,
  missing,
  type ProjectRepo,
  projectHead,
  projectRepo,
  toDevChestraError,
  worktreeList,
} from "./worktree-git.js";

const validation = (message: string, details?: unknown): DevChestraError =>
  new DevChestraError("E_VALIDATION", message, details === undefined ? {} : { details });

export function canonicalProjectRoot(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw validation("projectRoot must be an absolute path");
  }
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(raw));
  } catch (error) {
    if (missing(error)) throw validation("projectRoot is missing", { path: raw });
    throw error;
  }
  if (!fs.statSync(real).isDirectory()) throw validation("projectRoot is not a directory");
  return real;
}

export function repoFor(root: string): ProjectRepo | null {
  try {
    return projectRepo(root);
  } catch (error) {
    if (error instanceof DevChestraError) return null;
    throw error;
  }
}

function canonicalExisting(raw: string): string {
  const candidate = path.isAbsolute(raw) ? raw : "";
  if (candidate === "" || candidate.includes("\0")) {
    throw validation("Existing worktree path must be an absolute path");
  }
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch (error) {
    if (missing(error)) throw validation("Existing worktree is missing", { path: raw });
    throw error;
  }
  let aliasesOnly = false;
  if (process.platform === "win32" && !candidate.split(/[\\/]/).includes("..")) {
    let current = candidate;
    aliasesOnly = true;
    while (current !== path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) {
        aliasesOnly = false;
        break;
      }
      current = path.dirname(current);
    }
  }
  if (candidate !== real && !aliasesOnly) {
    throw validation("Existing worktree path must be canonical (no symlink or traversal)", {
      path: raw,
      canonical: real,
    });
  }
  const stat = fs.lstatSync(real);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw validation("Existing worktree is not a directory", { path: raw });
  }
  return real;
}

export function selectionOf(value: unknown): RunWorkspaceSelection {
  if (!isRunWorkspaceSelection(value)) {
    throw validation("Invalid run workspace selection", {
      expected: ["project", "existing-worktree", "new-worktree"],
    });
  }
  return value;
}

export async function listProjectWorkspaces(
  projectRoot: string,
): Promise<Result<ProjectWorkspaces, DevChestraError>> {
  try {
    const root = canonicalProjectRoot(projectRoot);
    const repo = repoFor(root);
    if (repo === null) return ok({ projectRoot: root, worktrees: [], git: false });
    const worktrees: WorktreeInfo[] = [];
    for (const entry of worktreeList(root)) {
      if (entry.head === null) continue;
      let real: string;
      try {
        real = fs.realpathSync.native(entry.path);
      } catch {
        real = entry.path;
      }
      if (real === root) continue;
      worktrees.push({
        path: real,
        branch: entry.detached ? null : entry.branch,
        head: entry.head,
        detached: entry.detached || entry.branch === null,
      });
    }
    return ok({ projectRoot: root, worktrees, git: true });
  } catch (error) {
    return err(toDevChestraError(error));
  }
}

export async function validateRunWorkspace(
  projectRoot: string,
  rawSelection: unknown,
): Promise<Result<ValidatedRunWorkspace, DevChestraError>> {
  try {
    const root = canonicalProjectRoot(projectRoot);
    const selection = selectionOf(rawSelection);
    const repo = repoFor(root);
    if (selection.mode === "project") {
      return ok({
        selection: { mode: "project" },
        projectRoot: root,
        dir: root,
        git: repo !== null,
        baseSha: null,
      });
    }
    if (repo === null) {
      throw validation("Worktree selections require a Git project", { projectRoot: root });
    }
    if (selection.mode === "container" && process.platform !== "linux")
      throw validation("Container workspaces currently require Linux");
    if (selection.mode === "new-worktree" || selection.mode === "container") {
      return ok({
        selection,
        projectRoot: root,
        dir: null,
        git: true,
        baseSha: projectHead(root),
      });
    }
    const candidate = canonicalExisting(selection.path);
    const listed = worktreeList(root).some((entry) => {
      try {
        return fs.realpathSync.native(entry.path) === candidate;
      } catch {
        return false;
      }
    });
    if (!listed) {
      throw validation("Existing worktree is not registered with this project", {
        path: candidate,
        projectRoot: root,
      });
    }
    if (candidate === root) {
      throw validation("The project root is not an existing-worktree alternative", {
        path: candidate,
      });
    }
    let head: string;
    try {
      head = inspectWorktree(candidate, repo.commonDir, false);
    } catch (error) {
      throw validation("Existing worktree does not belong to this project", {
        path: candidate,
        projectRoot: root,
        cause: error instanceof DevChestraError ? error.message : String(error),
      });
    }
    return ok({
      selection: { mode: "existing-worktree", path: candidate },
      projectRoot: root,
      dir: candidate,
      git: true,
      baseSha: head,
    });
  } catch (error) {
    return err(toDevChestraError(error));
  }
}
