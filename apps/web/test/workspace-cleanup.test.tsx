import type { BootstrapResponse, RunSummary } from "@devchestra/api";
import type { RunId } from "@devchestra/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api/client.js";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import { ProjectRunsPage } from "../src/pages/ProjectRunsPage.js";
import { WorkflowsPage } from "../src/pages/WorkflowsPage.js";
import { Sidebar } from "../src/shell/Sidebar.js";
import { WorkspaceActions } from "../src/ui/WorkspaceActions.js";

const bootstrap: BootstrapResponse = {
  version: "1",
  instanceId: "test",
  projects: [
    { id: "p1", name: "Project", path: "/project", kind: "git", missing: false, addedAt: 0 },
  ],
  counts: { runs: 2, activeRuns: 1, inbox: 0 },
  providers: [],
  clis: [],
  settings: { server: { port: 4821 }, defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 } },
};
const run: RunSummary = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId,
  projectId: "p1",
  projectName: "Project",
  workflowId: "wf",
  workflowName: "Workflow",
  runNumber: 7,
  kind: "run",
  status: "succeeded",
  createdAt: 0,
  startedAt: null,
  endedAt: 1,
  pauseReason: null,
  costUsd: 0,
  tokens: 0,
  activeMs: 0,
};
afterEach(() => vi.restoreAllMocks());
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}
function mount(content: React.ReactNode, path = "/p/p1/workflows") {
  vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap);
  if (!vi.isMockFunction(api.listRuns)) vi.spyOn(api, "listRuns").mockResolvedValue({ items: [], nextCursor: null });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        {content}
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("workspace navigation and cleanup", () => {
  it("bounds sidebar workflow loading and links to the complete project list", async () => {
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue({
      document: { version: 1, groups: [], memberships: {} },
      etag: "a".repeat(64),
    });
    vi.spyOn(api, "projectRunSummaries").mockResolvedValue({ items: [], nextCursor: null });
    const list = vi.spyOn(workflowApi, "list").mockResolvedValue({
      items: [
        {
          id: "wf",
          name: "Workflow",
          description: null,
          relativeFile: "wf.json",
          etag: "etag",
          updatedAt: 0,
        },
      ],
      nextCursor: "next-page",
    });
    mount(<Sidebar />);
    const link = await screen.findByRole("link", { name: "View all workflows" });
    expect(link).toHaveAttribute("href", "/p/p1/workflows");
    expect(screen.queryByRole("region", { name: "Currently running" })).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      "p1",
      { limit: 200 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("keeps the project page complete while the sidebar uses a bounded cache", async () => {
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue({
      document: { version: 1, groups: [], memberships: {} },
      etag: "a".repeat(64),
    });
    vi.spyOn(api, "projectRunSummaries").mockResolvedValue({ items: [], nextCursor: null });
    const list = vi.spyOn(workflowApi, "list").mockImplementation(async (_project, query) => ({
      items: [
        {
          id: query?.cursor ? "second" : "first",
          name: query?.cursor ? "Second" : "First",
          description: null,
          relativeFile: "workflow.json",
          etag: "etag",
          updatedAt: 0,
        },
      ],
      nextCursor: query?.cursor ? null : "next-page",
    }));
    mount(
      <>
        <Sidebar />
        <Routes>
          <Route path="/p/:pid/workflows" element={<WorkflowsPage />} />
        </Routes>
      </>,
    );
    expect(await screen.findByTestId("workflow-row-second")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "View all workflows" })).toBeInTheDocument();
    expect(list.mock.calls.filter((call) => call[1]?.cursor === "next-page")).toHaveLength(1);
  });

  it("shows grouped workflows and their runs under a collapsible group", async () => {
    const id = "grp_0123456789abcdef01234567";
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue({
      document: { version: 1, groups: [{ id, name: "PR Review" }], memberships: { wf: id } },
      etag: "a".repeat(64),
    });
    vi.spyOn(api, "projectRunSummaries").mockResolvedValue({ items: [run], nextCursor: null });
    vi.spyOn(workflowApi, "list").mockResolvedValue({
      items: [
        {
          id: "wf",
          name: "Workflow",
          description: null,
          relativeFile: "wf.json",
          etag: "etag",
          updatedAt: 0,
        },
      ],
      nextCursor: null,
    });
    mount(<Sidebar />);
    const group = await screen.findByRole("button", { name: "Toggle PR Review" });
    expect(screen.getByRole("button", { name: "Toggle Workflow" })).toBeVisible();
    fireEvent.click(group);
    expect(screen.queryByRole("button", { name: "Toggle Workflow" })).toBeNull();
    fireEvent.click(group);
    fireEvent.click(screen.getByRole("button", { name: "Toggle Workflow" }));
    expect(await screen.findByRole("link", { name: /Run #7/ })).toBeVisible();
  });
  it("shows active workflows and distinguishes their runs from completed runs", async () => {
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue({ document: { version: 1, groups: [], memberships: {} }, etag: "a".repeat(64) });
    vi.spyOn(api, "projectRunSummaries").mockResolvedValue({ items: [{ ...run, id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as RunId, runNumber: 8, status: "running" }, run], nextCursor: null });
    vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [{ id: "wf", name: "Workflow", description: null, relativeFile: "wf.json", etag: "etag", updatedAt: 0 }], nextCursor: null });
    mount(<Sidebar />);
    expect(await screen.findByRole("link", { name: /Workflow — 1 active run/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Toggle Workflow" }));
    expect(within(screen.getByRole("link", { name: /Run #8/ })).getByRole("img", { name: "Running" })).toBeVisible();
    expect(within(screen.getByRole("link", { name: /Run #7/ })).getByRole("img", { name: "Succeeded" })).toBeVisible();
  });
  it("shows running runs above projects", async () => {
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue({ document: { version: 1, groups: [], memberships: {} }, etag: "a".repeat(64) });
    vi.spyOn(api, "projectRunSummaries").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "listRuns").mockResolvedValue({ items: [{ ...run, status: "running" }], nextCursor: null });
    const view = mount(<Sidebar />);
    const section = await screen.findByRole("region", { name: "Currently running" });
    expect(within(section).getByRole("link", { name: /Workflow.*Project.*Run #7/ })).toHaveAttribute("href", `/p/p1/r/${run.id}`);
    view.unmount();
  });
  it("uses independent summaries and separates accessible disclosures/actions from links", async () => {
    const global = vi.spyOn(api, "listRuns");
    const summaries = vi
      .spyOn(api, "projectRunSummaries")
      .mockResolvedValue({ items: [run], nextCursor: null });
    vi.spyOn(workflowApi, "list").mockResolvedValue({
      items: [
        {
          id: "wf",
          name: "Workflow",
          description: null,
          relativeFile: "wf.json",
          etag: "etag",
          updatedAt: 0,
        },
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    const rendered = mount(<Sidebar />);
    await screen.findByRole("button", { name: "Toggle Workflow" });
    expect(summaries).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(global).toHaveBeenCalledWith({ status: "running", limit: 100 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(rendered.container.querySelector("a button, a summary")).toBeNull();
    // Projects open by default; workflows open only when the user asks.
    expect(screen.getByRole("button", { name: "Toggle Project" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const toggle = screen.getByRole("button", { name: "Toggle Workflow" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Run #7/ })).toBeNull();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("link", { name: /Run #7/ })).toBeInTheDocument();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "View all runs" })).toHaveAttribute(
      "href",
      "/p/p1/runs?workflow=wf",
    );
    const actions = screen.getByText("⋯", { selector: 'summary[aria-label="Actions for run #7"]' });
    fireEvent.click(actions);
    fireEvent.keyDown(actions, { key: "Escape" });
    expect(actions.closest("details")).not.toHaveAttribute("open");
  });

  it("explains failed active-run removal and redirects after successful removal", async () => {
    const remove = vi
      .spyOn(api, "removeProject")
      .mockRejectedValueOnce(new ApiError("E_CONFLICT", "Finish active runs first.", 409, null));
    mount(<WorkspaceActions projectId="p1" />);
    fireEvent.click(screen.getByText("Remove from workspace", { selector: "button" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Repository files and run history are preserved");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Finish active runs first");
    expect(screen.getByTestId("location")).toHaveTextContent("/p/p1/workflows");
    remove.mockResolvedValue({ ok: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });

  it("filters archived history, restores runs, and scopes pagination to the filter", async () => {
    vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [], nextCursor: null });
    const list = vi.spyOn(api, "listRuns").mockImplementation(async (query) => ({
      items: query?.cursor ? [] : [{ ...run, archivedAt: query?.archived === "true" ? 123 : null }],
      nextCursor: query?.cursor ? null : "next",
    }));
    const restore = vi.spyOn(api, "setRunArchived").mockResolvedValue({ ok: true });
    mount(
      <Routes>
        <Route path="/p/:pid/runs" element={<ProjectRunsPage />} />
      </Routes>,
      "/p/p1/runs",
    );
    await screen.findByRole("link", { name: "#7" });
    const projectSections = screen.getByRole("navigation", { name: "Project sections" });
    expect(within(projectSections).getByRole("link", { name: "Workflows" })).toHaveAttribute(
      "href",
      "/p/p1/workflows",
    );
    expect(within(projectSections).getByRole("link", { name: "Runs" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ archived: "true" }),
        expect.anything(),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load more runs" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ archived: "true", cursor: "next" }),
        expect.anything(),
      ),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Restore run", hidden: true })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(run.id, false));
  });

  it("disables archiving for active runs", () => {
    mount(<WorkspaceActions projectId="p1" run={{ ...run, status: "paused" }} />);
    expect(screen.getByRole("button", { name: "Archive run", hidden: true })).toBeDisabled();
    expect(screen.getByText("Active runs cannot be archived.")).toBeInTheDocument();
  });
});
