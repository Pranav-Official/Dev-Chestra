import type { RunWorkspaceSelection } from "@relay/core";
import type { BrowserWorkspacePort, ProjectWorkspacesResponse } from "@relay/server";
import { listProjectWorkspaces, validateRunWorkspace } from "@relay/workspaces";

async function catalog(projectRoot: string): Promise<ProjectWorkspacesResponse> {
  const result = await listProjectWorkspaces(projectRoot);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Read-only validation used by both the CLI start path and the browser API.
 * Existing paths must appear in the project's own worktree list; the main root
 * is the separate default and is never accepted as an alternative.
 */
export async function validateWorkspaceSelection(
  projectRoot: string,
  selection: RunWorkspaceSelection,
): Promise<RunWorkspaceSelection> {
  const result = await validateRunWorkspace(projectRoot, selection);
  if (!result.ok) throw result.error;
  return result.value.selection;
}

/** Browser API port; keeps Git inspection in the CLI composition root. */
export function createBrowserWorkspaceService(): BrowserWorkspacePort {
  return {
    catalog,
    validate: validateWorkspaceSelection,
  };
}
