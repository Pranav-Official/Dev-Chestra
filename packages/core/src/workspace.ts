/**
 * Browser-safe run-level workspace choice. A workflow execution uses exactly
 * one cwd for every agent and shell; the choice is made when the run starts.
 */
export type RunWorkspaceSelection =
  | { mode: "project" }
  | { mode: "existing-worktree"; path: string }
  | { mode: "new-worktree" };

/** Frozen on the run at launch. projectRoot is registered project metadata. */
export interface RunWorkspaceBinding {
  selection: RunWorkspaceSelection;
  projectRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
  );
}

export function isRunWorkspaceSelection(value: unknown): value is RunWorkspaceSelection {
  if (!isRecord(value)) return false;
  if (value.mode === "project" || value.mode === "new-worktree") return true;
  return value.mode === "existing-worktree" && isPath(value.path);
}

export function isRunWorkspaceBinding(value: unknown): value is RunWorkspaceBinding {
  return isRecord(value) && isPath(value.projectRoot) && isRunWorkspaceSelection(value.selection);
}

export function defaultRunWorkspaceSelection(): RunWorkspaceSelection {
  return { mode: "project" };
}
