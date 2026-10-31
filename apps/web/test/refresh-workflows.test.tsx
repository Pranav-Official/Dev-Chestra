import type { BootstrapResponse, WorkflowListResponse } from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { queryKeys } from "../src/api/hooks.js";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import { WorkspaceActions } from "../src/ui/WorkspaceActions.js";

const bootstrap: BootstrapResponse = {
  version: "1",
  instanceId: "test",
  projects: [
    { id: "p1", name: "Project", path: "/project", kind: "git", missing: false, addedAt: 0 },
  ],
  counts: { runs: 0, activeRuns: 0, inbox: 0 },
  providers: [],
  clis: [],
  settings: { server: { port: 4821 }, defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 } },
};

function list(...ids: string[]): WorkflowListResponse {
  return {
    items: ids.map((id) => ({ id, name: `Workflow ${id.toUpperCase()}` })),
    nextCursor: null,
  } as unknown as WorkflowListResponse;
}

afterEach(() => vi.restoreAllMocks());

function mount(shown: WorkflowListResponse | undefined, fresh: WorkflowListResponse) {
  vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap);
  const listSpy = vi.spyOn(workflowApi, "list").mockResolvedValue(fresh);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (shown !== undefined) client.setQueryData(queryKeys.workflows("p1"), shown);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/workflows"]}>
        <WorkspaceActions projectId="p1" name="Project" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, invalidate, listSpy };
}

function openRefresh() {
  fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
}

describe("Refresh workflows", () => {
  it("lists what was added and removed, and leaves the workspace alone until Proceed", async () => {
    const { client, invalidate } = mount(list("a", "b"), list("b", "c"));
    openRefresh();

    const added = await screen.findByRole("region", { name: "Added workflows" });
    expect(within(added).getByText("Workflow C")).toBeInTheDocument();
    expect(within(added).getByText("c.json")).toBeInTheDocument();
    const removed = screen.getByRole("region", { name: "Removed workflows" });
    expect(within(removed).getByText("Workflow A")).toBeInTheDocument();
    expect(screen.getByText("Run history for removed workflows is kept.")).toBeInTheDocument();

    expect(invalidate).not.toHaveBeenCalled();
    expect(
      client.getQueryData<WorkflowListResponse>(queryKeys.workflows("p1"))?.items,
    ).toHaveLength(2);
  });

  it("changes nothing on Cancel", async () => {
    const { client, invalidate } = mount(list("a", "b"), list("b", "c"));
    openRefresh();
    await screen.findByRole("region", { name: "Added workflows" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    const items = client.getQueryData<WorkflowListResponse>(queryKeys.workflows("p1"))?.items;
    expect(items?.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("applies the fresh list on Proceed", async () => {
    const { client, invalidate } = mount(list("a", "b"), list("b", "c"));
    openRefresh();
    await screen.findByRole("region", { name: "Added workflows" });

    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const items = client.getQueryData<WorkflowListResponse>(queryKeys.workflows("p1"))?.items;
    expect(items?.map((item) => item.id)).toEqual(["b", "c"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workflows("p1") });
  });

  it("says so when nothing changed, with no Proceed button", async () => {
    mount(list("a", "b"), list("a", "b"));
    openRefresh();
    expect(await screen.findByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proceed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("shows an error with Retry when the folder cannot be scanned", async () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap);
    vi.spyOn(workflowApi, "list").mockRejectedValue(new Error("Project path is missing"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkspaceActions projectId="p1" name="Project" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    openRefresh();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proceed" })).toBeNull();
  });
});

describe("project menu", () => {
  it("offers Refresh workflows for a project but not for a run or workflow menu", () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkspaceActions projectId="p1" workflowId="wf" name="Workflow" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Refresh workflows" })).toBeNull();
  });
});
