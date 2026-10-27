import type { WorkflowListItem } from "@relay/api";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FilePlus2,
  Folder,
  FolderGit2,
  Link2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { queryKeys, useBootstrap, useProjectWorkflows } from "../api/hooks.js";
import { describeWorkflowError, isConflictError, workflowApi } from "../editor/api/workflowApi.js";
import { ConfirmDialog } from "../editor/controls/ConfirmDialog.js";
import { CreateWorkflowDialog } from "../editor/controls/CreateWorkflowDialog.js";
import { RelinkProjectDialog } from "../editor/controls/RelinkProjectDialog.js";
import { Topbar } from "../shell/Topbar.js";
import { formatTime } from "../ui/format.js";
import { AuthState, EmptyState, LoadingState, NetworkError, NotFoundState } from "../ui/states.js";

function ValidationStatus({ item }: { item: WorkflowListItem }) {
  const summary = item.validationSummary;
  if (summary === undefined) {
    return <span className="pill">Not checked</span>;
  }
  if (summary.ok && summary.warnings === 0) {
    return (
      <span className="pill green">
        <CheckCircle2 size={12} aria-hidden="true" /> Valid
      </span>
    );
  }
  if (!summary.ok) {
    return (
      <span className="pill red">
        <AlertTriangle size={12} aria-hidden="true" />
        {summary.errors} {summary.errors === 1 ? "error" : "errors"}
      </span>
    );
  }
  return (
    <span className="pill amber">
      <AlertTriangle size={12} aria-hidden="true" />
      {summary.warnings} {summary.warnings === 1 ? "warning" : "warnings"}
    </span>
  );
}

export function WorkflowsPage() {
  const { pid = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bootstrap = useBootstrap();
  const project = bootstrap.data?.projects.find((item) => item.id === pid);
  const canQuery = project !== undefined && !project.missing;
  const workflows = useProjectWorkflows(pid, canQuery);
  const [createOpen, setCreateOpen] = useState(false);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [deleting, setDeleting] = useState<WorkflowListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const crumbs = [
    { label: "Projects", to: "/" },
    { label: project?.name ?? pid },
    { label: "Workflows" },
  ];
  const actions = (
    <>
      <Link className="btn sm" to={`/p/${pid}/runs`}>
        Runs
      </Link>
      <button
        type="button"
        className="btn sm"
        onClick={() => setCreateOpen(true)}
        disabled={!canQuery}
      >
        <FilePlus2 size={14} aria-hidden="true" />
        New workflow
      </button>
    </>
  );

  if (bootstrap.isPending) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <LoadingState label="Loading project workflows…" />
        </div>
      </>
    );
  }
  const failure = bootstrap.error ? classifyError(bootstrap.error) : null;
  if (failure?.kind === "auth") {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <AuthState />
        </div>
      </>
    );
  }
  if (failure) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <NetworkError message={failure.message} onRetry={() => void bootstrap.refetch()} />
        </div>
      </>
    );
  }
  if (project === undefined) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <NotFoundState
            title="Project not found"
            message={`No registered project has the id "${pid}".`}
            backTo="/"
            backLabel="Back to projects"
          />
        </div>
      </>
    );
  }

  const refetchList = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows(pid) });
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await workflowApi.remove(pid, deleting.id, deleting.etag);
      setDeleting(null);
      refetchList();
    } catch (error) {
      if (isConflictError(error)) {
        setDeleteError(
          "This workflow changed on disk after the list was loaded. Reload the list before deleting.",
        );
        refetchList();
      } else {
        setDeleteError(describeWorkflowError(error));
      }
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <>
      <Topbar crumbs={crumbs} actions={actions} />
      <div className="content" data-testid="workflows-page">
        <div className="page">
          <div className="page-head">
            <div className="grow">
              <h1>{project.name}</h1>
              <p className="mono">{project.path}</p>
            </div>
            <span className="chip" title={project.path}>
              {project.kind === "git" ? (
                <FolderGit2 size={12} aria-hidden="true" />
              ) : (
                <Folder size={12} aria-hidden="true" />
              )}
              {project.kind}
            </span>
          </div>

          <nav className="editor-subnav" aria-label="Project sections">
            <Link className="tab active" to={`/p/${pid}/workflows`} aria-current="page">
              Workflows
            </Link>
            <Link className="tab" to={`/p/${pid}/runs`}>
              Runs
            </Link>
          </nav>

          {project.missing ? (
            <div className="banner amber" role="status" data-testid="missing-project-banner">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                <b>{project.name}</b> is registered, but its folder is missing. Workflow files
                cannot be listed until the project is relinked. Run history stays attached.
              </span>
              <span className="sp" />
              <button type="button" className="btn sm" onClick={() => setRelinkOpen(true)}>
                <Link2 size={13} aria-hidden="true" />
                Relink folder
              </button>
            </div>
          ) : null}

          {!project.missing ? (
            <>
              {workflows.isPending ? (
                <div className="card">
                  <LoadingState label="Loading workflows…" />
                </div>
              ) : workflows.error ? (
                <NetworkError
                  message={describeWorkflowError(workflows.error)}
                  onRetry={() => void workflows.refetch()}
                />
              ) : (workflows.data?.items.length ?? 0) === 0 ? (
                <div className="card">
                  <EmptyState
                    title="No workflows yet"
                    message="Create a blank workflow, then add start, agent, shell and end nodes on the canvas."
                  >
                    <button type="button" className="btn" onClick={() => setCreateOpen(true)}>
                      <FilePlus2 size={14} aria-hidden="true" />
                      New workflow
                    </button>
                  </EmptyState>
                </div>
              ) : (
                <div className="card">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Workflow</th>
                        <th>File</th>
                        <th>Validation</th>
                        <th>Updated</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {workflows.data?.items.map((item) => (
                        <tr key={item.id} data-testid={`workflow-row-${item.id}`}>
                          <td>
                            <Link to={`/p/${pid}/w/${item.id}`} style={{ fontWeight: 600 }}>
                              {item.name}
                            </Link>
                            <div className="faint mono">{item.id}</div>
                            {item.description === null ? null : (
                              <div className="muted">{item.description}</div>
                            )}
                          </td>
                          <td className="mono muted">{item.relativeFile}</td>
                          <td>
                            <ValidationStatus item={item} />
                          </td>
                          <td className="muted">{formatTime(item.updatedAt)}</td>
                          <td>
                            <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                              <Link className="btn sm" to={`/p/${pid}/w/${item.id}`}>
                                Open
                              </Link>
                              <button
                                type="button"
                                className="btn sm ghost"
                                aria-label={`Delete workflow ${item.name}`}
                                onClick={() => {
                                  setDeleteError(null);
                                  setDeleting(item);
                                }}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {workflows.data !== undefined && workflows.data.nextCursor !== null ? (
                <p className="faint" style={{ marginTop: 8 }}>
                  Only the first page of workflows is shown in this slice.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <CreateWorkflowDialog
        open={createOpen}
        projectId={pid}
        onClose={() => setCreateOpen(false)}
        onCreated={(document) => {
          setCreateOpen(false);
          refetchList();
          navigate(`/p/${pid}/w/${document.workflow.id}`);
        }}
      />
      <RelinkProjectDialog
        open={relinkOpen}
        projectId={pid}
        projectName={project.name}
        onClose={() => setRelinkOpen(false)}
        onRelinked={() => {
          setRelinkOpen(false);
          void bootstrap.refetch();
          refetchList();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete workflow"
        message={
          deleting === null
            ? ""
            : `Delete "${deleting.name}"? The workflow file is removed; past runs keep their immutable snapshots.`
        }
        confirmLabel="Delete"
        danger
        busy={deletePending}
        onCancel={() => {
          if (deletePending) return;
          setDeleting(null);
          setDeleteError(null);
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteError === null ? null : (
          <p className="editor-form-error" role="alert">
            {deleteError}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
