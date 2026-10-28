import { deriveRouting, type ExecView, emptyRunView, type RunView } from "@relay/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../src/run/DetailPanel.js";
import { RunCanvas, toRoutingGraph, type WorkflowSnapshot } from "../src/run/RunCanvas.js";

function withQuery(c: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {c}
    </QueryClientProvider>
  );
}

function exec(path: string, status: string, extra: Partial<ExecView> = {}): ExecView {
  return {
    path,
    nodeId: path,
    status,
    attempt: 1,
    generation: 1,
    kind: "decision",
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
    tokensIn: 40,
    tokensOut: 12,
    costUsd: 0,
    attemptTokensIn: 0,
    attemptTokensOut: 0,
    attemptCostUsd: 0,
    workspaceDir: null,
    branch: null,
    workspaceCommitted: null,
    lastValidationErrors: [],
    lastTranscript: null,
    gateDecision: null,
    joinResolution: null,
    approvalRequest: null,
    approvalDecision: null,
    decision: null,
    lastError: null,
    ...extra,
  } as ExecView;
}

function decisionSnapshot(): WorkflowSnapshot {
  return {
    name: "Decision",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start" },
        {
          id: "d",
          type: "decision",
          name: "Decide",
          provider: "typesafe-jev",
          instructions: "Decide yes or no from the state.",
          mode: {
            kind: "choice",
            options: [{ value: "a" }, { value: "b" }],
            branches: [
              { id: "a", values: ["a"] },
              { id: "b", values: ["b"] },
            ],
          },
        },
        { id: "endA", type: "end", name: "A" },
        { id: "endB", type: "end", name: "B" },
      ],
      edges: [
        { id: "e-start-d", from: "start", to: "d" },
        { id: "e-d-b", from: "d.b", to: "endA" },
        { id: "e-d-uncertain", from: "d.uncertain", to: "endB" },
      ],
    },
  };
}

function choiceView(): RunView {
  return {
    ...emptyRunView(),
    status: "succeeded",
    lastEventId: 9,
    executions: {
      start: exec("start", "succeeded", { kind: "start" }),
      d: exec("d", "succeeded", {
        decision: {
          output: {
            kind: "choice",
            value: "b",
            probabilities: { a: 0.25, b: 0.75 },
            confidence: 0.75,
            confidenceSource: "provider",
            model: "jev-latest",
          },
          routing: { branch: "b", reason: "matched" },
          eventId: 8,
        },
      }),
      endA: exec("endA", "succeeded", { kind: "end" }),
      endB: exec("endB", "skipped", { kind: "end" }),
    },
  };
}

describe("decision run viewer", () => {
  it("shows the decision output, confidence source, branch and usage in replay", () => {
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="d"
          nodeLabel="Decide"
          view={choiceView()}
          events={[]}
          isReplay={true}
          snapshot={decisionSnapshot()}
        />,
      ),
    );
    expect(screen.getByTestId("detail-decision-value")).toHaveTextContent("b");
    expect(screen.getByTestId("detail-decision-prob-b")).toHaveTextContent("75.0%");
    expect(screen.getByTestId("detail-decision-confidence")).toHaveTextContent("75.0%");
    expect(screen.getByTestId("detail-decision-confidence")).toHaveTextContent("provider");
    expect(screen.getByTestId("detail-decision-route")).toHaveTextContent("b");
    expect(screen.getByTestId("detail-decision-route")).toHaveTextContent("matched");
    expect(screen.getByTestId("detail-decision-model")).toHaveTextContent("jev-latest");
    expect(screen.getByTestId("detail-decision-usage")).toHaveTextContent("40");
  });

  it.each([
    {
      name: "boolean",
      output: {
        kind: "boolean",
        value: true,
        probability: 0.82,
        confidence: 0.82,
        confidenceSource: "derived",
        model: "jev-latest",
      },
      routing: { branch: "true", reason: "matched" },
      value: "Yes",
    },
    {
      name: "score",
      output: {
        kind: "score",
        value: "high",
        score: 1.2,
        probabilities: { low: 0.2, high: 0.8 },
        confidence: 0.8,
        confidenceSource: "derived",
        model: "jev-latest",
      },
      routing: { branch: "high", reason: "matched" },
      value: "high",
    },
    {
      name: "refused",
      output: {
        kind: "choice",
        value: null,
        confidence: null,
        confidenceSource: null,
        refusal: { reason: "no answer for q0" },
        model: "jev-latest",
      },
      routing: { branch: "uncertain", reason: "refused" },
      value: "Refused",
    },
  ] as const)("renders the $name decision output", ({ output, routing, value }) => {
    const view: RunView = {
      ...emptyRunView(),
      status: "succeeded",
      lastEventId: 9,
      executions: {
        // biome-ignore lint/suspicious/noExplicitAny: mode-specific output shapes per case
        d: exec("d", "succeeded", { decision: { output: output as any, routing, eventId: 8 } }),
      },
    };
    const { unmount } = render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="d"
          nodeLabel="Decide"
          view={view}
          events={[]}
          isReplay={true}
          snapshot={decisionSnapshot()}
        />,
      ),
    );
    expect(screen.getByTestId("detail-decision-value")).toHaveTextContent(value);
    expect(screen.getByTestId("detail-decision-route")).toHaveTextContent(routing.branch ?? "");
    unmount();
  });

  it("omits the decision section when the node has no answer yet", () => {
    const view: RunView = {
      ...emptyRunView(),
      status: "running",
      lastEventId: 3,
      executions: { d: exec("d", "running") },
    };
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="d"
          nodeLabel="Decide"
          view={view}
          events={[]}
          isReplay={true}
          snapshot={decisionSnapshot()}
        />,
      ),
    );
    expect(screen.queryByTestId("detail-decision-value")).toBeNull();
  });

  it("draws decision handles and dead/active edges from core routing", () => {
    const view = choiceView();
    render(
      <RunCanvas
        snapshot={decisionSnapshot()}
        view={view}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    const route = screen.getByTestId("run-decision-branch-d");
    expect(route).toHaveTextContent("branch b");
    expect(route).toHaveTextContent("matched");
    expect(route).toHaveTextContent("→b");
    const routing = deriveRouting(toRoutingGraph(decisionSnapshot()), view.executions);
    expect(routing.edges["e-d-b"]).toBe("active");
    expect(routing.edges["e-d-uncertain"]).toBe("dead");
  });

  it("replays the pending state before the decision is answered", () => {
    const early: RunView = {
      ...emptyRunView(),
      status: "running",
      lastEventId: 3,
      executions: { start: exec("start", "succeeded", { kind: "start" }), d: exec("d", "running") },
    };
    const { unmount } = render(
      <RunCanvas
        snapshot={decisionSnapshot()}
        view={early}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-decision-branch-d")).toHaveTextContent("pending");
    const routing = deriveRouting(toRoutingGraph(decisionSnapshot()), early.executions);
    expect(routing.edges["e-d-b"]).toBe("pending");
    expect(routing.edges["e-d-uncertain"]).toBe("pending");
    unmount();

    render(
      <RunCanvas
        snapshot={decisionSnapshot()}
        view={choiceView()}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-decision-branch-d")).toHaveTextContent("branch b");
  });
});
