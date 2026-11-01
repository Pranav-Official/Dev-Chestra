import type {
  CliModelCatalog,
  ProjectView,
  WebhookTriggerStatus,
  WorkflowDocumentResponse,
} from "@devchestra/api";
import { ApiError } from "@devchestra/api";
import type { ValidationReport, WorkflowFile } from "@devchestra/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { workflowApi } from "../src/editor/api/workflowApi.js";
import type { AutosaveSnapshot } from "../src/editor/autosave.js";
import { EditorHeader } from "../src/editor/page/EditorHeader.js";
import { useEditorValidation } from "../src/editor/page/useEditorValidation.js";
import { WorkflowEditor } from "../src/editor/page/WorkflowEditor.js";

const PROJECT: ProjectView = {
  id: "p1",
  name: "Demo project",
  path: "/tmp/demo",
  kind: "folder",
  missing: false,
  addedAt: 1,
};

const FILE: WorkflowFile = {
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

const AGENT_FILE: WorkflowFile = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      {
        id: "agent",
        type: "agent",
        name: "Research",
        cli: "codex",
        prompt: "Find the facts.",
        output: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
        permissions: { network: false, write: ["workspace"] },
        workspace: { mode: "scratch" },
      },
      { id: "end", type: "end", name: "End", status: "success", result: "agent.summary" },
    ],
    edges: [
      { id: "e1", from: "start", to: "agent" },
      { id: "e2", from: "agent", to: "end" },
    ],
  },
};

const CATALOG: CliModelCatalog = {
  cli: "codex",
  projectId: "p1",
  status: "ready",
  scope: "devchestra-runtime",
  source: "codex-app-server",
  cliVersion: "1.2.3",
  items: [
    { id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true, source: "codex-app-server" },
    { id: "gpt-5", label: "GPT-5", source: "codex-app-server" },
  ],
  fetchedAt: 1,
  expiresAt: 2,
  truncated: false,
  customSupported: true,
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

function documentFor(etag: string, workflow = FILE): WorkflowDocumentResponse {
  return {
    workflow,
    text: JSON.stringify(workflow),
    etag,
    relativeFile: `${workflow.id}.json`,
    validation: REPORT,
  };
}

const TRIGGER_OFF: WebhookTriggerStatus = {
  supported: false,
  armed: false,
  state: "off",
  hookId: null,
  url: null,
  armedRevision: null,
  armedAt: null,
  lastDeliveryAt: null,
  refreshError: null,
  issues: [],
};

function renderEditor(onReloaded = vi.fn(), workflow = FILE) {
  // The header's webhook control reads react-query, as it does under the app's provider.
  vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(TRIGGER_OFF);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/p/:pid/w/:wid",
        element: (
          <StrictMode>
            <WorkflowEditor
              project={PROJECT}
              workflowId="demo"
              document={documentFor('"e1"', workflow)}
              onReloaded={onReloaded}
            />
          </StrictMode>
        ),
      },
      { path: "/p/:pid/workflows", element: <div>workflow list</div> },
      { path: "/p/:pid/r/:rid", element: <div>run page</div> },
    ],
    { initialEntries: ["/p/p1/w/demo"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return onReloaded;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkflowEditor", () => {
  it("saves once after an edit under StrictMode and shows Saved", async () => {
    const save = vi
      .spyOn(workflowApi, "save")
      .mockResolvedValue(documentFor('"e2"', { ...FILE, name: "Renamed" }));
    renderEditor();

    fireEvent.change(screen.getByRole("textbox", { name: "Workflow name" }), {
      target: { value: "Renamed" },
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    const saved = save.mock.calls[0];
    expect(saved?.[0]).toBe("p1");
    expect(saved?.[1]).toBe("demo");
    expect(saved?.[2].workflow.name).toBe("Renamed");
    expect(saved?.[2].baseEtag).toBe('"e1"');
    await waitFor(() => expect(screen.getByTestId("autosave-status")).toHaveTextContent("Saved"), {
      timeout: 3_000,
    });
  });

  it("loads the model catalog only on picker open and keeps canvas shortcuts isolated", async () => {
    const get = vi.spyOn(api, "getCliModels").mockResolvedValue(CATALOG);
    const refresh = vi.spyOn(api, "refreshCliModels").mockResolvedValue(CATALOG);
    const save = vi.spyOn(workflowApi, "save");
    renderEditor(vi.fn(), AGENT_FILE);

    fireEvent.click(await screen.findByTestId("ed-node-agent"));
    const trigger = await screen.findByTestId("inspector-agent-model-trigger");
    expect(get).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("p1", "codex", { signal: expect.any(AbortSignal) }),
    );
    const picker = await screen.findByTestId("inspector-agent-model-picker");
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.change(picker, { target: { value: "gpt" } });
    fireEvent.keyDown(picker, { key: "Delete" });
    fireEvent.keyDown(picker, { key: "z", ctrlKey: true });
    expect(screen.getByTestId("ed-node-agent")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("stops on a conflict and reloads only through explicit confirmation", async () => {
    vi.spyOn(workflowApi, "save").mockRejectedValue(
      new ApiError("E_CONFLICT", "This workflow changed on disk.", 409, {
        currentEtag: '"server"',
      }),
    );
    const get = vi
      .spyOn(workflowApi, "get")
      .mockResolvedValue(documentFor('"server"', { ...FILE, name: "From disk" }));
    const onReloaded = renderEditor();

    fireEvent.change(screen.getByRole("textbox", { name: "Workflow name" }), {
      target: { value: "Local" },
    });
    expect(await screen.findByTestId("conflict-banner", {}, { timeout: 3_000 })).toHaveTextContent(
      "changed on disk",
    );
    expect(screen.getByTestId("autosave-status")).toHaveTextContent("Conflict");

    fireEvent.click(screen.getByRole("button", { name: "Reload from server" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload and discard" }));
    await waitFor(() => expect(onReloaded).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("p1", "demo");
    expect(onReloaded.mock.calls[0]?.[0].workflow.name).toBe("From disk");
  });
});

describe("EditorHeader gating", () => {
  const snapshot = (patch: Partial<AutosaveSnapshot> = {}): AutosaveSnapshot => ({
    docId: "p1/demo",
    status: "clean",
    revision: 1,
    savedRevision: 1,
    etag: '"e1"',
    error: null,
    errorCode: null,
    conflictEtag: null,
    blocked: false,
    blockedReason: null,
    lastSavedAt: 1,
    ...patch,
  });

  const invalid: ValidationReport = {
    ...REPORT,
    ok: false,
    errors: [{ severity: "error", code: "E_WORKFLOW_INVALID", message: "Need an end node" }],
  };

  it("disables Save and Run while an invalid form buffer is present", () => {
    render(
      <EditorHeader
        file={FILE}
        autosave={snapshot({ status: "blocked", blocked: true, blockedReason: "bad JSON" })}
        validation={{ report: invalid, revision: 1, current: true }}
        buffer={{ valid: false, reason: "bad JSON" }}
        canUndo={false}
        canRedo={false}
        issuesOpen={false}
        onToggleIssues={() => undefined}
        onChangeMeta={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onSave={() => undefined}
        onRun={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByTestId("buffer-invalid")).toHaveTextContent("bad JSON");
  });

  it("disables Run, but not Save, for validation errors without an invalid buffer", () => {
    render(
      <EditorHeader
        file={FILE}
        autosave={snapshot({ status: "dirty", savedRevision: 0 })}
        validation={{ report: invalid, revision: 1, current: true }}
        buffer={{ valid: true }}
        canUndo
        canRedo={false}
        issuesOpen
        onToggleIssues={() => undefined}
        onChangeMeta={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onSave={() => undefined}
        onRun={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    expect(screen.getByText("Need an end node")).toBeInTheDocument();
  });
});

describe("useEditorValidation", () => {
  function Harness({ workflow, revision }: { workflow: WorkflowFile; revision: number }) {
    const validation = useEditorValidation(workflow, revision);
    return (
      <span data-testid="report">
        {validation.report === null ? "pending" : validation.report.ok ? "ok" : "invalid"}:
        {String(validation.current)}
      </span>
    );
  }

  it("reports synchronously in a no-Worker test environment and follows revisions", () => {
    const { rerender } = render(<Harness workflow={FILE} revision={0} />);
    expect(screen.getByTestId("report")).toHaveTextContent("ok:true");
    rerender(<Harness workflow={{ ...FILE, name: "" }} revision={1} />);
    expect(screen.getByTestId("report")).toHaveTextContent("invalid:true");
  });
});
