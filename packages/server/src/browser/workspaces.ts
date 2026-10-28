import type { ProjectWorkspacesResponse, RunWorkspaceSelection } from "@devchestra/api";
import { DevChestraError } from "../errors.js";
import type { BrowserWorkspacePort } from "./ports.js";

/** New runs default to the registered project root when no workspace is sent. */
export const DEFAULT_RUN_WORKSPACE: RunWorkspaceSelection = { mode: "project" };

export function normalizeRunWorkspace(
  selection: RunWorkspaceSelection | undefined,
): RunWorkspaceSelection {
  return selection ?? DEFAULT_RUN_WORKSPACE;
}

function requirePort(service: BrowserWorkspacePort | undefined): BrowserWorkspacePort {
  if (service === undefined) {
    throw new DevChestraError(
      "E_NOT_SUPPORTED",
      "Run workspace selection is not available on this server.",
    );
  }
  return service;
}

/**
 * Read-only preflight. `project` needs no catalog; other modes are checked
 * against the trusted project's worktree list before a durable run is created.
 * Never creates a worktree here.
 */
export async function validateRunWorkspace(
  service: BrowserWorkspacePort | undefined,
  projectRoot: string,
  selection: RunWorkspaceSelection,
): Promise<RunWorkspaceSelection> {
  if (selection.mode === "project") return selection;
  return requirePort(service).validate(projectRoot, selection);
}

export async function listRunWorkspaces(
  service: BrowserWorkspacePort | undefined,
  projectRoot: string,
): Promise<ProjectWorkspacesResponse> {
  return requirePort(service).catalog(projectRoot);
}
