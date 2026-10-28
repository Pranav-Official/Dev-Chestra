import * as fs from "node:fs";
import * as path from "node:path";
import {
  err,
  isRecord,
  isRunWorkspaceSelection,
  ok,
  RelayError,
  type Result,
  type RunWorkspaceBinding,
} from "@relay/core";
import { validateRunWorkspace } from "./run-workspace-catalog.js";
import {
  assertStored,
  RUN_FILE,
  readRequired,
  readRunFile,
  type StoredRunWorkspace,
  sameSelection,
  storedFor,
  validateStoredIdentity,
  writeRunFile,
} from "./run-workspace-stored.js";
import {
  acquireScratch as acquireScratchOnly,
  finalizeScratch as finalizeScratchOnly,
} from "./scratch.js";
import {
  parseWorkspacePath,
  requirePositiveInteger,
  requireSegment,
  workspaceLayout,
} from "./segments.js";
import type {
  AcquireScratchRequest,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  PrepareRunWorkspaceRequest,
  RemoveScratchInfo,
  RunWorkspaceIdentity,
  ScratchWorkspace,
} from "./types.js";
import { acquireWorktree, finalizeWorktree, releaseWorktree } from "./worktree.js";
import {
  assertRecordIdentity,
  BINDING_NAME,
  conflict,
  gitText,
  INTENT_NAME,
  projectRepo as projectRepoFor,
  readBinding,
  readLstat,
  removeRecord,
  toRelayError,
  WORKTREE_NAME,
  werr,
} from "./worktree-git.js";

interface Issued {
  base: ScratchWorkspace;
  stored: StoredRunWorkspace;
  runFile: string;
}

const issued = new WeakMap<ScratchWorkspace, Issued>();
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

function runLayout(base: ScratchWorkspace, executionPath: string): { runFile: string } {
  const layout = workspaceLayout(base.dataDir, base.projectId, base.runId, executionPath);
  return { runFile: path.join(layout.runDir, RUN_FILE) };
}

function issue(
  base: ScratchWorkspace,
  stored: StoredRunWorkspace,
  runFile: string,
): ScratchWorkspace {
  const workspace: ScratchWorkspace = Object.freeze({
    ...base,
    mode: stored.selection.mode,
    dir: stored.dir,
    projectRoot: stored.projectRoot,
    selection: stored.selection,
    ...(stored.baseSha === null ? {} : { baseSha: stored.baseSha }),
  });
  issued.set(workspace, { base, stored, runFile });
  return workspace;
}

function releaseBase(workspace: ScratchWorkspace): void {
  if (workspace.mode === "worktree") releaseWorktree(workspace);
}

async function acquireBase(
  request: AcquireScratchRequest,
  projectRoot: string,
): Promise<Result<ScratchWorkspace, RelayError>> {
  const {
    runWorkspace: _frozen,
    allowHeadMove: _allow,
    createMarkerBase: _marker,
    mode: _legacyMode,
    ...legacyBase
  } = request;
  if (request.runWorkspace?.selection.mode === "new-worktree") {
    return acquireWorktree({
      ...legacyBase,
      mode: "worktree",
      allowHeadMove: true,
      createMarkerBase: true,
      projectRoot,
    });
  }
  return acquireScratchOnly({
    ...legacyBase,
    mode: "scratch",
    requireExisting: false,
  });
}

export async function acquireRunWorkspace(
  request: AcquireScratchRequest & { runWorkspace: RunWorkspaceBinding },
): Promise<Result<ScratchWorkspace, RelayError>> {
  let base: ScratchWorkspace | undefined;
  try {
    if (aborted(request.signal)) {
      return err(new RelayError("E_CANCELLED", "Workspace acquisition cancelled"));
    }
    requireSegment(request.projectId, "projectId");
    requireSegment(request.runId, "runId");
    requirePositiveInteger(request.attempt, "attempt");
    requirePositiveInteger(request.generation, "generation");
    const executionPath = parseWorkspacePath(request.path);
    const binding = request.runWorkspace;
    if (!isRecord(binding) || !isRunWorkspaceSelection(binding.selection)) {
      throw new RelayError("E_VALIDATION", "runWorkspace must contain a valid selection");
    }
    const validated = await validateRunWorkspace(binding.projectRoot, binding.selection);
    if (!validated.ok) return validated;
    const frozen = validated.value;
    if (frozen.selection.mode !== binding.selection.mode) {
      throw conflict("Run workspace selection changed during acquisition");
    }

    let preStored: StoredRunWorkspace | undefined;
    if (request.requireExisting === true) {
      const dataDir = fs.realpathSync.native(path.resolve(request.dataDir));
      const layout = workspaceLayout(dataDir, request.projectId, request.runId, executionPath);
      preStored = readRequired(path.join(layout.runDir, RUN_FILE));
      validateStoredIdentity(preStored);
    }
    const acquired = await acquireBase(request, frozen.projectRoot);
    if (!acquired.ok) return acquired;
    base = acquired.value;
    const { runFile } = runLayout(base, executionPath);
    const selectedDir = frozen.selection.mode === "new-worktree" ? base.dir : frozen.dir;
    if (selectedDir === null) {
      throw new RelayError("E_VALIDATION", "Run workspace directory is missing");
    }
    const next = storedFor(
      frozen,
      selectedDir,
      frozen.selection.mode === "new-worktree" ? (base.baseSha ?? frozen.baseSha) : frozen.baseSha,
    );

    let stored: StoredRunWorkspace;
    if (preStored !== undefined) {
      assertStored(preStored, next);
      stored = preStored;
    } else {
      const existing = readRunFile(runFile);
      if (existing === null) {
        writeRunFile(runFile, next);
        stored = next;
      } else {
        validateStoredIdentity(existing);
        assertStored(existing, next);
        stored = existing;
      }
    }
    validateStoredIdentity(stored);
    return ok(issue(base, stored, runFile));
  } catch (error) {
    if (base !== undefined) releaseBase(base);
    return err(toRelayError(error));
  }
}

export async function prepareRunWorkspace(
  request: PrepareRunWorkspaceRequest,
): Promise<Result<RunWorkspaceIdentity, RelayError>> {
  try {
    const validated = await validateRunWorkspace(request.projectRoot, request.selection);
    if (!validated.ok) return validated;
    const frozen = validated.value;
    if (request.requireExisting === true) {
      const dataDir = fs.realpathSync.native(path.resolve(request.dataDir));
      const layout = workspaceLayout(dataDir, request.projectId, request.runId, "run");
      const stored = readRequired(path.join(layout.runDir, RUN_FILE));
      if (
        stored.projectRoot !== frozen.projectRoot ||
        !sameSelection(stored.selection, frozen.selection)
      ) {
        throw conflict("Run workspace does not match the requested selection", {
          step: "run_binding_conflict",
        });
      }
      validateStoredIdentity(stored);
      return ok({
        projectRoot: stored.projectRoot,
        selection: stored.selection,
        dir: stored.dir,
        mode: stored.selection.mode,
        baseSha: stored.baseSha,
        git: stored.git,
      });
    }
    const result = await acquireRunWorkspace({
      dataDir: request.dataDir,
      projectId: request.projectId,
      runId: request.runId,
      path: "run",
      attempt: 1,
      generation: 1,
      runWorkspace: { selection: frozen.selection, projectRoot: frozen.projectRoot },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!result.ok) return result;
    const workspace = result.value;
    const identity: RunWorkspaceIdentity = Object.freeze({
      projectRoot: frozen.projectRoot,
      selection: workspace.selection ?? frozen.selection,
      dir: workspace.dir,
      mode: workspace.mode as RunWorkspaceIdentity["mode"],
      baseSha: (workspace as { baseSha?: string }).baseSha ?? frozen.baseSha,
      git: frozen.git,
    });
    releaseRunWorkspace(workspace);
    return ok(identity);
  } catch (error) {
    return err(toRelayError(error));
  }
}

export async function finalizeRunWorkspace(
  workspace: ScratchWorkspace,
  request: FinalizeScratchRequest,
): Promise<Result<FinalizeScratchInfo, RelayError>> {
  const record = issued.get(workspace);
  if (record === undefined) {
    return err(new RelayError("E_WORKSPACE", "Run workspace was not issued by Relay; reacquire"));
  }
  try {
    const stored = readRequired(record.runFile);
    assertStored(stored, record.stored);
    validateStoredIdentity(stored);
    const result =
      record.base.mode === "worktree"
        ? await finalizeWorktree(record.base, request)
        : await finalizeScratchOnly(record.base, request);
    return result.ok ? ok({ ...result.value, dir: stored.dir }) : result;
  } catch (error) {
    return err(toRelayError(error));
  }
}

export function releaseRunWorkspace(workspace: ScratchWorkspace): void {
  const record = issued.get(workspace);
  if (record !== undefined) releaseBase(record.base);
}

export async function removeRunWorkspace(
  workspace: ScratchWorkspace,
): Promise<Result<RemoveScratchInfo, RelayError>> {
  try {
    const record = issued.get(workspace);
    if (record === undefined) {
      throw new RelayError("E_WORKSPACE", "Run workspace was not issued by Relay; reacquire");
    }
    if (record.stored.selection.mode !== "new-worktree") {
      return ok({ dir: record.stored.dir, removed: false, alreadyAbsent: false });
    }
    validateStoredIdentity(record.stored);
    const runDir = path.dirname(record.runFile);
    const binding = readBinding(path.join(runDir, BINDING_NAME));
    if (binding === null) {
      return ok({ dir: record.stored.dir, removed: false, alreadyAbsent: true });
    }
    const expected = path.join(runDir, WORKTREE_NAME);
    if (binding.dir !== expected || binding.dir !== record.stored.dir) {
      throw werr("Refusing to remove a worktree that is not owned by this run", {
        step: "worktree_identity",
      });
    }
    assertRecordIdentity(binding, projectRepoFor(binding.projectRoot), expected);
    if (readLstat(binding.dir) !== null) {
      gitText(
        binding.projectRoot,
        ["worktree", "remove", "--force", "--", binding.dir],
        "worktree_remove",
      );
    }
    removeRecord(path.join(runDir, BINDING_NAME));
    removeRecord(path.join(runDir, INTENT_NAME));
    return ok({ dir: binding.dir, removed: true, alreadyAbsent: false });
  } catch (error) {
    return err(toRelayError(error));
  }
}
