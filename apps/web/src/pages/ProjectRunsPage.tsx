import type { RunStatus } from "@devchestra/core";
import { Folder, FolderGit2, History, PlayCircle } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { useBootstrap, useProjectRuns, useProjectWorkflows } from "../api/hooks.js";
import { Topbar } from "../shell/Topbar.js";
import { formatCost, formatTime } from "../ui/format.js";
import { StatusPill } from "../ui/StatusPill.js";
import {
  AuthState,
  EmptyState,
  LoadingState,
  MissingProjectBanner,
  NetworkError,
  NotFoundState,
} from "../ui/states.js";
import { WorkspaceActions } from "../ui/WorkspaceActions.js";

const STATUS_FILTERS: { value: RunStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "waiting_approval", label: "Waiting for approval" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rejected", label: "Rejected" },
];

function parseStatus(value: string | null): RunStatus | undefined {
  if (value === null) return undefined;
  return STATUS_FILTERS.some((item) => item.value === value) && value !== "all"
    ? (value as RunStatus)
    : undefined;
}

export function ProjectRunsPage() {
  const { pid = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const bootstrap = useBootstrap();
  const status = parseStatus(params.get("status"));
  const workflow = params.get("workflow") ?? undefined;
  const archived = params.get("archived") === "true";
  const runsQuery = useProjectRuns(pid, status, workflow, archived);
  const managedWorkflows = useProjectWorkflows(
    pid,
    bootstrap.data?.projects.some((project) => project.id === pid && !project.missing) ?? false,
  );
  const runs = useMemo(
    () => runsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [runsQuery.data],
  );

  const update = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params);
    if (value === null || value === "" || value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (bootstrap.isPending) {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects", to: "/" }, { label: "Project" }]} />
        <div className="content">
          <LoadingState label="Loading project…" />
        </div>
      </>
    );
  }
  const failure = bootstrap.error ? classifyError(bootstrap.error) : null;
  if (failure?.kind === "auth") {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects", to: "/" }, { label: "Project" }]} />
        <div className="content">
          <AuthState />
        </div>
      </>
    );
  }
  if (failure) {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects", to: "/" }, { label: "Project" }]} />
        <div className="content">
          <NetworkError message={failure.message} onRetry={() => void bootstrap.refetch()} />
        </div>
      </>
    );
  }
  const project = bootstrap.data?.projects.find((item) => item.id === pid);
  if (project === undefined) {
    return (
      <>
        <Topbar crumbs={[{ label: "Projects", to: "/" }, { label: "Not found" }]} />
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

  const workflows = new Map<string, string>();
  for (const item of managedWorkflows.data?.items ?? []) workflows.set(item.id, item.name);
  for (const run of runs)
    if (!workflows.has(run.workflowId))
      workflows.set(run.workflowId, run.workflowName ?? run.workflowId);
  if (workflow && !workflows.has(workflow)) workflows.set(workflow, workflow);

  return (
    <>
      <Topbar
        crumbs={[{ label: "Projects", to: "/" }, { label: project.name }]}
        actions={
          <span className="chip" title={project.path}>
            {project.kind === "git" ? (
              <FolderGit2 size={12} aria-hidden="true" />
            ) : (
              <Folder size={12} aria-hidden="true" />
            )}
            {project.kind}
          </span>
        }
      />
      <div className="content">
        <div className="page">
          <div className="page-head">
            <div className="grow">
              <h1>{project.name}</h1>
              <p className="mono">{project.path}</p>
            </div>
          </div>

          {project.missing ? <MissingProjectBanner projectName={project.name} /> : null}

          <div className="row wrap" style={{ marginTop: 16 }}>
            <button
              type="button"
              className={`chip${!archived ? " on" : ""}`}
              aria-pressed={!archived}
              onClick={() => update("archived", null)}
            >
              History
            </button>
            <button
              type="button"
              className={`chip${archived ? " on" : ""}`}
              aria-pressed={archived}
              onClick={() => update("archived", "true")}
            >
              Archived
            </button>
            {workflow && !archived ? (
              <WorkspaceActions projectId={pid} workflowId={workflow} />
            ) : null}
          </div>
          <div className="row wrap filters" style={{ marginTop: 16 }}>
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`chip${(status ?? "all") === filter.value ? " on" : ""}`}
                onClick={() => update("status", filter.value === "all" ? null : filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {workflows.size > 0 ? (
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <span className="faint">Workflow</span>
              <select
                className="input"
                style={{ width: 240 }}
                value={workflow ?? ""}
                aria-label="Filter by workflow"
                onChange={(event) => update("workflow", event.target.value || null)}
              >
                <option value="">All workflows</option>
                {[...workflows].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              {workflow ? (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => update("workflow", null)}
                >
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}

          {runsQuery.isPending ? (
            <div className="card">
              <LoadingState label="Loading runs…" />
            </div>
          ) : runsQuery.error ? (
            <NetworkError
              message={classifyError(runsQuery.error).message}
              onRetry={() => void runsQuery.refetch()}
            />
          ) : runs.length === 0 ? (
            <div className="card">
              <EmptyState
                title="No runs match"
                message="Start a workflow from the DevChestra CLI, or clear the filters."
              />
            </div>
          ) : (
            <div className="card">
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Cost</th>
                    <th>Tokens</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="click">
                      <td>
                        <Link
                          to={`/p/${pid}/r/${run.id}`}
                          className="row"
                          style={{ gap: 6, fontWeight: 600 }}
                        >
                          <PlayCircle size={14} aria-hidden="true" />#{run.runNumber}
                        </Link>
                      </td>
                      <td>{run.workflowName ?? run.workflowId}</td>
                      <td>
                        <StatusPill status={run.status} />
                      </td>
                      <td className="muted">{formatTime(run.startedAt ?? run.createdAt)}</td>
                      <td>{formatCost(run.costUsd)}</td>
                      <td className="muted">{run.tokens.toLocaleString()}</td>
                      <td>
                        <WorkspaceActions projectId={pid} run={run} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runsQuery.hasNextPage ? (
                <div className="row" style={{ padding: 12, justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={runsQuery.isFetchingNextPage}
                    onClick={() => void runsQuery.fetchNextPage()}
                  >
                    <History size={13} aria-hidden="true" />
                    {runsQuery.isFetchingNextPage ? "Loading…" : "Load more runs"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
