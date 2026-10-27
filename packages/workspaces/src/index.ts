import {
  acquireRunWorkspace,
  finalizeRunWorkspace,
  releaseRunWorkspace,
  removeRunWorkspace,
} from "./run-workspace.js";
import {
  acquireScratch as acquireScratchOnly,
  finalizeScratch as finalizeScratchOnly,
  releaseScratch as releaseScratchOnly,
  removeScratch as removeScratchOnly,
} from "./scratch.js";
import type { AcquireScratchRequest, FinalizeScratchRequest, ScratchWorkspace } from "./types.js";
import { acquireWorktree, finalizeWorktree, releaseWorktree } from "./worktree.js";

const isRunWorkspace = (workspace: ScratchWorkspace): boolean =>
  workspace.mode === "project" ||
  workspace.mode === "existing-worktree" ||
  workspace.mode === "new-worktree";

export const acquireScratch = (request: AcquireScratchRequest) => {
  if (request.runWorkspace !== undefined) {
    return acquireRunWorkspace({ ...request, runWorkspace: request.runWorkspace });
  }
  return request.mode === "worktree" ? acquireWorktree(request) : acquireScratchOnly(request);
};

export const finalizeScratch = (workspace: ScratchWorkspace, request: FinalizeScratchRequest) => {
  if (isRunWorkspace(workspace)) return finalizeRunWorkspace(workspace, request);
  return workspace.mode === "worktree"
    ? finalizeWorktree(workspace, request)
    : finalizeScratchOnly(workspace, request);
};

export const releaseScratch = (workspace: ScratchWorkspace) => {
  if (isRunWorkspace(workspace)) return releaseRunWorkspace(workspace);
  return workspace.mode === "worktree" ? releaseWorktree(workspace) : releaseScratchOnly(workspace);
};

export const removeScratch = (workspace: ScratchWorkspace) =>
  isRunWorkspace(workspace) ? removeRunWorkspace(workspace) : removeScratchOnly(workspace);

export type { RunWorkspaceBinding, RunWorkspaceSelection } from "@relay/core";
export {
  isInside,
  PathSafety,
  pathSafety,
  realRoot,
  resolveFileInside,
  resolveInside,
} from "./path-safety.js";
export {
  acquireRunWorkspace,
  finalizeRunWorkspace,
  prepareRunWorkspace,
  releaseRunWorkspace,
  removeRunWorkspace,
} from "./run-workspace.js";
export { listProjectWorkspaces, validateRunWorkspace } from "./run-workspace-catalog.js";
export type {
  AcquireScratchRequest,
  FinalizeOutcome,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  PrepareRunWorkspaceRequest,
  ProcessStopEvidence,
  ProcessStopReason,
  ProjectWorkspaces,
  RemoveScratchInfo,
  RunWorkspaceIdentity,
  ScratchWorkspace,
  ValidatedRunWorkspace,
  WorkspaceMode,
  WorktreeInfo,
} from "./types.js";
export interface WorkspaceApi {
  acquireScratch: typeof acquireScratch;
  finalizeScratch: typeof finalizeScratch;
  releaseScratch: typeof releaseScratch;
  removeScratch: typeof removeScratch;
}
