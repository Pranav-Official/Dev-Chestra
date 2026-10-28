import { isTerminalRunStatus } from "@devchestra/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, classifyError } from "../api/client.js";
import { queryKeys, useBootstrap } from "../api/hooks.js";
import type { RunSummary } from "../api/types.js";
import { ConfirmDialog } from "../editor/controls/ConfirmDialog.js";

export function WorkspaceActions({
  projectId,
  workflowId,
  run,
  name,
}: {
  projectId: string;
  workflowId?: string;
  run?: RunSummary;
  name?: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const client = useQueryClient();
  const bootstrap = useBootstrap();
  const navigate = useNavigate();
  const location = useLocation();
  const removing = !run && !workflowId;
  const restoring = !!run?.archivedAt;
  const label = run
    ? restoring
      ? "Restore run"
      : "Archive run"
    : workflowId
      ? "Archive completed runs…"
      : "Remove from workspace";
  const mutation = useMutation({
    mutationFn: () =>
      run
        ? api.setRunArchived(run.id, !restoring)
        : workflowId
          ? api.archiveWorkflowRuns(projectId, workflowId)
          : api.removeProject(projectId),
    onSuccess: async () => {
      setConfirm(false);
      if (removing && location.pathname.startsWith(`/p/${projectId}/`)) {
        const next = bootstrap.data?.projects.find((project) => project.id !== projectId);
        navigate(next ? `/p/${next.id}/workflows` : "/", { replace: true });
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.bootstrap }),
        client.invalidateQueries({ queryKey: queryKeys.runs }),
      ]);
    },
  });
  const disabled = !!run && !restoring && !isTerminalRunStatus(run.status);
  return (
    <>
      <details
        className="workspace-menu"
        ref={menu}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          aria-label={
            run
              ? `Actions for run #${run.runNumber}`
              : workflowId
                ? `Actions for workflow ${name ?? workflowId}`
                : `Actions for project ${name ?? projectId}`
          }
        >
          ⋯
        </summary>
        <div className="workspace-menu-items">
          <button
            type="button"
            disabled={disabled}
            title={disabled ? "Only completed runs can be archived." : undefined}
            onClick={() => {
              if (menu.current) menu.current.open = false;
              mutation.reset();
              setConfirm(true);
            }}
          >
            {label}
          </button>
          {disabled ? <span className="faint">Active runs cannot be archived.</span> : null}
        </div>
      </details>
      <ConfirmDialog
        open={confirm}
        title={label}
        confirmLabel={restoring ? "Restore" : removing ? "Remove project" : "Archive"}
        danger={removing}
        busy={mutation.isPending}
        message={
          removing
            ? "This hides the project from your workspace. Repository files and run history are preserved. Add the same project again to restore its history. Projects with active runs (including paused runs and approvals) cannot be removed."
            : restoring
              ? "Restore this run to the default history and navigation. Execution status will not change."
              : run
                ? "Hide this completed run from default history and navigation. Its URL remains usable. You can restore it from the Archived filter."
                : "Archive all completed runs in this workflow. Active runs remain visible. Archived runs can be restored from history; their URLs and execution statuses are preserved."
        }
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirm(false)}
      >
        {mutation.error ? <p role="alert">{classifyError(mutation.error).message}</p> : null}
      </ConfirmDialog>
    </>
  );
}
