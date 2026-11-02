import { CheckCircle2, Folder, FolderGit2, FolderPlus, PlayCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { useAllRuns, useApprovalsInbox, useBootstrap } from "../api/hooks.js";
import { AddProjectDialog } from "../editor/controls/AddProjectDialog.js";
import { Topbar } from "../shell/Topbar.js";
import { formatCost, formatTime } from "../ui/format.js";
import { StatusPill } from "../ui/StatusPill.js";
import { AuthState, EmptyState, LoadingState, NetworkError } from "../ui/states.js";

export function HomePage() {
  const bootstrap = useBootstrap();
  const runs = useAllRuns();
  const inbox = useApprovalsInbox();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  if (bootstrap.isPending) {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects" }]} />
        <div className="content">
          <LoadingState label="Loading projects and recent runs…" />
        </div>
      </>
    );
  }
  const failure = bootstrap.error ? classifyError(bootstrap.error) : null;
  if (failure?.kind === "auth") {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects" }]} />
        <div className="content">
          <AuthState />
        </div>
      </>
    );
  }
  if (failure) {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects" }]} />
        <div className="content">
          <NetworkError
            message={failure.message}
            onRetry={() => {
              void bootstrap.refetch();
              void runs.refetch();
            }}
          />
        </div>
      </>
    );
  }

  const data = bootstrap.data;
  if (data === undefined) return null;
  const recent = runs.data?.items.slice(0, 8) ?? [];

  return (
    <>
      <Topbar crumbs={[{ label: "Projects" }]} />
      <div className="content">
        <div className="page home">
          <div className="home-head">
            <div className="grow">
              <h1>Projects</h1>
              <p>
                Local projects and their runs. Register an existing folder, author workflows in the
                editor, and open runs in the read-only viewer.
              </p>
            </div>
            <button type="button" className="btn primary" onClick={() => setAddOpen(true)}>
              <FolderPlus size={14} aria-hidden="true" />
              Add project
            </button>
          </div>

          <dl className="home-summary">
            <div>
              <dd>{data.projects.length}</dd>
              <dt>Projects</dt>
            </div>
            <div>
              <dd>{data.counts.runs}</dd>
              <dt>Runs</dt>
            </div>
            <div className={data.counts.activeRuns > 0 ? "live" : undefined}>
              <dd>{data.counts.activeRuns}</dd>
              <dt>Active runs</dt>
            </div>
          </dl>

          <section className="home-section">
            <div className="home-section-head">
              <h2>Workspaces</h2>
            </div>
            {data.projects.length === 0 ? (
              <div className="card">
                <EmptyState
                  title="No projects yet"
                  message="Register an existing folder to start authoring workflows."
                >
                  <button type="button" className="btn" onClick={() => setAddOpen(true)}>
                    <FolderPlus size={14} aria-hidden="true" />
                    Add project
                  </button>
                </EmptyState>
              </div>
            ) : (
              <div className="card home-table-wrap">
                <table className="table home-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Kind</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((project) => (
                      <tr key={project.id}>
                        <td>
                          <div className="home-project">
                            <span className="home-project-icon">
                              {project.kind === "git" ? (
                                <FolderGit2 size={16} aria-hidden="true" />
                              ) : (
                                <Folder size={16} aria-hidden="true" />
                              )}
                            </span>
                            <span className="home-project-text">
                              <Link to={`/p/${project.id}/workflows`}>{project.name}</Link>
                              <span className="mono faint" title={project.path}>
                                {project.path}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="muted">{project.kind}</td>
                        <td>
                          {project.missing ? (
                            <span className="pill amber">Missing path</span>
                          ) : (
                            <span className="pill green">Available</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="home-section">
            <div className="home-section-head">
              <h2>Needs approval</h2>
            </div>
            {inbox.isPending ? (
              <div className="home-note" data-testid="inbox-loading" aria-busy="true">
                <p>Loading pending approvals…</p>
              </div>
            ) : inbox.isError ? (
              <div className="home-note error" data-testid="inbox-error" role="alert">
                <p>{classifyError(inbox.error).message}</p>
                <button type="button" className="btn sm" onClick={() => void inbox.refetch()}>
                  Retry
                </button>
              </div>
            ) : (
              (() => {
                const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
                if (items.length === 0) {
                  return (
                    <div className="home-note" data-testid="inbox-empty">
                      <CheckCircle2 size={14} aria-hidden="true" />
                      <p>No pending approvals.</p>
                    </div>
                  );
                }
                return (
                  <div className="card home-table-wrap" data-testid="inbox-list">
                    <table className="table home-table">
                      <thead>
                        <tr>
                          <th>Run</th>
                          <th>Project</th>
                          <th>Path</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((approval) => (
                          <tr
                            key={`${approval.runId}:${approval.path}`}
                            data-testid={`inbox-${approval.runId}`}
                          >
                            <td>
                              <Link
                                to={`/p/${approval.projectId}/r/${approval.runId}?path=${encodeURIComponent(approval.path)}`}
                                className="home-run-link"
                              >
                                Run #{approval.runNumber}
                              </Link>
                            </td>
                            <td className="mono">{approval.projectId}</td>
                            <td className="mono">{approval.path}</td>
                            <td className="home-ellipsis" title={approval.message}>
                              {approval.message}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {inbox.hasNextPage ? (
                      <div className="home-table-foot">
                        <button
                          type="button"
                          className="btn sm"
                          data-testid="inbox-load-more"
                          onClick={() => void inbox.fetchNextPage()}
                          disabled={inbox.isFetchingNextPage}
                        >
                          {inbox.isFetchingNextPage ? "Loading…" : "Load more"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })()
            )}
          </section>

          <section className="home-section">
            <div className="home-section-head">
              <h2>Recent runs</h2>
            </div>
            {recent.length === 0 ? (
              <div className="card">
                <EmptyState
                  title="No runs yet"
                  message="Run a workflow with the DevChestra CLI; it will appear here and update live."
                />
              </div>
            ) : (
              <div className="card home-table-wrap">
                <table className="table home-table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Workflow</th>
                      <th>Project</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <Link to={`/p/${run.projectId}/r/${run.id}`} className="home-run-link">
                            <PlayCircle size={14} aria-hidden="true" />#{run.runNumber}
                          </Link>
                        </td>
                        <td className="home-workflow">{run.workflowName ?? run.workflowId}</td>
                        <td className="muted">{run.projectName}</td>
                        <td>
                          <StatusPill status={run.status} />
                        </td>
                        <td className="muted num-text">
                          {formatTime(run.startedAt ?? run.createdAt)}
                        </td>
                        <td className="num">{formatCost(run.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onRegistered={(projectId) => {
          setAddOpen(false);
          navigate(`/p/${projectId}/workflows`);
        }}
      />
    </>
  );
}
