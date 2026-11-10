import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Folder,
  FolderGit2,
  GitBranch,
  Layers3,
  LoaderCircle,
  PauseCircle,
  Settings,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import brandMark from "../../../../assets/images/base-logo.svg";
import brandWordmark from "../../../../assets/images/base-logo-type.svg";
import { api, classifyError } from "../api/client.js";
import { queryKeys, useBootstrap } from "../api/hooks.js";
import type { RunSummary } from "../api/types.js";
import { workflowApi } from "../editor/api/workflowApi.js";
import { SETTINGS_SECTIONS, settingsPath } from "../pages/settings/sections.js";
import { statusLabel } from "../ui/StatusPill.js";
import { WorkspaceActions } from "../ui/WorkspaceActions.js";
import { GithubMark, REPO_URL, StarNudge } from "./StarNudge.js";

interface WorkflowNav {
  id: string;
  name: string;
  managed: boolean;
  runs: RunSummary[];
}

function RunIndicator({ status }: { status: string }) {
  const label = statusLabel(status);
  const active = status === "running" || status === "validating";
  const Icon = active
    ? LoaderCircle
    : status === "succeeded"
      ? CheckCircle2
      : status === "paused"
        ? PauseCircle
        : status === "waiting_approval"
          ? ShieldQuestion
          : status === "waiting_quota" || status === "queued"
            ? Clock3
            : ["failed", "rejected", "error", "interrupted"].includes(status)
              ? TriangleAlert
              : status === "cancelled"
                ? Ban
                : Circle;
  return (
    <span
      className={`nav-run-status nav-status-${status}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon size={14} className={active ? "nav-status-spin" : undefined} aria-hidden="true" />
    </span>
  );
}

function SettingsLink() {
  const location = useLocation();
  const pid = location.pathname.match(/^\/p\/([^/]+)/)?.[1];
  const active = /\/settings(\/|$)/.test(location.pathname);
  return (
    <Link
      className={`sidebar-settings${active ? " active" : ""}`}
      to={settingsPath(pid, SETTINGS_SECTIONS[0].id)}
      aria-label="Settings"
      title="Settings"
      aria-current={active ? "page" : undefined}
    >
      <Settings size={15} aria-hidden="true" />
    </Link>
  );
}

export function Sidebar() {
  const location = useLocation();
  const bootstrap = useBootstrap();
  // Projects start expanded, so `collapsed` lists the ones the user closed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Workflows start collapsed, so `openWorkflows` lists the ones the user opened.
  const [openWorkflows, setOpenWorkflows] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleWorkflow = (key: string) =>
    setOpenWorkflows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setClosedGroups((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const failure = bootstrap.error ? classifyError(bootstrap.error) : null;
  const projects = bootstrap.data?.projects ?? [];
  const workflowQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.sidebarWorkflows(project.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        workflowApi.list(project.id, { limit: 200 }, { signal }),
      enabled: !project.missing,
      staleTime: 5_000,
      retry: false as const,
    })),
  });
  const groupQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.groups(project.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.getWorkflowGroups(project.id, { signal }),
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
  const activeRuns = useQuery({
    queryKey: [...queryKeys.runs, "sidebar-active"],
    queryFn: async ({ signal }) => {
      const items: RunSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listRuns(
          { status: "running", limit: 100, ...(cursor ? { cursor } : {}) },
          { signal },
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    staleTime: 5_000,
    retry: false,
  });
  const disclosure = (label: string, expanded: boolean, controls: string, onToggle: () => void) => (
    <button
      type="button"
      className="nav-disclosure"
      aria-label={`Toggle ${label}`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
  );
  return (
    <aside className="sidebar" aria-label="Projects, workflows and runs">
      <div className="sidebar-top">
        <div className="brand" role="img" aria-label="DevChestra">
          <img className="brand-mark" src={brandMark} alt="" />
          <img className="brand-wordmark" src={brandWordmark} alt="" />
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
        {activeRuns.data && activeRuns.data.length > 0 ? (
          <section className="sidebar-active-runs" aria-label="Currently running">
            <div className="nav-sec sidebar-active-heading">
              Currently running <span>{activeRuns.data.length}</span>
            </div>
            {activeRuns.data.map((run) => {
              const runPath = `/p/${run.projectId}/r/${run.id}`;
              const selected =
                location.pathname === runPath || location.pathname.startsWith(`${runPath}/`);
              return (
                <Link
                  key={run.id}
                  to={runPath}
                  className={`sidebar-active-run${selected ? " active" : ""}`}
                  aria-current={selected ? "page" : undefined}
                >
                  <LoaderCircle size={15} className="nav-status-spin" aria-hidden="true" />
                  <span className="sidebar-active-copy">
                    <span className="sidebar-active-name">
                      {run.workflowName ?? run.workflowId}
                    </span>
                    <span className="sidebar-active-detail">
                      {run.projectName} · Run #{run.runNumber}
                    </span>
                  </span>
                </Link>
              );
            })}
          </section>
        ) : null}
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
                {disclosure(project.name, !collapsed.has(project.id), `nav-${project.id}`, () =>
                  toggle(project.id),
                )}
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
                {groupQueries[index]?.isError ? (
                  <p role="status" className="faint">
                    Groups unavailable.{" "}
                    <button type="button" onClick={() => void groupQueries[index]?.refetch()}>
                      Retry
                    </button>
                  </p>
                ) : null}
                {[
                  ...(groupQueries[index]?.data?.document.groups ?? [])
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name)),
                  { id: "", name: "Ungrouped" },
                ].map((group) => {
                  const key = `${project.id}:${group.id}`;
                  const members = [...workflows.values()]
                    .filter((workflow) => {
                      const membership = workflow.managed
                        ? groupQueries[index]?.data?.document.memberships[workflow.id]
                        : undefined;
                      const valid = (groupQueries[index]?.data?.document.groups ?? []).some(
                        (g) => g.id === membership,
                      );
                      return (valid ? membership : "") === group.id;
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <div key={group.id || "ungrouped"}>
                      {group.id ? (
                        <div className="nav-tree-row nav-project-row">
                          {disclosure(group.name, !closedGroups.has(key), `nav-group-${key}`, () =>
                            toggleGroup(key),
                          )}
                          <span className="nav-item">
                            <Folder size={15} aria-hidden="true" />
                            <span className="nm">{group.name}</span>
                          </span>
                        </div>
                      ) : null}
                      <div
                        id={`nav-group-${key}`}
                        className={group.id ? "nav-kids" : undefined}
                        hidden={group.id !== "" && closedGroups.has(key)}
                      >
                        {members.map((workflow) => {
                          const key = `${project.id}-${workflow.id}`;
                          const editorPath = `/p/${project.id}/w/${workflow.id}`;
                          const historyPath = `/p/${project.id}/runs?workflow=${encodeURIComponent(workflow.id)}`;
                          const expanded = openWorkflows.has(key);
                          const activeRuns = workflow.runs.filter(
                            (run) => run.status === "running",
                          );
                          const selected = workflow.managed
                            ? location.pathname === editorPath
                            : location.pathname + location.search === historyPath;
                          return (
                            <div key={workflow.id}>
                              <div className="nav-tree-row nav-workflow-row">
                                {disclosure(workflow.name, expanded, `nav-${key}`, () =>
                                  toggleWorkflow(key),
                                )}
                                <Link
                                  to={workflow.managed ? editorPath : historyPath}
                                  className={`nav-item${selected ? " active" : ""}`}
                                  aria-current={selected ? "page" : undefined}
                                  title={
                                    workflow.managed
                                      ? `Open workflow editor: ${workflow.name}`
                                      : workflowQueries[index]?.data?.nextCursor
                                        ? `${workflow.name} — run history`
                                        : `${workflow.name} — history only`
                                  }
                                  aria-label={
                                    workflow.managed
                                      ? `Open workflow editor: ${workflow.name}${activeRuns.length ? ` — ${activeRuns.length} active ${activeRuns.length === 1 ? "run" : "runs"}` : ""}`
                                      : activeRuns.length
                                        ? `${workflow.name} — ${activeRuns.length} active ${activeRuns.length === 1 ? "run" : "runs"}`
                                        : undefined
                                  }
                                >
                                  <GitBranch size={13} aria-hidden="true" />
                                  <span className="nm">{workflow.name}</span>
                                  {activeRuns.length > 0 ? (
                                    <span
                                      className="nav-workflow-active"
                                      role="status"
                                      title={`${activeRuns.length} active ${activeRuns.length === 1 ? "run" : "runs"}`}
                                      aria-label={`${activeRuns.length} active ${activeRuns.length === 1 ? "run" : "runs"}`}
                                    >
                                      <LoaderCircle
                                        size={14}
                                        className="nav-status-spin"
                                        aria-hidden="true"
                                      />
                                      {activeRuns.length > 1 ? (
                                        <span>{activeRuns.length}</span>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </Link>
                                <WorkspaceActions
                                  projectId={project.id}
                                  workflowId={workflow.id}
                                  name={workflow.name}
                                />
                              </div>
                              <div className="nav-run-group" id={`nav-${key}`} hidden={!expanded}>
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
                                        <RunIndicator status={run.status} />
                                        <span className="nm">Run #{run.runNumber}</span>
                                        <span className="nav-run-label">
                                          {statusLabel(run.status)}
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
                {workflowQueries[index]?.data?.nextCursor ? (
                  <Link className="nav-item nav-view-all" to={projectPath}>
                    View all workflows
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </nav>
      <StarNudge />
      <div className="sidebar-foot">
        <span className={`status-icon ${bootstrap.data ? "succeeded" : "idle"}`} aria-hidden="true">
          ●
        </span>
        <span style={{ flex: 1 }}>
          {bootstrap.data
            ? `DevChestra ${bootstrap.data.version} · ${bootstrap.data.counts.activeRuns} active`
            : "Not connected"}
        </span>
        <a
          className="sidebar-settings"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="DevChestra on GitHub"
          title="DevChestra on GitHub"
        >
          <GithubMark />
        </a>
        <SettingsLink />
      </div>
    </aside>
  );
}
