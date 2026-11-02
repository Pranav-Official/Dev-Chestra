import type { WorkflowListItem } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FilePlus2,
  Link2,
  MoreHorizontal,
  Trash2,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { queryKeys, useBootstrap, useProjectWorkflows, useWorkflowGroups } from "../api/hooks.js";
import { describeWorkflowError, isConflictError, workflowApi } from "../editor/api/workflowApi.js";
import { ConfirmDialog } from "../editor/controls/ConfirmDialog.js";
import { CreateWorkflowDialog } from "../editor/controls/CreateWorkflowDialog.js";
import { RelinkProjectDialog } from "../editor/controls/RelinkProjectDialog.js";
import { Topbar } from "../shell/Topbar.js";
import { formatTime } from "../ui/format.js";
import { ProjectHeader } from "../ui/ProjectHeader.js";
import { AuthState, EmptyState, LoadingState, NetworkError, NotFoundState } from "../ui/states.js";
import { GroupControls, GroupSelect } from "../workflows/GroupControls.js";

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
  const groups = useWorkflowGroups(pid, canQuery);
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups(pid) });
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
          <ProjectHeader project={project} section="workflows" />

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
              {groups.data ? (
                <div className="workflow-toolbar">
                  <div>
                    <h2>Workflow library</h2>
                    <p>Organize the workflows in this project.</p>
                  </div>
                  <span className="sp" />
                  <GroupControls projectId={pid} groups={groups.data} />
                </div>
              ) : groups.isError ? (
                <p role="alert">
                  Could not load workflow groups.{" "}
                  <button type="button" onClick={() => void groups.refetch()}>
                    Retry
                  </button>
                </p>
              ) : null}
              {workflows.isPending ? (
                <div className="card">
                  <LoadingState label="Loading workflows…" />
                </div>
              ) : workflows.error ? (
                <NetworkError
                  message={describeWorkflowError(workflows.error)}
                  onRetry={() => void workflows.refetch()}
                />
              ) : (workflows.data?.items.length ?? 0) === 0 &&
                (groups.data?.document.groups.length ?? 0) === 0 ? (
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
                <div className="workflow-library">
                  {[
                    ...(groups.data?.document.groups ?? [])
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name)),
                    { id: "", name: "Ungrouped" },
                  ].map((group) => {
                    const items = (workflows.data?.items ?? []).filter(
                      (item) => (groups.data?.document.memberships[item.id] ?? "") === group.id,
                    );
                    return (
                      <section className="workflow-group" key={group.id || "ungrouped"}>
                        <details open>
                          <summary className="workflow-group-heading">
                            <ChevronDown
                              className="workflow-chevron"
                              size={16}
                              aria-hidden="true"
                            />
                            <span className="workflow-group-name">
                              {group.name} ({items.length})
                            </span>
                          </summary>
                          <div className="workflow-items">
                            {items.length === 0 ? (
                              <p className="workflow-group-empty">
                                No workflows in this group yet.
                              </p>
                            ) : (
                              items.map((item) => (
                                <article
                                  className="workflow-item"
                                  key={item.id}
                                  data-testid={`workflow-row-${item.id}`}
                                >
                                  <div className="workflow-item-icon">
                                    <Workflow size={17} aria-hidden="true" />
                                  </div>
                                  <div className="workflow-item-main">
                                    <Link
                                      className="workflow-item-title"
                                      to={`/p/${pid}/w/${item.id}`}
                                    >
                                      {item.name}
                                    </Link>
                                    {item.description ? (
                                      <p className="workflow-description">{item.description}</p>
                                    ) : null}
                                    <div className="workflow-meta">
                                      <span className="mono" title={item.relativeFile}>
                                        {item.relativeFile}
                                      </span>
                                      <span>Updated {formatTime(item.updatedAt)}</span>
                                    </div>
                                  </div>
                                  <div className="workflow-item-status">
                                    <ValidationStatus item={item} />
                                  </div>
                                  <div className="workflow-item-actions">
                                    <details className="workflow-actions-menu">
                                      <summary aria-label={`Actions for ${item.name}`}>
                                        <MoreHorizontal size={18} aria-hidden="true" />
                                      </summary>
                                      <div className="workflow-actions-popover">
                                        {groups.data && groups.data.document.groups.length > 0 ? (
                                          <GroupSelect
                                            projectId={pid}
                                            workflowId={item.id}
                                            groups={groups.data}
                                          />
                                        ) : null}
                                        <button
                                          type="button"
                                          className="workflow-menu-delete"
                                          onClick={() => {
                                            setDeleteError(null);
                                            setDeleting(item);
                                          }}
                                        >
                                          <Trash2 size={14} aria-hidden="true" /> Delete workflow
                                        </button>
                                      </div>
                                    </details>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </details>
                        {group.id && groups.data ? (
                          <GroupControls projectId={pid} groups={groups.data} groupId={group.id} />
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}
              {workflows.data !== undefined && workflows.data.nextCursor !== null ? (
                <p className="faint" style={{ marginTop: 8 }}>
                  Only the first page of workflows is shown.
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
