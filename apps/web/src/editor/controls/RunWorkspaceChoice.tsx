import type { ProjectWorkspaceEntry, RunWorkspaceSelection } from "@devchestra/api";
import { FolderOpen, GitBranch, Loader2, PlusSquare, RefreshCw, TriangleAlert } from "lucide-react";
import type { ProjectWorkspacesState } from "./useProjectWorkspaces.js";

function forEachWorktree(
  worktrees: readonly ProjectWorkspaceEntry[],
  projectRoot: string,
): ProjectWorkspaceEntry[] {
  return worktrees.filter((worktree) => worktree.path !== projectRoot);
}

function branchLabel(worktree: ProjectWorkspaceEntry): string {
  const branch = worktree.branch ?? "detached HEAD";
  return `${branch} @ ${worktree.head.slice(0, 12)}`;
}

export function RunWorkspaceChoice({
  selection,
  onChange,
  workspaces,
  notice,
}: {
  selection: RunWorkspaceSelection;
  onChange: (selection: RunWorkspaceSelection) => void;
  workspaces: ProjectWorkspacesState;
  notice: string | null;
}) {
  const data = workspaces.data;
  const git = data?.git ?? false;
  const worktrees = data === null ? [] : forEachWorktree(data.worktrees, data.projectRoot);
  const loading = workspaces.loading;
  const unavailable = data === null;
  const existingDisabled = loading || !git || worktrees.length === 0;
  const newDisabled = loading || !git;
  const selectedPath = selection.mode === "existing-worktree" ? (selection.path ?? "") : "";

  return (
    <fieldset className="editor-field" data-testid="run-workspace-choice">
      <legend className="editor-field-label">Workspace for this run</legend>
      <p className="editor-field-hint">
        Every agent and shell node in this workflow uses the same directory. The choice is stored
        with the run and restored on resume.
      </p>

      <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <input
          type="radio"
          name="run-workspace-mode"
          value="project"
          checked={selection.mode === "project"}
          onChange={() => onChange({ mode: "project" })}
          data-testid="run-workspace-mode-project"
        />
        <span>
          <b>
            <FolderOpen size={13} aria-hidden="true" /> Registered project root
          </b>
          <span className="muted"> · default{data === null ? "" : ` · ${data.projectRoot}`}</span>
          <span className="editor-field-hint">
            Runs directly in the project folder. Agents and shell commands can read and edit project
            files; changes are live in your checkout and nothing is committed automatically.
          </span>
        </span>
      </label>

      <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <input
          type="radio"
          name="run-workspace-mode"
          value="existing-worktree"
          checked={selection.mode === "existing-worktree"}
          disabled={existingDisabled}
          onChange={() => {
            const first = worktrees[0];
            if (first !== undefined) onChange({ mode: "existing-worktree", path: first.path });
          }}
          data-testid="run-workspace-mode-existing"
        />
        <span>
          <b>
            <GitBranch size={13} aria-hidden="true" /> Existing Git worktree
          </b>
          <span className="editor-field-hint">
            Use a worktree this project already has. Changes stay in that worktree, not the main
            checkout.
          </span>
          {selection.mode === "existing-worktree" ? (
            <select
              className="input"
              aria-label="Existing worktree path"
              value={selectedPath}
              onChange={(event) =>
                onChange({ mode: "existing-worktree", path: event.currentTarget.value })
              }
              data-testid="run-workspace-existing-path"
            >
              {selectedPath === "" ? <option value="">Choose a worktree…</option> : null}
              {worktrees.map((worktree) => (
                <option key={worktree.path} value={worktree.path}>
                  {worktree.path} · {branchLabel(worktree)}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      </label>

      <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <input
          type="radio"
          name="run-workspace-mode"
          value="new-worktree"
          checked={selection.mode === "new-worktree"}
          disabled={newDisabled}
          onChange={() => onChange({ mode: "new-worktree" })}
          data-testid="run-workspace-mode-new"
        />
        <span>
          <b>
            <PlusSquare size={13} aria-hidden="true" /> Create a new Git worktree
          </b>
          <span className="editor-field-hint">
            Created under DevChestra's data directory when the run starts, from the project's
            committed HEAD. Uncommitted and untracked project files are not present.
          </span>
        </span>
      </label>

      <div className="editor-field-hint" data-testid="run-workspace-status" role="status">
        {loading ? (
          <span className="row" style={{ gap: 6 }}>
            <Loader2 size={13} aria-hidden="true" /> Loading worktrees…
          </span>
        ) : workspaces.error !== null ? (
          <span className="row" style={{ gap: 6 }}>
            <TriangleAlert size={13} aria-hidden="true" />
            <span>
              Worktrees could not be loaded. The project root is still available. {workspaces.error}
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={workspaces.reload}
              data-testid="run-workspace-retry"
            >
              <RefreshCw size={13} aria-hidden="true" /> Retry
            </button>
          </span>
        ) : unavailable ? (
          <span>Workspace details are unavailable. The project root is still available.</span>
        ) : !git ? (
          <span>
            This project is not a Git repository. Existing and new worktrees are unavailable; only
            the project root can be used.
          </span>
        ) : worktrees.length === 0 ? (
          <span>No existing Git worktrees were found for this project.</span>
        ) : null}
        {notice === null ? null : (
          <span className="editor-field-error" role="alert">
            {notice}
          </span>
        )}
      </div>
      {!loading && data !== null ? (
        <button
          type="button"
          className="btn sm"
          onClick={workspaces.reload}
          data-testid="run-workspace-refresh"
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh worktrees
        </button>
      ) : null}
    </fieldset>
  );
}
