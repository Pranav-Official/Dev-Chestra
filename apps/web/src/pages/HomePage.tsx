import { Folder, FolderGit2, FolderPlus, PlayCircle } from "lucide-react";
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
        <div className="page">
          <div className="page-head">
            <div className="grow">
              <h1>Projects</h1>
              <p>
                Local projects and their runs. Register an existing folder, author workflows in the
                editor, and open runs in the read-only viewer.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => setAddOpen(true)}>
              <FolderPlus size={14} aria-hidden="true" />
              Add project
            </button>
          </div>

          <div className="row wrap" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="faint">Projects</div>
              <div className="v">{data.projects.length}</div>
            </div>
            <div className="stat">
              <div className="faint">Runs</div>
              <div className="v">{data.counts.runs}</div>
            </div>
            <div className="stat">
              <div className="faint">Active runs</div>
              <div className="v">{data.counts.activeRuns}</div>
            </div>
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
            <div className="card" style={{ marginBottom: 20 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Kind</th>
                    <th>Path</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr key={project.id}>
                      <td>
                        <Link to={`/p/${project.id}/workflows`} style={{ fontWeight: 600 }}>
                          {project.name}
                        </Link>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          {project.kind === "git" ? (
                            <FolderGit2 size={14} aria-hidden="true" />
                          ) : (
                            <Folder size={14} aria-hidden="true" />
                          )}
                          {project.kind}
                        </span>
                      </td>
                      <td className="mono muted">{project.path}</td>
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

          <h2 style={{ marginBottom: 8 }}>Needs approval</h2>
          {inbox.isPending ? (
            <div className="card" data-testid="inbox-loading" aria-busy="true">
              <p className="faint">Loading pending approvals…</p>
            </div>
          ) : inbox.isError ? (
            <div className="card" data-testid="inbox-error" role="alert">
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
                  <div className="card" data-testid="inbox-empty">
                    <p className="faint">No pending approvals.</p>
                  </div>
                );
              }
              return (
                <div className="card" data-testid="inbox-list">
                  <table className="table">
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
                              style={{ fontWeight: 600 }}
                            >
                              Run #{approval.runNumber}
                            </Link>
                          </td>
                          <td className="mono">{approval.projectId}</td>
                          <td className="mono">{approval.path}</td>
                          <td
                            style={{
                              maxWidth: 320,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={approval.message}
                          >
                            {approval.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {inbox.hasNextPage ? (
                    <button
                      type="button"
                      className="btn sm"
                      data-testid="inbox-load-more"
                      onClick={() => void inbox.fetchNextPage()}
                      disabled={inbox.isFetchingNextPage}
                    >
                      {inbox.isFetchingNextPage ? "Loading…" : "Load more"}
                    </button>
                  ) : null}
                </div>
              );
            })()
          )}

          <h2 style={{ marginBottom: 8 }}>Recent runs</h2>
          {recent.length === 0 ? (
            <div className="card">
              <EmptyState
                title="No runs yet"
                message="Run a workflow with the Relay CLI; it will appear here and update live."
              />
            </div>
          ) : (
            <div className="card">
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Project</th>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run) => (
                    <tr key={run.id} className="click">
                      <td>
                        <Link
                          to={`/p/${run.projectId}/r/${run.id}`}
                          className="row"
                          style={{ gap: 6, fontWeight: 600 }}
                        >
                          <PlayCircle size={14} aria-hidden="true" />#{run.runNumber}
                        </Link>
                      </td>
                      <td>{run.projectName}</td>
                      <td>{run.workflowName ?? run.workflowId}</td>
                      <td>
                        <StatusPill status={run.status} />
                      </td>
                      <td className="muted">{formatTime(run.startedAt ?? run.createdAt)}</td>
                      <td>{formatCost(run.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
