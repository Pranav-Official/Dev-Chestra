# @relay/workspaces

Filesystem acquisition for Relay runs. One workflow execution uses exactly one
working directory for every agent and shell.

## Run-level selection

A fresh run chooses one browser-safe `RunWorkspaceSelection` (exported by
`@relay/core` and re-exported here):

- `{ mode: "project" }` - the registered project root (Git or plain folder).
- `{ mode: "existing-worktree", path }` - a canonical worktree already listed by
  the trusted project's `git worktree list`.
- `{ mode: "new-worktree" }` - a detached worktree created under the run's data
  directory.

The frozen `RunWorkspaceBinding { selection, projectRoot }` is persisted with the
run. `AcquireScratchRequest.runWorkspace` carries it for every node; when absent
the legacy per-node `scratch`/`worktree` behavior is unchanged (old runs).

## Identity and recovery

`prepareRunWorkspace` binds the run once before dispatch and stores
`run-workspace.json` in the run data directory; `requireExisting: true` on
resume validates only and never creates or re-adopts. The binding records the
canonical project root, selected directory and Git common directory with
`dev:ino` identities. Acquisition, resumption and accepted-result finalization
revalidate those identities, so replacing a directory at the same path fails
closed.

Markers always live under the data directory. Project roots and existing
worktrees are never removed, and no Relay marker is written into a user's
checkout. New worktrees may advance HEAD via workflow commits; the initial base
is frozen only for evidence.

## Exports

- `listProjectWorkspaces(projectRoot)` - read-only catalog (`projectRoot`,
  `worktrees`, `git`); the main root is not repeated in `worktrees`.
- `validateRunWorkspace(projectRoot, selection)` - read-only preflight; rejects
  unlisted/non-canonical paths with `E_VALIDATION`.
- `prepareRunWorkspace(request)` - bind identities; `requireExisting` for resume.
- `acquireRunWorkspace` / `finalizeRunWorkspace` / `removeRunWorkspace` - used by
  the `@relay/workspaces` port wrappers.
