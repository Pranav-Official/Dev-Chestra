import {
  type ExecStatus,
  type ExecView,
  emptyRunView,
  type RunStatus,
  type RunView,
} from "@devchestra/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailPanel, ExecutionStatus } from "../src/run/DetailPanel.js";
import { RunCanvas, type WorkflowSnapshot } from "../src/run/RunCanvas.js";
import { isUnresolvedExecution, unresolvedSummary } from "../src/run/staleExecution.js";

function exec(path: string, status: ExecStatus): ExecView {
  return {
    path,
    nodeId: path,
    status,
    attempt: 1,
    generation: 1,
    kind: "agent",
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
    approvalRequest: null,
    approvalDecision: null,
  } as unknown as ExecView;
}

function snapshot(): WorkflowSnapshot {
  return {
    name: "Stale",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "a", type: "agent", name: "A", cli: "codex" },
      ],
      edges: [{ id: "e1", from: "start", to: "a" }],
    },
  };
}

function view(runStatus: RunStatus, execStatus: ExecStatus): RunView {
  return {
    ...emptyRunView(),
    status: runStatus,
    lastEventId: 9,
    runNumber: 19,
    executions: {
      start: exec("start", "succeeded"),
      a: exec("a", execStatus),
    },
  };
}

describe("isUnresolvedExecution", () => {
  it.each([["running"], ["validating"], ["waiting_quota"], ["waiting_approval"]] as Array<
    [ExecStatus]
  >)("flags live execution %s under a failed run", (status) => {
    expect(isUnresolvedExecution("failed", status)).toBe(true);
    expect(isUnresolvedExecution("cancelled", status)).toBe(true);
  });

  it.each([["succeeded"], ["failed"], ["skipped"], ["pending"], ["ready"]] as Array<[ExecStatus]>)(
    "leaves settled execution %s alone under a failed run",
    (status) => {
      expect(isUnresolvedExecution("failed", status)).toBe(false);
    },
  );

  it.each([["queued"], ["running"], ["paused"], ["waiting_approval"]] as Array<[RunStatus]>)(
    "leaves live executions alone while the run %s is still active",
    (runStatus) => {
      expect(isUnresolvedExecution(runStatus, "running")).toBe(false);
      expect(isUnresolvedExecution(runStatus, "waiting_approval")).toBe(false);
    },
  );

  it("summarises the gap without inventing a status", () => {
    expect(unresolvedSummary("failed", "running")).toBe("Run Failed · reported Running");
  });
});

describe("RunCanvas stale execution", () => {
  it("shows State unresolved without a spinner for a running exec under a failed run", () => {
    const { container } = render(
      <RunCanvas
        snapshot={snapshot()}
        view={view("failed", "running")}
        onSelect={() => undefined}
        selectedPath={null}
      />,
    );
    const node = screen.getByTestId("run-node-a");
    expect(node).toHaveAttribute("data-node-status", "running");
    expect(node).toHaveAttribute("data-node-unresolved", "true");
    expect(node).toHaveTextContent("State unresolved");
    expect(node).toHaveTextContent("Run Failed · reported Running");
    expect(screen.getByTestId("run-node-status-a")).toHaveTextContent(
      "State unresolved: Run Failed · reported Running",
    );
    expect(container.querySelector(".spin")).toBeNull();
  });

  it("keeps the animated Running for the same exec while the run is still active (replay before the terminal event)", () => {
    const { container } = render(
      <RunCanvas
        snapshot={snapshot()}
        view={view("running", "running")}
        onSelect={() => undefined}
        selectedPath={null}
      />,
    );
    const node = screen.getByTestId("run-node-a");
    expect(node).toHaveAttribute("data-node-status", "running");
    expect(node).not.toHaveAttribute("data-node-unresolved");
    expect(node).toHaveTextContent("Running");
    expect(node).not.toHaveTextContent("State unresolved");
    expect(container.querySelector(".spin")).not.toBeNull();
  });
});

describe("ExecutionStatus", () => {
  it("replaces the spinning pill with an explicit warning, preserving the reported status", () => {
    const { container } = render(
      <ExecutionStatus runStatus="failed" execStatus="validating" testId="detail-status" />,
    );
    expect(screen.getByTestId("detail-status")).toHaveTextContent("State unresolved");
    expect(screen.getByText("reported Validating")).toBeInTheDocument();
    expect(container.querySelector(".spin")).toBeNull();
  });

  it("passes live states through untouched while the run is active", () => {
    const { container } = render(
      <ExecutionStatus runStatus="running" execStatus="running" testId="detail-status" />,
    );
    expect(screen.getByTestId("detail-status")).toHaveTextContent("Running");
    expect(container.querySelector(".spin")).not.toBeNull();
  });
});

vi.mock("../src/api/hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/hooks.js")>();
  return {
    ...actual,
    useExecutionDetail: () => ({
      data: {
        execution: { status: "running" },
        attempts: [],
        input: null,
        output: null,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "metered" },
        process: null,
        workspace: null,
      },
      isPending: false,
      error: null,
    }),
  };
});

describe("DetailPanel stale execution", () => {
  it("warns Run failed on the inspector while preserving raw execution evidence", () => {
    render(
      <DetailPanel
        run={null}
        runId="r19"
        path="a"
        nodeLabel="A"
        view={view("failed", "running")}
        events={[]}
        isReplay={false}
        snapshot={snapshot()}
      />,
    );
    const note = screen.getByTestId("detail-unresolved-note");
    expect(note).toHaveTextContent("State unresolved");
    expect(note).toHaveTextContent("Run Failed · reported Running");
    // Raw evidence is preserved, not rewritten to failed/cancelled/stopped.
    expect(screen.getByTestId("detail-exec-status")).toHaveTextContent("State unresolved");
    expect(screen.getByText("No attempts recorded.")).toBeInTheDocument();
    expect(screen.queryByText("No accepted output yet.")).toBeInTheDocument();
  });

  it("shows actual Running in the inspector while the run is still active", () => {
    render(
      <DetailPanel
        run={null}
        runId="r19"
        path="a"
        nodeLabel="A"
        view={view("running", "running")}
        events={[]}
        isReplay={false}
        snapshot={snapshot()}
      />,
    );
    expect(screen.queryByTestId("detail-unresolved-note")).toBeNull();
    expect(screen.getByTestId("detail-status")).toHaveTextContent("Running");
  });
});
