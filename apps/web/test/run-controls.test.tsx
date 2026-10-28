import type { ProjectWorkspacesResponse } from "@devchestra/api";
import type { RunId } from "@devchestra/core";
import type { ValidationReport, WorkflowFile } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { api } from "../src/api/client.js";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import { RunDialog } from "../src/editor/controls/RunDialog.js";

const WORKSPACES: ProjectWorkspacesResponse = {
  projectRoot: "/repos/app",
  git: true,
  worktrees: [
    {
      path: "/repos/app-reviewed",
      branch: "reviewed",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      detached: false,
    },
    {
      path: "/repos/app-detached",
      branch: null,
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      detached: true,
    },
  ],
};

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

const REPORT = {
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
} as ValidationReport;

const FILE: WorkflowFile = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  graph: {
    nodes: [
      {
        id: "start",
        type: "start",
        name: "Start",
        params: [
          { name: "flag", type: "boolean", default: false, required: false },
          { name: "count", type: "number", default: 0, required: false },
          {
            name: "mode",
            type: "enum",
            default: "fast",
            options: ["fast", "slow"],
            required: true,
          },
          { name: "note", type: "string", required: false },
          { name: "label", type: "string", default: "default label", required: false },
        ],
      },
      {
        id: "agent",
        type: "agent",
        name: "Research",
        cli: "codex",
        prompt: "Research",
        output: { type: "object" },
        permissions: { network: false, write: ["workspace"] },
        workspace: { mode: "scratch" },
      },
      {
        id: "shell",
        type: "shell",
        name: "Check",
        command: "printf hello",
        workspace: { mode: "scratch" },
      },
      {
        id: "end",
        type: "end",
        name: "End",
        status: "success",
        result: "{}",
      },
    ],
    edges: [
      { id: "e1", from: "start", to: "agent" },
      { id: "e2", from: "agent", to: "shell" },
      { id: "e3", from: "shell", to: "end" },
    ],
  },
};

function renderDialog(overrides: Partial<Parameters<typeof RunDialog>[0]> = {}) {
  const props: Parameters<typeof RunDialog>[0] = {
    open: true,
    projectId: "p1",
    workflowId: "demo",
    file: FILE,
    validation: REPORT,
    onClose: vi.fn(),
    onPrepare: async () => ({ ok: true, etag: '"e1"' }),
    onStarted: vi.fn(),
    ...overrides,
  };
  render(<RunDialog {...props} />);
  return props;
}

let listWorkspaces: MockInstance<typeof api.listProjectWorkspaces>;

beforeEach(() => {
  listWorkspaces = vi.spyOn(api, "listProjectWorkspaces");
  listWorkspaces.mockResolvedValue(WORKSPACES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunDialog", () => {
  it("preserves typed parameter defaults including false and 0", async () => {
    const start = vi
      .spyOn(workflowApi, "start")
      .mockResolvedValue({ runId: RUN_ID, duplicate: false, status: "queued" });
    const props = renderDialog();

    expect(screen.getByTestId("run-param-flag")).not.toBeChecked();
    expect(screen.getByTestId("run-param-count")).toHaveValue(0);
    expect(screen.getByTestId("run-param-mode")).toHaveValue("fast");

    fireEvent.change(screen.getByTestId("run-param-note"), {
      target: { value: "  spaced  " },
    });
    fireEvent.change(screen.getByTestId("run-param-label"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("printf hello")).toBeInTheDocument();
    expect(screen.getByText(/configured CLI account and may incur costs/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith(RUN_ID));
    expect(start).toHaveBeenCalledWith(
      "p1",
      "demo",
      {
        params: {
          flag: false,
          count: 0,
          mode: "fast",
          note: "  spaced  ",
          label: "",
        },
        etag: '"e1"',
        workspace: { mode: "project" },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("defaults to the project root and sends one workspace for every node", async () => {
    const start = vi
      .spyOn(workflowApi, "start")
      .mockResolvedValue({ runId: RUN_ID, duplicate: false, status: "queued" });
    renderDialog();

    await screen.findByTestId("run-workspace-refresh");
    expect(screen.getByTestId("run-workspace-mode-project")).toBeChecked();
    expect(screen.getByTestId("run-workspace-mode-existing")).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    const review = screen.getByTestId("run-workspace-review");
    expect(review).toHaveTextContent(/All 2 agent and shell nodes use one workspace/i);
    expect(review).toHaveTextContent(/registered project root/i);
    expect(review).toHaveTextContent(/can read and edit project files/i);
    expect(review).toHaveTextContent(/nothing is committed automatically/i);
    expect(review).toHaveTextContent(/fixed for this run and stored for resume/i);
    expect(review).not.toHaveTextContent(/historical per-node behavior/i);

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[2]).toMatchObject({
      workspace: { mode: "project" },
    });
  });

  it("loads an existing worktree and posts its canonical path", async () => {
    const start = vi
      .spyOn(workflowApi, "start")
      .mockResolvedValue({ runId: RUN_ID, duplicate: false, status: "queued" });
    renderDialog();

    const existing = await screen.findByTestId("run-workspace-mode-existing");
    await waitFor(() => expect(existing).not.toBeDisabled());
    fireEvent.click(existing);
    expect(screen.getByTestId("run-workspace-mode-existing")).toBeChecked();

    const select = screen.getByTestId("run-workspace-existing-path");
    fireEvent.change(select, { target: { value: "/repos/app-detached" } });
    expect(screen.getByTestId("run-workspace-mode-project")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    const review = screen.getByTestId("run-workspace-review");
    expect(review).toHaveTextContent("/repos/app-detached");
    expect(review).toHaveTextContent(/Changes stay in that worktree/i);
    expect(review).toHaveTextContent(/detached HEAD/);

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[2]).toMatchObject({
      workspace: { mode: "existing-worktree", path: "/repos/app-detached" },
    });
  });

  it("posts a new worktree choice and explains committed HEAD", async () => {
    const start = vi
      .spyOn(workflowApi, "start")
      .mockResolvedValue({ runId: RUN_ID, duplicate: false, status: "queued" });
    renderDialog();

    const create = await screen.findByTestId("run-workspace-mode-new");
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));

    const review = screen.getByTestId("run-workspace-review");
    expect(review).toHaveTextContent(/new Git worktree/i);
    expect(review).toHaveTextContent(/created under DevChestra's data directory/i);
    expect(review).toHaveTextContent(/committed HEAD/i);
    expect(review).toHaveTextContent(/Uncommitted and untracked project files are not present/i);
    expect(review).toHaveTextContent(/never deleted or finalized/i);

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[2]).toMatchObject({
      workspace: { mode: "new-worktree" },
    });
  });

  it("keeps the project root usable when the project is not a Git repository", async () => {
    listWorkspaces.mockResolvedValue({
      projectRoot: "/repos/folder",
      git: false,
      worktrees: [],
    });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("run-workspace-status")).toHaveTextContent(/not a Git repository/i),
    );
    expect(screen.getByTestId("run-workspace-mode-project")).toBeChecked();
    expect(screen.getByTestId("run-workspace-mode-existing")).toBeDisabled();
    expect(screen.getByTestId("run-workspace-mode-new")).toBeDisabled();
  });

  it("visibly resets a stale existing worktree and requires a fresh review", async () => {
    const start = vi.spyOn(workflowApi, "start");
    renderDialog();

    const existing = await screen.findByTestId("run-workspace-mode-existing");
    await waitFor(() => expect(existing).not.toBeDisabled());
    fireEvent.click(existing);
    fireEvent.change(screen.getByTestId("run-workspace-existing-path"), {
      target: { value: "/repos/app-detached" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    expect(screen.getByTestId("run-workspace-review")).toHaveTextContent("/repos/app-detached");

    listWorkspaces.mockResolvedValue({
      ...WORKSPACES,
      worktrees: WORKSPACES.worktrees.filter((worktree) => worktree.path !== "/repos/app-detached"),
    });
    fireEvent.click(screen.getByTestId("run-workspace-review-refresh"));

    await waitFor(() => expect(screen.getByTestId("run-workspace-mode-project")).toBeChecked());
    expect(screen.getByTestId("run-workspace-status")).toHaveTextContent(
      /no longer available. Project root is now selected/i,
    );
    expect(screen.getByRole("button", { name: "Review and run" })).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[2]).toMatchObject({ workspace: { mode: "project" } });
  });

  it("shows a retry when worktree loading fails and keeps the root available", async () => {
    listWorkspaces.mockRejectedValueOnce(new Error("enumeration failed"));
    renderDialog();

    expect(await screen.findByTestId("run-workspace-retry")).toBeInTheDocument();
    expect(screen.getByTestId("run-workspace-status")).toHaveTextContent(
      /project root is still available/i,
    );
    expect(screen.getByTestId("run-workspace-mode-project")).toBeChecked();

    fireEvent.click(screen.getByTestId("run-workspace-retry"));
    await screen.findByTestId("run-workspace-refresh");
    expect(screen.getByTestId("run-workspace-mode-existing")).not.toBeDisabled();
  });

  it("blocks duplicate starts and reuses the idempotency key across a retry", async () => {
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const start = vi
      .spyOn(workflowApi, "start")
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ runId: RUN_ID, duplicate: false, status: "queued" });
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    const button = screen.getByRole("button", { name: "Start run" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    rejectFirst(new Error("network down"));
    expect(await screen.findByTestId("run-error")).toHaveTextContent("network down");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith(RUN_ID));

    expect(start).toHaveBeenCalledTimes(2);
    const firstOptions = start.mock.calls[0]?.[3];
    const secondOptions = start.mock.calls[1]?.[3];
    expect(firstOptions?.idempotencyKey).toBe(secondOptions?.idempotencyKey);
  });

  it("waits for save preparation and does not start when it fails", async () => {
    const start = vi.spyOn(workflowApi, "start");
    let finishPrepare!: (value: { ok: boolean; etag?: string; message?: string }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{ ok: boolean; etag?: string; message?: string }>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    renderDialog({ onPrepare: prepare });

    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    finishPrepare({ ok: false, message: "Save failed first" });
    expect(await screen.findByTestId("run-error")).toHaveTextContent("Save failed first");
    expect(start).not.toHaveBeenCalled();
  });

  it("disables review when validation reports errors", () => {
    renderDialog({
      validation: {
        ...REPORT,
        ok: false,
        errors: [{ severity: "error", code: "E_WORKFLOW_INVALID", message: "No end node" }],
      },
    });
    expect(screen.getByRole("button", { name: "Review and run" })).toBeDisabled();
    expect(screen.getByText(/validation errors before running/)).toBeInTheDocument();
  });
});
