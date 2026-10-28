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
    await screen.findByRole("link", { name: /Run #7/ });
    expect(summaries).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(global).not.toHaveBeenCalled();
    expect(rendered.container.querySelector("a button, a summary")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Toggle Workflow" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Run #7/ })).toBeNull();
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
