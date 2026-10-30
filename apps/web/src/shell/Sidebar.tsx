import { useQueries } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  Layers3,
  Settings,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, classifyError } from "../api/client.js";
import { queryKeys, useBootstrap } from "../api/hooks.js";
import type { RunSummary } from "../api/types.js";
import { workflowApi } from "../editor/api/workflowApi.js";
import { statusLabel } from "../ui/StatusPill.js";
import { WorkspaceActions } from "../ui/WorkspaceActions.js";

interface WorkflowNav {
  id: string;
  name: string;
  managed: boolean;
  runs: RunSummary[];
}

function SettingsMenu() {
  const menu = useRef<HTMLDetailsElement>(null);
  const location = useLocation();
  const match = location.pathname.match(/^\/p\/([^/]+)/);
  const usagePath = match ? `/p/${match[1]}/settings/usage` : "/settings/usage";
  const active = location.pathname.endsWith("/settings/usage");
  return (
    <details
      className="workspace-menu workspace-menu-up"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current) {
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label="Settings">
        <Settings size={15} aria-hidden="true" />
      </summary>
      <div className="workspace-menu-items">
        <Link
          to={usagePath}
          aria-current={active ? "page" : undefined}
          onClick={() => {
            if (menu.current) menu.current.open = false;
          }}
        >
          Usage
        </Link>
      </div>
    </details>
  );
}

export function Sidebar() {
  const location = useLocation();
  const bootstrap = useBootstrap();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
  const runQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: [...queryKeys.runsFor(project.id), "sidebar-summaries"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.projectRunSummaries(project.id, { signal }),
      staleTime: 5_000,
    })),
  });
  const disclosure = (key: string, label: string) => (
    <button
      type="button"
      className="nav-disclosure"
      aria-label={`Toggle ${label}`}
      aria-expanded={!collapsed.has(key)}
      aria-controls={`nav-${key}`}
      onClick={() => toggle(key)}
    >
      {collapsed.has(key) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
    </button>
  );
  return (
    <aside className="sidebar" aria-label="Projects, workflows and runs">
      <div className="sidebar-top">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            R
          </span>
          <span>DevChestra</span>
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
          <p aria-busy="true" className="faint">
            Loading projects…
          </p>
        ) : null}
        {failure ? (
          <div className="note" role="status">
            <Activity size={14} />
            <span>
              {failure.kind === "auth"
                ? "Open DevChestra from your terminal."
                : "Server unavailable."}
            </span>
          </div>
        ) : null}
        {bootstrap.data?.projects.length === 0 ? (
          <p className="faint">No projects registered.</p>
        ) : null}
        {projects.map((project, index) => {
          const projectPath = `/p/${project.id}/workflows`;
          const workflows = new Map<string, WorkflowNav>();
          for (const item of workflowQueries[index]?.data?.items ?? [])
            workflows.set(item.id, { id: item.id, name: item.name, managed: true, runs: [] });
          for (const run of runQueries[index]?.data?.items ?? []) {
            const workflow = workflows.get(run.workflowId) ?? {
              id: run.workflowId,
              name: run.workflowName ?? run.workflowId,
              managed: false,
              runs: [],
            };
            workflow.runs.push(run);
            workflows.set(workflow.id, workflow);
          }
          return (
            <div key={project.id} className="nav-project">
              <div className="nav-tree-row nav-project-row">
                {disclosure(project.id, project.name)}
                <Link
                  to={projectPath}
                  className={`nav-item${location.pathname === projectPath ? " active" : ""}`}
                  aria-current={location.pathname === projectPath ? "page" : undefined}
                  title={project.path}
                >
                  {project.kind === "git" ? (
                    <FolderGit2 size={15} aria-hidden="true" />
                  ) : (
                    <Folder size={15} aria-hidden="true" />
                  )}
                  <span className="nm">{project.name}</span>
                  {project.missing ? <span className="sub">missing</span> : null}
                </Link>
                <WorkspaceActions projectId={project.id} name={project.name} />
              </div>
              <div id={`nav-${project.id}`} hidden={collapsed.has(project.id)} className="nav-kids">
                {runQueries[index]?.error ? (
                  <p role="status" className="faint">
                    Run history unavailable.{" "}
                    <button type="button" onClick={() => void runQueries[index]?.refetch()}>
                      Retry
                    </button>
                  </p>
                ) : null}
                {[...workflows.values()]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((workflow) => {
                    const key = `${project.id}-${workflow.id}`;
                    const editorPath = `/p/${project.id}/w/${workflow.id}`;
                    const historyPath = `/p/${project.id}/runs?workflow=${encodeURIComponent(workflow.id)}`;
                    const selected = workflow.managed
                      ? location.pathname === editorPath
                      : location.pathname + location.search === historyPath;
                    return (
                      <div key={workflow.id}>
                        <div className="nav-tree-row nav-workflow-row">
                          {disclosure(key, workflow.name)}
                          <Link
                            to={workflow.managed ? editorPath : historyPath}
                            className={`nav-item${selected ? " active" : ""}`}
                            aria-current={selected ? "page" : undefined}
                            title={
                              workflow.managed
                                ? `Open workflow editor: ${workflow.name}`
                                : `${workflow.name} — history only`
                            }
                            aria-label={
                              workflow.managed
                                ? `Open workflow editor: ${workflow.name}`
                                : undefined
                            }
                          >
                            <GitBranch size={13} aria-hidden="true" />
                            <span className="nm">{workflow.name}</span>
                          </Link>
                          <WorkspaceActions
                            projectId={project.id}
                            workflowId={workflow.id}
                            name={workflow.name}
                          />
                        </div>
                        <div
                          className="nav-run-group"
                          id={`nav-${key}`}
                          hidden={collapsed.has(key)}
                        >
                          {workflow.runs.map((run) => {
                            const runPath = `/p/${project.id}/r/${run.id}`;
                            const selectedRun =
                              location.pathname === runPath ||
                              location.pathname.startsWith(`${runPath}/`);
                            return (
                              <div className="nav-tree-row nav-run-row" key={run.id}>
                                <Link
                                  to={runPath}
                                  className={`nav-item${selectedRun ? " active" : ""}`}
                                  aria-current={selectedRun ? "page" : undefined}
                                  title={`Run #${run.runNumber} — ${statusLabel(run.status)}`}
                                >
                                  <span aria-hidden="true">↳</span>
                                  <span className="nm">Run #{run.runNumber}</span>
                                  <span
                                    className={`status-icon ${run.status}`}
                                    role="img"
                                    aria-label={statusLabel(run.status)}
                                  >
                                    ●
                                  </span>
                                </Link>
                                <WorkspaceActions projectId={project.id} run={run} />
                              </div>
                            );
                          })}
                          <Link className="nav-item nav-view-all" to={historyPath}>
                            View all runs
                          </Link>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <span className={`status-icon ${bootstrap.data ? "succeeded" : "idle"}`} aria-hidden="true">
          ●
        </span>
        <span style={{ flex: 1 }}>
          {bootstrap.data
            ? `DevChestra ${bootstrap.data.version} · ${bootstrap.data.counts.activeRuns} active`
            : "Not connected"}
        </span>
        <SettingsMenu />
      </div>
    </aside>
  );
}
