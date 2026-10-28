import { deriveRouting, type ExecView, emptyRunView, type RunView } from "@relay/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunCanvas, type WorkflowSnapshot } from "../src/run/RunCanvas.js";

function snapshot(): WorkflowSnapshot {
  return {
    name: "Routing",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "gate", type: "gate", name: "Gate", branches: [{ id: "yes" }, { id: "no" }] },
        { id: "a", type: "agent", name: "A", cli: "codex" },
        { id: "b", type: "agent", name: "B", cli: "codex" },
        {
          id: "join",
          type: "join",
          name: "Join",
          mode: "all",
          inputs: ["a", "b"],
        },
        { id: "end", type: "end", name: "End" },
      ],
      edges: [
        { id: "e-start-gate", from: "start", to: "gate" },
        { id: "e-gate-yes", from: "gate.yes", to: "a" },
        { id: "e-gate-no", from: "gate.no", to: "b" },
        { id: "e-a-join", from: "a", to: "join.a" },
        { id: "e-b-join", from: "b", to: "join.b" },
        { id: "e-join-end", from: "join", to: "end" },
      ],
    },
  };
}

function exec(path: string, status: string, extra: Partial<ExecView> = {}): ExecView {
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
    ...extra,
  } as ExecView;
}

function view(): RunView {
  return {
    ...emptyRunView(),
    status: "running",
    lastEventId: 9,
    executions: {
      start: exec("start", "succeeded", { kind: "start" }),
      gate: exec("gate", "succeeded", {
        kind: "gate",
        gateDecision: {
          branch: "yes",
          evaluated: [
            { branch: "yes", matched: true },
            { branch: "no", matched: false },
          ],
        },
      }),
      a: exec("a", "succeeded"),
      b: exec("b", "skipped"),
      join: exec("join", "succeeded", {
        kind: "join",
        joinResolution: { mode: "all", active: ["a"], skipped: ["b"] },
      }),
      end: exec("end", "pending", { kind: "end" }),
    },
  };
}

describe("run routing viewer", () => {
  it("shows the chosen gate branch, dead edges and skipped nodes from the run view", () => {
    render(
      <RunCanvas
        snapshot={snapshot()}
        view={view()}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-gate-branch-gate")).toHaveTextContent("branch yes");
    expect(screen.getByTestId("run-node-b")).toHaveAttribute("data-node-status", "skipped");
    const routing = deriveRouting(snapshot().graph, view().executions);
    expect(routing.edges["e-gate-yes"]).toBe("active");
    expect(routing.edges["e-gate-no"]).toBe("dead");
    expect(routing.edges["e-a-join"]).toBe("active");
    expect(routing.edges["e-b-join"]).toBe("dead");
  });

  it("shows join active and skipped input names from joinResolution", () => {
    render(
      <RunCanvas
        snapshot={snapshot()}
        view={view()}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-join-active-join")).toHaveTextContent("active a");
    expect(screen.getByTestId("run-join-skipped-join")).toHaveTextContent("skipped b");
  });

  it("renders a failed gate decision as a failure rather than a fallback branch", () => {
    const failed = view();
    failed.executions.gate = exec("gate", "succeeded", {
      kind: "gate",
      gateDecision: {
        branch: null,
        evaluated: [{ branch: "yes", matched: false, error: "non-boolean result" }],
      },
    });
    render(
      <RunCanvas
        snapshot={snapshot()}
        view={failed}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-gate-branch-gate")).toHaveTextContent("gate failed");
    expect(deriveRouting(snapshot().graph, failed.executions).edges["e-gate-yes"]).toBe("dead");
  });
});
