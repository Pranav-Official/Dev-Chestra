import * as fs from "node:fs";
import * as path from "node:path";
import { err, ok, RelayError, type Result } from "@relay/core";
import { acquireScratch, finalizeScratch, releaseScratch } from "./scratch.js";
import {
  parseWorkspacePath,
  requireAbsolutePath,
  requireSegment,
  type WorkspaceLayout,
  workspaceLayout,
} from "./segments.js";
import type {
  AcquireScratchRequest,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  ScratchWorkspace,
} from "./types.js";
import {
  acquireLock,
  assertRecordIdentity,
  BINDING_NAME,
  type Binding,
  conflict,
  ferr,
  gitText,
  INTENT_NAME,
  inspectWorktree,
  missing,
  ownedDir,
  type ProjectRepo,
  projectHead,
  projectRepo,
  readBinding,
  readIntent,
  readLstat,
  releaseLock,
  removeRecord,
  sameRecord,
  toRelayError,
  validateWorktree,
  WORKTREE_NAME,
  type WorktreeIntent,
  werr,
  writeExclusive,
} from "./worktree-git.js";

const RECORD_VERSION = 1;
const GIT_ADD_TIMEOUT_MS = 60_000;

interface Issued {
  inner: ScratchWorkspace;
  bindingFile: string;
  dir: string;
  baseSha: string;
  allowHeadMove: boolean;
}

const issued = new WeakMap<ScratchWorkspace, Issued>();

function prepareProjectRoot(raw: string): string {
  const real = fs.realpathSync.native(requireAbsolutePath(raw, "projectRoot"));
  if (!fs.statSync(real).isDirectory()) throw werr("projectRoot is not a directory");
  return real;
}

function intentRecord(repo: ProjectRepo, dir: string, base: string): WorktreeIntent {
  return {
    version: RECORD_VERSION,
    kind: "relay.worktree.intent",
    projectRoot: repo.root,
    projectRootId: repo.rootId,
    commonDir: repo.commonDir,
    commonDirId: repo.commonId,
    base,
    dir,
  };
}

function bindingRecord(repo: ProjectRepo, dir: string, base: string): Binding {
  return {
    version: RECORD_VERSION,
    kind: "relay.worktree",
    projectRoot: repo.root,
    projectRootId: repo.rootId,
    commonDir: repo.commonDir,
    commonDirId: repo.commonId,
    base,
    dir,
  };
}

function bindingFromIntent(intent: WorktreeIntent): Binding {
  return {
    version: RECORD_VERSION,
    kind: "relay.worktree",
    projectRoot: intent.projectRoot,
    projectRootId: intent.projectRootId,
    commonDir: intent.commonDir,
    commonDirId: intent.commonDirId,
    base: intent.base,
    dir: intent.dir,
  };
}

function persistBinding(file: string, binding: Binding): void {
  if (writeExclusive(file, binding)) return;
  const raced = readBinding(file);
  if (raced === null || !sameRecord(raced, binding)) {
    throw conflict("Worktree binding changed during acquisition", { step: "binding_conflict" });
  }
}

function createWorktree(root: string, dir: string, base: string): void {
  gitText(
    root,
    ["worktree", "add", "--detach", "--", dir, base],
    "worktree_add",
    GIT_ADD_TIMEOUT_MS,
  );
}

function inspectPinned(
  dir: string,
  commonDir: string,
  expected: string,
  allowHeadMove: boolean,
): void {
  // Only creation/intent recovery calls this, before any workflow commit.
  const actual = inspectWorktree(dir, commonDir, true);
  if (!allowHeadMove && actual !== expected) {
    throw conflict("Worktree HEAD does not match the pinned base", {
      step: "worktree_identity",
      expected,
      actual,
    });
  }
}

function existingDataDir(raw: string): string {
  const resolved = path.resolve(requireAbsolutePath(raw, "dataDir"));
  if (resolved === path.resolve("/")) {
    throw new RelayError("E_VALIDATION", "dataDir must not be the filesystem root");
  }
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (e) {
    if (missing(e)) {
      throw werr("Data directory is missing", { step: "workspace_missing", path: resolved });
    }
    throw e;
  }
  if (!fs.statSync(real).isDirectory()) throw werr("Data directory is not a directory");
  return real;
}

function existingLayout(request: AcquireScratchRequest, dataDir: string): WorkspaceLayout {
  const layout = workspaceLayout(
    dataDir,
    requireSegment(request.projectId, "projectId"),
    requireSegment(request.runId, "runId"),
    parseWorkspacePath(request.path),
  );
  ownedDir(layout.projectDir, "Project workspace root");
  ownedDir(layout.runDir, "Run workspace root");
  return layout;
}

interface WorktreeHandles {
  root: string;
  repo: ProjectRepo;
  dir: string;
  bindingFile: string;
  intentFile: string;
}

function worktreeHandles(request: AcquireScratchRequest, layout: WorkspaceLayout): WorktreeHandles {
  const root = prepareProjectRoot(request.projectRoot as string);
  return {
    root,
    repo: projectRepo(root),
    dir: path.join(layout.runDir, WORKTREE_NAME),
    bindingFile: path.join(layout.runDir, BINDING_NAME),
    intentFile: path.join(layout.runDir, INTENT_NAME),
  };
}

function acquireExistingBinding(
  handles: WorktreeHandles,
  allowHeadMove: boolean,
): { baseSha: string; reused: boolean } {
  const binding = readBinding(handles.bindingFile);
  if (binding === null) {
    if (readLstat(handles.dir) === null) {
      throw werr("Worktree is missing during recovery", {
        step: "worktree_missing",
        path: handles.dir,
      });
    }
    throw werr("Worktree binding is missing during recovery", {
      step: "binding_missing",
      path: handles.bindingFile,
    });
  }
  assertRecordIdentity(binding, handles.repo, handles.dir);
  validateWorktree(binding, !allowHeadMove);
  removeRecord(handles.intentFile);
  return { baseSha: binding.base, reused: true };
}

function recoverIntent(
  handles: WorktreeHandles,
  intent: WorktreeIntent,
  allowHeadMove: boolean,
): { baseSha: string; reused: boolean } {
  assertRecordIdentity(intent, handles.repo, handles.dir);
  const existing = readLstat(handles.dir);
  if (existing === null) {
    createWorktree(handles.root, handles.dir, intent.base);
    inspectPinned(handles.dir, handles.repo.commonDir, intent.base, allowHeadMove);
    persistBinding(handles.bindingFile, bindingFromIntent(intent));
    removeRecord(handles.intentFile);
    return { baseSha: intent.base, reused: false };
  }
  if (existing.isSymbolicLink()) throw ferr("Worktree is a symlink", { path: handles.dir });
  if (!existing.isDirectory()) throw werr("Worktree is not a directory", { step: "worktree" });
  ownedDir(handles.dir, "Worktree");
  inspectPinned(handles.dir, handles.repo.commonDir, intent.base, allowHeadMove);
  persistBinding(handles.bindingFile, bindingFromIntent(intent));
  removeRecord(handles.intentFile);
  return { baseSha: intent.base, reused: true };
}

function createFresh(
  handles: WorktreeHandles,
  allowHeadMove: boolean,
): { baseSha: string; reused: boolean } {
  const existing = readLstat(handles.dir);
  if (existing !== null) {
    if (existing.isSymbolicLink()) throw ferr("Worktree is a symlink", { path: handles.dir });
    if (!existing.isDirectory()) throw werr("Worktree is not a directory", { step: "worktree" });
    throw werr("Worktree exists without a binding or intent; refusing to adopt it", {
      step: "binding_missing",
      path: handles.dir,
    });
  }
  const base = projectHead(handles.root);
  const intent = intentRecord(handles.repo, handles.dir, base);
  if (!writeExclusive(handles.intentFile, intent)) {
    throw conflict("Worktree intent already exists; refuse to overwrite it", {
      step: "intent_conflict",
    });
  }
  createWorktree(handles.root, handles.dir, base);
  inspectPinned(handles.dir, handles.repo.commonDir, base, allowHeadMove);
  persistBinding(handles.bindingFile, bindingRecord(handles.repo, handles.dir, base));
  removeRecord(handles.intentFile);
  return { baseSha: base, reused: false };
}

function acquireUnderLock(
  handles: WorktreeHandles,
  requireExisting: boolean,
  allowHeadMove: boolean,
): { baseSha: string; reused: boolean } {
  if (requireExisting) return acquireExistingBinding(handles, allowHeadMove);
  const binding = readBinding(handles.bindingFile);
  if (binding !== null) {
    assertRecordIdentity(binding, handles.repo, handles.dir);
    validateWorktree(binding, !allowHeadMove);
    removeRecord(handles.intentFile);
    return { baseSha: binding.base, reused: true };
  }
  const intent = readIntent(handles.intentFile);
  return intent === null
    ? createFresh(handles, allowHeadMove)
    : recoverIntent(handles, intent, allowHeadMove);
}

export async function acquireWorktree(
  request: AcquireScratchRequest,
): Promise<Result<ScratchWorkspace, RelayError>> {
  let inner: ScratchWorkspace | undefined;
  try {
    if (request.mode !== undefined && request.mode !== "worktree") {
      throw werr(`Workspace mode '${String(request.mode)}' is not supported`, {
        step: "unsupported_mode",
        mode: request.mode,
      });
    }
    if (request.base !== undefined || request.setup !== undefined || request.from !== undefined) {
      throw werr("Worktree base, setup and from are not supported", {
        step: "unsupported_option",
      });
    }
    if (typeof request.projectRoot !== "string") {
      throw werr("Worktree mode requires projectRoot", { step: "project_root_required" });
    }

    let layout: WorkspaceLayout;
    if (request.requireExisting === true) {
      layout = existingLayout(request, existingDataDir(request.dataDir));
    } else {
      const scratch = await acquireScratch({ ...request, mode: "scratch" });
      if (!scratch.ok) return scratch;
      inner = scratch.value;
      layout = workspaceLayout(inner.dataDir, inner.projectId, inner.runId, inner.path);
      if (layout.wsDir !== inner.dir) throw conflict("Derived node workspace path is inconsistent");
      ownedDir(layout.runDir, "Run workspace root");
    }

    const handles = worktreeHandles(request, layout);
    const allowHeadMove = request.allowHeadMove === true;
    const lock = await acquireLock(layout.runDir, request.signal);
    let baseSha: string;
    let reused: boolean;
    try {
      ({ baseSha, reused } = acquireUnderLock(
        handles,
        request.requireExisting === true,
        allowHeadMove,
      ));
    } finally {
      releaseLock(lock);
    }

    if (inner === undefined) {
      const scratch = await acquireScratch({
        ...request,
        mode: "scratch",
        requireExisting:
          request.createMarkerBase === true ? false : request.requireExisting === true,
      });
      if (!scratch.ok) return scratch;
      inner = scratch.value;
      if (inner.dir !== layout.wsDir) throw conflict("Derived node workspace path is inconsistent");
    }

    const workspace: ScratchWorkspace = Object.freeze({
      ...inner,
      mode: "worktree",
      dir: handles.dir,
      reused,
      baseSha,
    });
    issued.set(workspace, {
      inner,
      bindingFile: handles.bindingFile,
      dir: handles.dir,
      baseSha,
      allowHeadMove,
    });
    return ok(workspace);
  } catch (e) {
    if (inner !== undefined) releaseScratch(inner);
    return err(toRelayError(e));
  }
}

export async function finalizeWorktree(
  workspace: ScratchWorkspace,
  request: FinalizeScratchRequest,
): Promise<Result<FinalizeScratchInfo, RelayError>> {
  const record = issued.get(workspace);
  if (record === undefined) {
    return err(ferr("Worktree was not issued by Relay; reacquire", { step: "unissued" }));
  }
  try {
    const binding = readBinding(record.bindingFile);
    if (binding === null) {
      throw werr("Worktree binding is missing", {
        step: "binding_missing",
        path: record.bindingFile,
      });
    }
    if (binding.base !== record.baseSha || binding.dir !== record.dir) {
      throw conflict("Worktree binding changed since acquisition", { step: "binding_conflict" });
    }
    assertRecordIdentity(binding, projectRepo(binding.projectRoot), record.dir);
    validateWorktree(binding, !record.allowHeadMove);
    const result = await finalizeScratch(record.inner, request);
    return result.ok ? ok({ ...result.value, dir: record.dir }) : result;
  } catch (e) {
    return err(toRelayError(e));
  }
}

export function releaseWorktree(workspace: ScratchWorkspace): void {
  const record = issued.get(workspace);
  if (record !== undefined) releaseScratch(record.inner);
}
