import type {
  BootstrapResponse,
  ProjectView,
  WorkflowDocumentResponse,
  WorkflowListItem,
} from "@devchestra/api";
import type { ValidationReport, WorkflowFile } from "@devchestra/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import { AddProjectDialog } from "../src/editor/controls/AddProjectDialog.js";
import { WorkflowsPage } from "../src/pages/WorkflowsPage.js";

const PROJECT: ProjectView = {
  id: "p1",
  name: "Demo project",
  path: "/tmp/demo",
  kind: "folder",
  missing: false,
  addedAt: 1,
};

const REPORT: ValidationReport = {
  ok: true,
  errors: [],
  warnings: [],
  requires: {
    clis: [],
    networkNodes: [],
    shellCommands: [],
    projectWriteNodes: [],
    worktreeNodes: [],
    providers: [],
    envVars: [],
    irreversibleApprovals: [],
    budget: {},
  },
};

const WORKFLOW: WorkflowFile = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ],
    edges: [{ id: "e1", from: "start", to: "end" }],
  },
};

function documentFor(id = "demo", etag = '"e1"'): WorkflowDocumentResponse {
  return {
    workflow: { ...WORKFLOW, id, name: id === "demo" ? "Demo" : "Fresh" },
    text: "{}",
    etag,
    relativeFile: `${id}.json`,
    validation: REPORT,
  };
}

const ITEM: WorkflowListItem = {
  id: "demo",
  name: "Demo",
  description: null,
  relativeFile: "demo.json",
  etag: '"e1"',
  updatedAt: 1,
  validationSummary: { ok: true, errors: 0, warnings: 0 },
};

function bootstrap(projects: ProjectView[] = [PROJECT]): BootstrapResponse {
  return {
    version: "0.1.0",
    instanceId: "test",
    projects,
    counts: { runs: 0, activeRuns: 0, inbox: 0 },
    providers: [],
    clis: [],
    settings: {} as BootstrapResponse["settings"],
  };
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWorkflows(queryClient = client()) {
  const router = createMemoryRouter(
    [
      { path: "/p/:pid/workflows", element: <WorkflowsPage /> },
      { path: "/p/:pid/w/:wid", element: <div data-testid="editor-target" /> },
    ],
    { initialEntries: ["/p/p1/workflows"] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkflowsPage", () => {
  it("creates a group and moves a workflow into it", async () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap());
    vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [ITEM], nextCursor: null });
    const initial = {
      document: { version: 1 as const, groups: [], memberships: {} },
      etag: "a".repeat(64),
    };
    vi.spyOn(api, "getWorkflowGroups").mockResolvedValue(initial);
    const save = vi
      .spyOn(api, "saveWorkflowGroups")
      .mockImplementation(async (_project, document) => ({ document, etag: "b".repeat(64) }));
    renderWorkflows();
    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "PR Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("PR Review (0)");
    const select = screen.getByRole("combobox", { name: "Group for demo" });
    const groupId = save.mock.calls[0]?.[1].groups[0]?.id;
    expect(groupId).toBeDefined();
    fireEvent.change(select, { target: { value: groupId } });
    await screen.findByText("PR Review (1)");
    expect(save.mock.calls[1]?.[1].memberships.demo).toBe(groupId);
  });
  it("creates a blank workflow from the fresh-project empty state and opens the editor", async () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap());
    vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [], nextCursor: null });
    const create = vi.spyOn(workflowApi, "create").mockResolvedValue(documentFor("fresh"));

    renderWorkflows();
    expect(await screen.findByText("No workflows yet")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "New workflow" })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(await screen.findByTestId("editor-target")).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith("p1", { name: "Fresh", template: "blank" });
  });

  it("deletes with the listed ETag", async () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap());
    vi.spyOn(workflowApi, "list")
      .mockResolvedValueOnce({ items: [ITEM], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    const remove = vi.spyOn(workflowApi, "remove").mockResolvedValue();

    renderWorkflows();
    expect(await screen.findByTestId("workflow-row-demo")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Actions for Demo"));
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "demo", '"e1"'));
    await waitFor(() => expect(screen.queryByTestId("workflow-row-demo")).toBeNull());
  });

  it("shows the missing-path state and disables creation until relink", async () => {
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap([{ ...PROJECT, missing: true }]));
    const list = vi.spyOn(workflowApi, "list").mockResolvedValue({ items: [], nextCursor: null });

    renderWorkflows();
    expect(await screen.findByTestId("missing-project-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relink folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New workflow" })).toBeDisabled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("AddProjectDialog", () => {
  it("tells the user registration may add the agent guide but never changes existing files", () => {
    render(
      <QueryClientProvider client={client()}>
        <AddProjectDialog open onClose={() => undefined} onRegistered={() => undefined} />
      </QueryClientProvider>,
    );
    const copy = screen.getByTestId("add-project-dialog").textContent ?? "";
    expect(copy).toContain(".devchestra/skill.md");
    expect(copy).toContain("existing files are never changed");
    expect(copy).not.toContain("does not create or modify");
  });

  it("registers an explicit absolute path and reports success", async () => {
    const register = vi.spyOn(api, "registerProject").mockResolvedValue({
      ...PROJECT,
      id: "p2",
      name: "Second",
    });
    const onRegistered = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <AddProjectDialog open onClose={() => undefined} onRegistered={onRegistered} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/tmp/second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register project" }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith("p2"));
    expect(register).toHaveBeenCalledWith({ path: "/tmp/second" });
  });

  it("shows the server error for a missing path instead of faking a folder browser", async () => {
    vi.spyOn(api, "registerProject").mockRejectedValue(new Error("Project path does not exist."));
    render(
      <QueryClientProvider client={client()}>
        <AddProjectDialog open onClose={() => undefined} onRegistered={() => undefined} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/tmp/missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register project" }));
    expect(await screen.findByTestId("project-register-error")).toHaveTextContent(
      "Project path does not exist.",
    );
  });
});
