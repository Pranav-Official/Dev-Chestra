import { useQueries } from "@tanstack/react-query";
import { Activity, Folder, FolderGit2, GitBranch, History, Layers3, Workflow } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { queryKeys, useAllRuns, useBootstrap } from "../api/hooks.js";
import type { RunSummary } from "../api/types.js";
import { workflowApi } from "../editor/api/workflowApi.js";
import { statusLabel } from "../ui/StatusPill.js";

function active(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

interface WorkflowNav {
  id: string;
  name: string;
  managed: boolean;
  runs: RunSummary[];
}

function buildWorkflows(
  projectId: string,
  runs: RunSummary[],
  names: Map<string, string>,
): WorkflowNav[] {
  const map = new Map<string, WorkflowNav>();
  for (const [id, name] of names) {
    map.set(id, { id, name, managed: true, runs: [] });
  }
  for (const run of runs) {
    if (run.projectId !== projectId) continue;
    const existing = map.get(run.workflowId) ?? {
      id: run.workflowId,
      name: run.workflowName ?? run.workflowId,
      managed: false,
      runs: [],
    };
    existing.runs.push(run);
    map.set(run.workflowId, existing);
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function Sidebar() {
  const location = useLocation();
  const bootstrap = useBootstrap();
  const runsQuery = useAllRuns();
  const runs = runsQuery.data?.items ?? [];
  const failure = bootstrap.error ? classifyError(bootstrap.error) : null;
  const projects = bootstrap.data?.projects ?? [];
  const workflowQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.workflows(project.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        workflowApi.list(project.id, { limit: 200 }, { signal }),
      enabled: !project.missing,
      staleTime: 5_000,
      retry: false as const,
    })),
  });

  return (
    <aside className="sidebar" aria-label="Projects, workflows and runs">
      <div className="sidebar-top">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            R
          </span>
          <span>Relay</span>
        </div>
        <Link
          to="/"
          className={`nav-item${location.pathname === "/" ? " active" : ""}`}
          aria-current={location.pathname === "/" ? "page" : undefined}
        >
          <Layers3 size={15} aria-hidden="true" />
          <span>Projects</span>
          {bootstrap.data ? <span className="sub">{bootstrap.data.counts.runs} runs</span> : null}
        </Link>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-sec">Projects</div>
        {bootstrap.isPending ? (
          <div className="col" style={{ padding: "4px 8px" }} aria-busy="true">
            <div className="skeleton" style={{ width: "80%" }} />
            <div className="skeleton" style={{ width: "64%" }} />
            <div className="skeleton" style={{ width: "72%" }} />
          </div>
        ) : null}
        {failure ? (
          <div className="note" style={{ margin: "4px 4px 8px" }} role="status">
            <Activity size={14} aria-hidden="true" />
            <span>
              {failure.kind === "auth" ? "Open Relay from your terminal." : "Server unavailable."}
            </span>
          </div>
        ) : null}
        {bootstrap.data?.projects.length === 0 ? (
          <p className="faint" style={{ padding: "4px 8px" }}>
            No projects registered.
          </p>
        ) : null}
        {projects.map((project, index) => {
          const projectPath = `/p/${project.id}/workflows`;
          const projectRuns = runs.filter((run) => run.projectId === project.id);
          const names = new Map<string, string>();
          const queryItems = workflowQueries[index]?.data?.items ?? [];
          for (const item of queryItems) names.set(item.id, item.name);
          const workflows = buildWorkflows(project.id, projectRuns, names);
          return (
            <div key={project.id} style={{ marginBottom: 6 }}>
              <Link
                to={projectPath}
                className={`nav-item${active(location.pathname, `/p/${project.id}`) ? " active" : ""}`}
                title={`${project.path} — open workflows`}
              >
                {project.kind === "git" ? (
                  <FolderGit2 size={15} aria-hidden="true" />
                ) : (
                  <Folder size={15} aria-hidden="true" />
                )}
                <span className="nm">{project.name}</span>
                {project.missing ? <span className="sub">missing</span> : null}
              </Link>
              {workflows.length > 0 ? (
                <div className="nav-kids">
                  {workflows.map((workflow) => {
                    const editorPath = `/p/${project.id}/w/${workflow.id}`;
                    const historyPath = `/p/${project.id}/runs?workflow=${encodeURIComponent(
                      workflow.id,
                    )}`;
                    return (
                      <div key={workflow.id}>
                        {workflow.managed ? (
                          <Link
                            to={editorPath}
                            className={`nav-item${
                              active(location.pathname, editorPath) ? " active" : ""
                            }`}
                            title={`Open workflow editor: ${workflow.name}`}
                            aria-label={`Open workflow editor: ${workflow.name}`}
                          >
                            <GitBranch size={13} aria-hidden="true" />
                            <span className="nm">{workflow.name}</span>
                            <span className="sub" title="Editor">
                              <Workflow size={11} aria-hidden="true" />
                            </span>
                          </Link>
                        ) : (
                          <Link
                            to={historyPath}
                            className="nav-item"
                            title={`${workflow.name} — past runs only; no managed workflow file`}
                          >
                            <History size={13} aria-hidden="true" />
                            <span className="nm">{workflow.name}</span>
                            <span className="sub">history</span>
                          </Link>
                        )}
                        {workflow.runs.slice(0, 3).map((run) => {
                          const runPath = `/p/${project.id}/r/${run.id}`;
                          return (
                            <Link
                              key={run.id}
                              to={runPath}
                              className={`nav-item${active(location.pathname, runPath) ? " active" : ""}`}
                              title={`Open run #${run.runNumber} — ${statusLabel(run.status)}`}
                            >
                              <History size={12} aria-hidden="true" />
                              <span className="nm">Run #{run.runNumber}</span>
                              <span className="sub">{statusLabel(run.status)}</span>
                            </Link>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <span className={`status-icon ${bootstrap.data ? "succeeded" : "idle"}`} aria-hidden="true">
          ●
        </span>
        <span>
          {bootstrap.data
            ? `Relay ${bootstrap.data.version} · ${bootstrap.data.counts.activeRuns} active`
            : "Not connected"}
        </span>
      </div>
    </aside>
  );
}
