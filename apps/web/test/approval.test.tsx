import { type ExecView, emptyRunView, type RunView } from "@relay/core";
import type { WorkflowFile } from "@relay/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalForm } from "../src/editor/inspector/ApprovalForm.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import { checkConnection } from "../src/editor/model/routing.js";
import { ApprovalPanel } from "../src/run/ApprovalPanel.js";
import { approvalForPath } from "../src/run/approval.js";

function withQuery(c: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {c}
    </QueryClientProvider>
  );
}
function fakeView(over?: Partial<RunView>): RunView {
  const b = emptyRunView();
  return {
    ...b,
    lastEventId: 42,
    status: "waiting_approval",
    executions: {
      approval: {
        ...b.executions.approval!,
        path: "approval",
        nodeId: "approval",
        status: "waiting_approval",
        attempt: 2,
        generation: 3,
        kind: "approval",
        approvalRequest: {
          message: "Please review {{start.topic}}",
          irreversible: true,
          criteria: ["check1", "check2"],
          requestId: "req_abc123",
          attempt: 2,
          generation: 3,
          eventId: 10,
        },
        approvalDecision: null,
        requiresAcceptedResult: false,
        acceptedResult: null,
        recordedOutput: null,
        processSpawned: null,
        processStopped: null,
        workspaceFinalized: null,
        validationAttempts: 0,
        crashAttempts: 0,
        mode: null,
        cli: null,
        sessionId: null,
        sessionCwd: null,
        model: null,
        resolvedConfigHash: null,
        inputsHash: null,
        startedAt: null,
        endedAt: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        attemptTokensIn: 0,
        attemptTokensOut: 0,
        attemptCostUsd: 0,
        workspaceDir: null,
        branch: null,
        workspaceCommitted: null,
        lastValidationErrors: [],
        lastTranscript: null,
        lastError: null,
        gateDecision: null,
        joinResolution: null,
      },
    },
    ...over,
  } as unknown as RunView;
}
function upstreamFetch(approvalsFn?: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/approvals/") && approvalsFn) return approvalsFn(url) as Response;
    if (String(url).includes("/approvals/"))
      return {
        ok: true,
        headers: new Headers({ "X-Relay-Api": "1" }),
        status: 200,
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response;
    const p = {
      execution: {
        status: "succeeded",
        kind: "agent",
        attempt: 1,
        generation: 1,
        validationAttempts: 0,
        validationLimit: 2,
        crashAttempts: 0,
        startedAt: null,
        endedAt: null,
        cli: "fake",
        sessionId: null,
        sessionCwd: null,
        model: null,
        outputId: null,
        errorCode: null,
        errorMessage: null,
        branch: null,
        lastEventId: 42,
        nodeId: "prev",
        path: "prev",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      attempts: [],
      input: null,
      output: null,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "none" },
      process: null,
      workspace: null,
    };
    return {
      ok: true,
      headers: new Headers({ "X-Relay-Api": "1" }),
      status: 200,
      text: async () => JSON.stringify(p),
      json: async () => p,
    } as unknown as Response;
  });
}

describe("approval graph and routing", () => {
  it("creates default approval node", () => {
    const n = createDefaultNode("approval", []) as unknown as {
      type: string;
      message: string;
      irreversible: boolean;
    };
    expect(n.type).toBe("approval");
    expect(n.message).toBe("Please review and approve to continue.");
    expect(n.irreversible).toBe(false);
  });
  it("routes approved as plain id and rejected as .rejected", () => {
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "W",
      graph: {
        nodes: [
          {
            id: "approval",
            type: "approval" as never,
            name: "A",
            message: "m",
            irreversible: false,
            ui: { x: 0, y: 0 },
          } as never,
          {
            id: "next",
            type: "shell" as never,
            name: "S",
            command: "echo hi",
            timeoutMin: 1,
            allowFailure: false,
            ui: { x: 1, y: 0 },
          } as never,
          {
            id: "rej",
            type: "shell" as never,
            name: "R",
            command: "echo no",
            timeoutMin: 1,
            allowFailure: false,
            ui: { x: 2, y: 0 },
          } as never,
        ],
        edges: [],
      },
    };
    expect(checkConnection(file, { source: "approval", target: "next" }).ok).toBe(true);
    expect(checkConnection(file, { source: "approval.rejected", target: "rej" }).ok).toBe(true);
    expect(checkConnection(file, { source: "approval.approved", target: "next" }).ok).toBe(false);
  });
});

describe("approvalForPath uses view fields", () => {
  it("returns frozen with opaque string requestId and exact attempt/gen", () => {
    const v = fakeView();
    const r = approvalForPath(v, "approval");
    expect(r?.frozen?.requestId).toBe("req_abc123");
    expect(r?.frozen?.attempt).toBe(2);
    expect(r?.pending).toBe(true);
  });
  it("is read-only when identity missing", () => {
    const v = emptyRunView() as RunView;
    v.executions.approval = {
      path: "approval",
      nodeId: "approval",
      status: "waiting_approval",
      attempt: 1,
      generation: 1,
      kind: "approval",
      approvalRequest: null,
      approvalDecision: null,
    } as unknown as ExecView;
    expect(approvalForPath(v, "approval")).toBeNull();
  });
  it("retains frozen with null requestId but not actionable", () => {
    const v = fakeView();
    (v.executions.approval as unknown as { approvalRequest: unknown }).approvalRequest = {
      message: "legacy",
      irreversible: false,
      criteria: null,
      requestId: null,
      attempt: null,
      generation: null,
      eventId: 10,
    };
    const r = approvalForPath(v, "approval");
    expect(r?.frozen?.requestId).toBeNull();
    expect(r?.pending).toBe(true);
  });
  it("pending false when run cancelled", () => {
    const v = fakeView({ status: "cancelled" as unknown as RunView["status"] });
    expect(approvalForPath(v, "approval")?.pending).toBe(false);
  });
  it("pending false when exec not waiting_approval", () => {
    const v = fakeView();
    (v.executions.approval as unknown as ExecView).status = "succeeded" as ExecView["status"];
    expect(approvalForPath(v, "approval")?.pending).toBe(false);
  });
  it("pending false when decision matches", () => {
    const v = fakeView();
    (v.executions.approval as unknown as { approvalDecision: unknown }).approvalDecision = {
      decision: "approve",
      by: "user",
      note: null,
      requestId: "req_abc123",
      attempt: 2,
      generation: 3,
      eventId: 11,
    };
    const r = approvalForPath(v, "approval");
    expect(r?.pending).toBe(false);
    expect(r?.resolved?.requestId).toBe("req_abc123");
  });
});

describe("ApprovalForm limits", () => {
  it("validates message 4096 and criteria 256, add disabled at 32", async () => {
    const onPatch = vi.fn();
    const { unmount } = render(
      <ApprovalForm
        node={{
          id: "approval",
          type: "approval",
          name: "A",
          message: "hi",
          irreversible: false,
          criteria: ["a"],
        }}
        issues={[]}
        onPatch={onPatch}
      />,
    );
    expect(screen.getByTestId("inspector-approval-message")).toHaveAttribute("maxLength", "4096");
    expect(screen.getByTestId("inspector-approval-criteria-0")).toHaveAttribute("maxLength", "256");
    unmount();
    const many = Array.from({ length: 32 }, (_, i) => `c${i}`);
    render(
      <ApprovalForm
        node={{
          id: "approval",
          type: "approval",
          name: "A",
          message: "hi",
          irreversible: false,
          criteria: many,
        }}
        issues={[]}
        onPatch={onPatch}
      />,
    );
    expect(screen.getByTestId("inspector-approval-criteria-add")).toBeDisabled();
  });
});

describe("ApprovalPanel fences", () => {
  const snap = {
    nodes: [
      {
        id: "approval",
        type: "approval" as never,
        name: "A",
        message: "m",
        irreversible: false,
        ui: { x: 0, y: 0 },
      } as never,
      {
        id: "prev",
        type: "agent" as never,
        name: "P",
        cli: "fake",
        prompt: "p",
        output: { type: "object" },
        permissions: { network: false, write: [] },
        limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
        context: { project: "none", workflow: "none" },
        ui: { x: 0, y: 0 },
      } as never,
    ],
    edges: [{ id: "e1", from: "prev", to: "approval" }],
  } as never;
  const fullSnap = { name: "wf", graph: snap } as unknown as Parameters<
    typeof ApprovalPanel
  >[0]["snapshot"];
  it("fences done until projection", async () => {
    const v = fakeView();
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const fm = upstreamFetch(
      () =>
        ({
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          json: async () => ({
            runId: ulid,
            path: "approval",
            decision: "approve",
            note: null,
            by: "user",
            duplicate: false,
            status: "succeeded",
            eventId: 43,
          }),
          text: async () =>
            JSON.stringify({
              runId: ulid,
              path: "approval",
              decision: "approve",
              note: null,
              by: "user",
              duplicate: false,
              status: "succeeded",
              eventId: 43,
            }),
        }) as unknown as Response,
    );
    globalThis.fetch = fm as unknown as typeof fetch;
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    await userEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() => expect(screen.getByTestId("approval-done")).toBeInTheDocument());
    expect(screen.getByTestId("approval-approve")).toBeDisabled();
    const c1 = fm.mock.calls.filter(([u]) => String(u).includes("/approvals/")).length;
    expect(c1).toBe(1);
    await userEvent.click(screen.getByTestId("approval-approve"));
    const c2 = fm.mock.calls.filter(([u]) => String(u).includes("/approvals/")).length;
    expect(c2).toBe(1);
  });
  it("note maxLength 4096", () => {
    const v = fakeView();
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    expect((screen.getByTestId("approval-note") as HTMLTextAreaElement).maxLength).toBe(4096);
  });
  it("replay hides live upstream", () => {
    const v = fakeView();
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={true} />,
      ),
    );
    expect(screen.getByTestId("approval-replay-guard")).toBeInTheDocument();
    expect(screen.getByTestId("upstream-replay-note")).toBeInTheDocument();
    expect(screen.getByTestId("approval-approve")).toBeDisabled();
  });
  it("read-only when identity missing", () => {
    const v = emptyRunView() as RunView;
    v.executions.approval = {
      path: "approval",
      nodeId: "approval",
      status: "waiting_approval",
      attempt: 1,
      generation: 1,
      kind: "approval",
      approvalRequest: null,
      approvalDecision: null,
    } as unknown as ExecView;
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    expect(screen.getByTestId("approval-no-identity")).toBeInTheDocument();
  });
  it("legacy requestId null disabled no POST", async () => {
    const v = fakeView();
    (v.executions.approval as unknown as { approvalRequest: unknown }).approvalRequest = {
      message: "legacy",
      irreversible: false,
      criteria: null,
      requestId: null,
      attempt: null,
      generation: null,
      eventId: 10,
    };
    const fm = upstreamFetch();
    globalThis.fetch = fm as unknown as typeof fetch;
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    expect(screen.getByTestId("approval-approve")).toBeDisabled();
    await userEvent.click(screen.getByTestId("approval-approve"));
    expect(fm.mock.calls.filter(([u]) => String(u).includes("/approvals/")).length).toBe(0);
  });
  it("attempt null disabled no POST", async () => {
    const v = fakeView();
    (v.executions.approval as unknown as { approvalRequest: unknown }).approvalRequest = {
      message: "m",
      irreversible: false,
      criteria: null,
      requestId: "req_ok",
      attempt: null,
      generation: 3,
      eventId: 10,
    };
    const fm = upstreamFetch();
    globalThis.fetch = fm as unknown as typeof fetch;
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    expect(screen.getByTestId("approval-approve")).toBeDisabled();
    await userEvent.click(screen.getByTestId("approval-approve"));
    expect(fm.mock.calls.filter(([u]) => String(u).includes("/approvals/")).length).toBe(0);
  });
  it("cancelled shows settled no POST", async () => {
    const v = fakeView({ status: "cancelled" as unknown as RunView["status"] });
    (v.executions.approval as unknown as ExecView).status = "cancelled" as ExecView["status"];
    const fm = upstreamFetch();
    globalThis.fetch = fm as unknown as typeof fetch;
    render(
      withQuery(
        <ApprovalPanel runId="r1" path="approval" snapshot={fullSnap} view={v} isReplay={false} />,
      ),
    );
    expect(screen.getByTestId("approval-settled-note")).toBeInTheDocument();
    expect(fm.mock.calls.filter(([u]) => String(u).includes("/approvals/")).length).toBe(0);
  });
});
