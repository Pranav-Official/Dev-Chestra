import type { Path, RunWorkspaceBinding, RunWorkspaceSelection } from "@devchestra/core";
export type WorkspaceMode =
  | "scratch"
  | "worktree"
  | "project"
  | "existing-worktree"
  | "new-worktree";
export type FinalizeOutcome = "success" | "failed" | "cancelled";
export type ProcessStopReason = "exited" | "killed" | "grace_timeout" | "crash";
export interface AcquireScratchRequest {
  dataDir: string;
  projectId: string;
  runId: string;
  path: Path | string;
  attempt: number;
  generation: number;
  mode?: WorkspaceMode;
  requireExisting?: boolean;
  projectRoot?: string;
  /** Unsupported in this milestone; present so callers get an explicit rejection. */
  base?: string;
  setup?: string;
  from?: string;
  /**
   * New runs only: the run-level frozen choice. When present every node uses
   * this cwd and the legacy node.workspace mode is ignored. Absent for old runs.
   */
  runWorkspace?: RunWorkspaceBinding;
  /** Run-level new worktrees may advance HEAD via workflow commits. */
  allowHeadMove?: boolean;
  /**
   * Internal: run-level marker storage may be (re)created even when the run
   * itself is requireExisting. Never used by legacy per-node acquisition.
   */
  createMarkerBase?: boolean;
  signal?: AbortSignal;
}
export interface ScratchWorkspace {
  readonly mode: WorkspaceMode;
  readonly dataDir: string;
  readonly projectId: string;
  readonly runId: string;
  readonly path: Path;
  readonly attempt: number;
  readonly generation: number;
  readonly dir: string;
  /** Per-attempt finalization marker path; created by finalizeScratch. */
  readonly markerFile: string;
  readonly reused: boolean;
  readonly projectRoot: string | null;
  /** Committed revision the shared worktree is pinned to; worktree workspaces only. */
  readonly baseSha?: string;
  /** Frozen run-level selection; run-workspace acquisitions only. */
  readonly selection?: RunWorkspaceSelection;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string;
  readonly detached: boolean;
}

export interface ProjectWorkspaces {
  readonly projectRoot: string;
  readonly worktrees: readonly WorktreeInfo[];
  readonly git: boolean;
}

/** Read-only preflight result. Nothing is created. */
export interface ValidatedRunWorkspace {
  readonly selection: RunWorkspaceSelection;
  readonly projectRoot: string;
  readonly dir: string | null;
  readonly git: boolean;
  readonly baseSha: string | null;
}

export interface PrepareRunWorkspaceRequest {
  dataDir: string;
  projectId: string;
  runId: string;
  projectRoot: string;
  selection: RunWorkspaceSelection;
  /** True on resume/recovery: validate only, never create or re-adopt. */
  requireExisting?: boolean;
  signal?: AbortSignal;
}

export interface RunWorkspaceIdentity {
  readonly projectRoot: string;
  readonly selection: RunWorkspaceSelection;
  readonly dir: string;
  readonly mode: "project" | "existing-worktree" | "new-worktree";
  readonly baseSha: string | null;
  readonly git: boolean;
}
export interface ProcessStopEvidence {
  attempt: number;
  generation: number;
  stopped: true;
  reason?: ProcessStopReason;
  exitCode?: number | null;
}
export interface FinalizeScratchRequest {
  outcome: FinalizeOutcome;
  process: ProcessStopEvidence;
}
export interface FinalizeScratchInfo {
  readonly dir: string;
  readonly attempt: number;
  readonly generation: number;
  readonly outcome: FinalizeOutcome;
  readonly alreadyFinalized: boolean;
  readonly markerFile: string;
  readonly process: ProcessStopEvidence;
}
export interface RemoveScratchInfo {
  readonly dir: string;
  readonly removed: boolean;
  readonly alreadyAbsent: boolean;
}
