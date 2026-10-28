import * as fs from "node:fs";
import * as path from "node:path";
import {
  DevChestraError,
  isRecord,
  isRunWorkspaceSelection,
  type RunWorkspaceSelection,
} from "@devchestra/core";
import { repoFor } from "./run-workspace-catalog.js";
import type { ValidatedRunWorkspace } from "./types.js";
import {
  assertRecordIdentity,
  BINDING_NAME,
  conflict,
  dirIdentity,
  inspectWorktree,
  missing,
  ownedDir,
  type ProjectRepo,
  readBinding,
  toDevChestraError,
  werr,
} from "./worktree-git.js";

export const RUN_FILE = "run-workspace.json";
const VERSION = 1;

export interface StoredRunWorkspace {
  version: 1;
  kind: "devchestra.run-workspace";
  projectRoot: string;
  projectRootId: string;
  selection: RunWorkspaceSelection;
  dir: string;
  dirId: string;
  baseSha: string | null;
  git: boolean;
  commonDir: string | null;
  commonDirId: string | null;
}

export function sameSelection(a: RunWorkspaceSelection, b: RunWorkspaceSelection): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function readRunFile(file: string): StoredRunWorkspace | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw werr("Run workspace binding is not a regular file", { step: "run_binding_invalid" });
  }
  if (stat.size > 16 * 1024) {
    throw werr("Run workspace binding is too large", { step: "run_binding_invalid" });
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw werr("Run workspace binding is not valid JSON", { step: "run_binding_invalid" });
  }
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    value.kind !== "devchestra.run-workspace" ||
    typeof value.projectRoot !== "string" ||
    typeof value.projectRootId !== "string" ||
    typeof value.dir !== "string" ||
    typeof value.dirId !== "string" ||
    (value.baseSha !== null && typeof value.baseSha !== "string") ||
    (value.commonDir !== null && typeof value.commonDir !== "string") ||
    (value.commonDirId !== null && typeof value.commonDirId !== "string") ||
    typeof value.git !== "boolean" ||
    !isRunWorkspaceSelection(value.selection)
  ) {
    throw werr("Run workspace binding is invalid", { step: "run_binding_invalid" });
  }
  return value as unknown as StoredRunWorkspace;
}

export function writeRunFile(file: string, value: StoredRunWorkspace): void {
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readRunFile(file);
    if (raced === null || JSON.stringify(raced) !== JSON.stringify(value)) {
      throw conflict("Run workspace binding changed during acquisition", {
        step: "run_binding_conflict",
      });
    }
    return;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

export function assertStored(stored: StoredRunWorkspace, next: StoredRunWorkspace): void {
  if (
    stored.projectRoot !== next.projectRoot ||
    stored.projectRootId !== next.projectRootId ||
    stored.dir !== next.dir ||
    stored.dirId !== next.dirId ||
    stored.commonDir !== next.commonDir ||
    stored.commonDirId !== next.commonDirId ||
    stored.git !== next.git ||
    !sameSelection(stored.selection, next.selection)
  ) {
    throw conflict("Run workspace does not match the frozen run identity", {
      step: "run_binding_conflict",
    });
  }
}

function repoIdentity(stored: StoredRunWorkspace): ProjectRepo | null {
  if (!stored.git) return null;
  const repo = repoFor(stored.projectRoot);
  if (repo === null) {
    throw conflict("Run project is no longer a Git repository", { step: "repo_identity" });
  }
  if (repo.commonDir !== stored.commonDir || repo.commonId !== stored.commonDirId) {
    throw conflict("Run project repository identity changed", {
      step: "repo_identity",
      expected: stored.commonDir,
      actual: repo.commonDir,
    });
  }
  return repo;
}

/** Revalidate persisted identities. Never creates or repairs anything. */
export function validateStoredIdentity(stored: StoredRunWorkspace): ProjectRepo | null {
  ownedDir(stored.projectRoot, "Project root");
  if (dirIdentity(stored.projectRoot) !== stored.projectRootId) {
    throw conflict("Project root was replaced at the frozen path", { step: "project_identity" });
  }
  const repo = repoIdentity(stored);
  ownedDir(stored.dir, stored.selection.mode === "project" ? "Project root" : "Run workspace");
  if (dirIdentity(stored.dir) !== stored.dirId) {
    throw conflict("Selected workspace was replaced at the frozen path", {
      step: "workspace_identity",
    });
  }
  if (stored.selection.mode === "existing-worktree") {
    if (repo === null) throw conflict("Existing worktree has no Git identity");
    try {
      inspectWorktree(stored.dir, repo.commonDir, false);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_CONFLICT") throw error;
      throw conflict("Existing worktree identity changed", { step: "worktree_identity" });
    }
  }
  if (stored.selection.mode === "new-worktree") {
    if (repo === null) throw conflict("New worktree has no Git identity");
    const binding = readBinding(path.join(path.dirname(stored.dir), BINDING_NAME));
    if (binding === null) {
      throw werr("Run worktree binding is missing", {
        step: "binding_missing",
        path: path.dirname(stored.dir),
      });
    }
    assertRecordIdentity(binding, repo, stored.dir);
    // Creation is detached, but later workflow commits may attach a branch.
    // Reuse validates repository registration only, not detached HEAD.
    inspectWorktree(stored.dir, repo.commonDir, false);
  }
  return repo;
}

export function storedFor(
  validated: ValidatedRunWorkspace,
  dir: string,
  baseSha: string | null,
): StoredRunWorkspace {
  const repo = validated.git ? repoFor(validated.projectRoot) : null;
  return {
    version: VERSION,
    kind: "devchestra.run-workspace",
    projectRoot: validated.projectRoot,
    projectRootId: dirIdentity(validated.projectRoot),
    selection: validated.selection,
    dir,
    dirId: dir === validated.projectRoot ? dirIdentity(validated.projectRoot) : dirIdentity(dir),
    baseSha,
    git: validated.git,
    commonDir: repo?.commonDir ?? null,
    commonDirId: repo?.commonId ?? null,
  };
}

export function readRequired(file: string): StoredRunWorkspace {
  const stored = readRunFile(file);
  if (stored === null) {
    throw werr("Run workspace binding is missing", { step: "run_binding_missing", path: file });
  }
  return stored;
}

export { toDevChestraError };
