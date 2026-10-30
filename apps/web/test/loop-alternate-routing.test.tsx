import {
  deriveRouting,
  type ExecView,
  emptyRunView,
  type Path,
  type RunId,
  type RunView,
  reduce,
} from "@devchestra/core";
import {
  type Edge,
  LOOP_EXHAUSTED_HANDLE,
  parseWorkflowJson,
  serializeWorkflow,
  validateWorkflow,
  type WorkflowFile,
  type WorkflowNode,
} from "@devchestra/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildEdges,
  connectionEndpoints,
  EditorCanvas,
} from "../src/editor/canvas/EditorCanvas.js";
import {
  createDefaultNode,
  createEditorState,
  type EditorState,
  executeCommand,
} from "../src/editor/model/index.js";
import { checkConnection } from "../src/editor/model/routing.js";
import { DetailPanel } from "../src/run/DetailPanel.js";
import { RunCanvas, toRoutingGraph, type WorkflowSnapshot } from "../src/run/RunCanvas.js";

function fixture(): { file: WorkflowFile; loopId: string; okId: string; spentId: string } {
  const start = createDefaultNode("start", [], { x: 0, y: 0 });
  const loop = createDefaultNode("loop", [start], { x: 200, y: 0 });
  const ok = createDefaultNode("end", [start, loop], { x: 400, y: 0 });
  const spent = createDefaultNode("end", [start, loop, ok], { x: 400, y: 120 });
  const nodes: WorkflowNode[] = [start, loop, ok, spent];
  const edges: Edge[] = [{ id: "e0", from: start.id, to: loop.id }];
  return {
    file: { schemaVersion: 1, id: "loops", name: "Loops", graph: { nodes, edges } },
    loopId: loop.id,
    okId: ok.id,
    spentId: spent.id,
  };
}

function connect(state: EditorState, source: string, target: string) {
  return executeCommand(state, { kind: "connect", connection: { source, target } });
}

describe("editor loop outputs", () => {
  it("renders labeled success and exhausted handles", () => {
    const { file, loopId } = fixture();
    render(
      <EditorCanvas
        file={file}
        selection={null}
        issues={[]}
        onSelectionChange={() => undefined}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
      />,
    );
    const handles = screen.getByTestId(`ed-loop-handles-${loopId}`);
    expect(handles).toHaveTextContent("success");
    expect(handles).toHaveTextContent("exhausted");
    expect(screen.getByTestId(`ed-handle-${loopId}-out-success`)).toBeInTheDocument();
    expect(screen.getByTestId(`ed-handle-${loopId}-out-exhausted`)).toBeInTheDocument();
    // The generic single output handle is replaced, not duplicated.
    expect(screen.queryByTestId(`ed-handle-${loopId}-out`)).toBeNull();
  });

  it("connects success as a plain edge and exhausted as loop.exhausted", () => {
    const { file, loopId, okId, spentId } = fixture();
    let state = createEditorState(file);
    const success = connect(state, loopId, okId);
    if (!success.ok) throw new Error(success.error);
    state = success.state;
    const exhausted = connect(state, `${loopId}.${LOOP_EXHAUSTED_HANDLE}`, spentId);
    if (!exhausted.ok) throw new Error(exhausted.error);
    state = exhausted.state;
    const froms = state.file.graph.edges.map((edge) => edge.from);
    expect(froms).toContain(loopId);
    expect(froms).toContain(`${loopId}.exhausted`);
    const report = validateWorkflow(
      (() => {
        // Use the schema's own parser so the edited file is what a save would validate.
        const text = serializeWorkflow(state.file);
        if (!text.ok) throw text.error;
        const parsed = parseWorkflowJson(text.value);
        if (!parsed.ok) throw parsed.error;
        return parsed.value;
      })(),
    );
    expect(report.errors.filter((e) => e.code.startsWith("E_EDGE"))).toEqual([]);
  });

  it("rejects arbitrary loop handles and double-wiring one target from both outputs", () => {
    const { file, loopId, okId } = fixture();
    expect(checkConnection(file, { source: `${loopId}.other`, target: okId }).ok).toBe(false);
    expect(checkConnection(file, { source: `${loopId}.success`, target: okId }).ok).toBe(false);
    const state = createEditorState(file);
    const first = connect(state, loopId, okId);
    if (!first.ok) throw new Error(first.error);
    const second = connect(first.state, `${loopId}.exhausted`, okId);
    expect(second.ok).toBe(false);
  });

  it("round-trips edge endpoints to React Flow handles and back", () => {
    const { file, loopId, okId, spentId } = fixture();
    const wired: WorkflowFile = {
      ...file,
      graph: {
        ...file.graph,
        edges: [
          ...file.graph.edges,
          { id: "ok", from: loopId, to: okId },
          { id: "spent", from: `${loopId}.exhausted`, to: spentId },
        ],
      },
    };
    const edges = buildEdges(wired, null);
    const byId = Object.fromEntries(edges.map((edge) => [edge.id, edge]));
    // Old plain edges keep the original single `out` handle.
    expect(byId.ok?.sourceHandle).toBe("out");
    expect(byId.spent?.sourceHandle).toBe("out:exhausted");
    expect(byId.spent?.source).toBe(loopId);
    for (const edge of [byId.ok, byId.spent]) {
      if (!edge) throw new Error("missing edge");
      const back = connectionEndpoints(wired, {
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      });
      const original = wired.graph.edges.find((candidate) => candidate.id === edge.id);
      expect(back).toEqual({ source: original?.from, target: original?.to });
    }
    expect(
      connectionEndpoints(wired, {
        source: loopId,
        target: okId,
        sourceHandle: "out:bogus",
        targetHandle: "in",
      }),
    ).toBeNull();
  });
});

function runSnapshot(): WorkflowSnapshot {
  return {
    name: "Loops",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "refine", type: "loop", name: "Refine", maxIterations: 2 },
        { id: "ok", type: "end", name: "Success end" },
        { id: "spent", type: "end", name: "Exhausted end" },
      ],
      edges: [
        { id: "e0", from: "start", to: "refine" },
        { id: "e1", from: "refine", to: "ok" },
        { id: "e2", from: "refine.exhausted", to: "spent" },
      ],
    },
  };
}

function exec(path: string, status: string, extra: Partial<ExecView> = {}): ExecView {
  const created = reduce(emptyRunView(), {
    id: 1,
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId,
    path: path as Path,
    ts: "2026-10-29T10:00:00Z",
    actor: "engine",
    type: "node.state",
    v: 1,
    payload: {
      from: "pending",
      to: "ready",
      attempt: 1,
      generation: 1,
      init: { kind: path === "refine" ? "loop" : "end", requireSubmission: false },
    },
  }).executions[path];
  if (!created) throw new Error("fixture");
  return { ...created, status, ...extra } as ExecView;
}

function loopView(outcome: "condition_met" | "iteration_limit"): RunView {
  const exhausted = outcome === "iteration_limit";
  return {
    ...emptyRunView(),
    status: "succeeded",
    executions: {
      start: exec("start", "succeeded"),
      refine: exec("refine", "succeeded", {
        kind: "loop",
        loop: {
          iteration: 2,
          parent: {},
          parentRef: null,
          state: {},
          rounds: [
            { iteration: 1, result: {}, done: false, nextState: {}, outcome: null, eventId: 5 },
            {
              iteration: 2,
              result: {},
              done: !exhausted,
              nextState: null,
              outcome,
              eventId: 6,
            },
          ],
        },
      }),
      ok: exec("ok", exhausted ? "skipped" : "succeeded"),
      spent: exec("spent", exhausted ? "succeeded" : "skipped"),
    },
  };
}

function withQuery(children: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("run view loop outputs", () => {
  it("highlights only the exhausted branch for an iteration_limit loop", () => {
    const view = loopView("iteration_limit");
    const routing = deriveRouting(toRoutingGraph(runSnapshot()), view.executions);
    expect(routing.edges.e1).toBe("dead");
    expect(routing.edges.e2).toBe("active");
    render(
      <RunCanvas
        snapshot={runSnapshot()}
        view={view}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-loop-outcome-refine")).toHaveTextContent("exhausted");
    expect(screen.getByTestId("run-node-ok")).toHaveAttribute("data-node-status", "skipped");
    expect(screen.getByTestId("run-node-spent")).toHaveAttribute("data-node-status", "succeeded");
  });

  it("highlights only the success branch when the condition matched", () => {
    const view = loopView("condition_met");
    const routing = deriveRouting(toRoutingGraph(runSnapshot()), view.executions);
    expect(routing.edges.e1).toBe("active");
    expect(routing.edges.e2).toBe("dead");
    render(
      <RunCanvas
        snapshot={runSnapshot()}
        view={view}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-loop-outcome-refine")).toHaveTextContent("success");
    expect(screen.getByTestId("run-node-spent")).toHaveAttribute("data-node-status", "skipped");
  });

  it("labels an explicit exhausted outcome in the detail panel, not the limit-failure chip", () => {
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={loopView("iteration_limit")}
          events={[]}
          isReplay
          snapshot={runSnapshot()}
        />,
      ),
    );
    expect(screen.getByTestId("detail-loop-outcome")).toHaveTextContent("exhausted");
    expect(screen.getByTestId("detail-loop-iteration")).toHaveTextContent("iteration 2");
    expect(screen.queryByTestId("detail-loop-limit")).toBeNull();
    expect(screen.getByTestId("detail-loop-round-2")).toHaveTextContent("exhausted");
    expect(screen.getByTestId("detail-loop-round-1")).toHaveTextContent("continue");
  });

  it("shows the success outcome and keeps the legacy overflow chip for failed loops", () => {
    const { rerender } = render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={loopView("condition_met")}
          events={[]}
          isReplay
          snapshot={runSnapshot()}
        />,
      ),
    );
    expect(screen.getByTestId("detail-loop-outcome")).toHaveTextContent("success");
    expect(screen.queryByTestId("detail-loop-limit")).toBeNull();
    const legacy = loopView("condition_met");
    const refine = legacy.executions.refine;
    if (!refine?.loop) throw new Error("fixture");
    legacy.executions.refine = {
      ...refine,
      status: "failed",
      loop: {
        ...refine.loop,
        iteration: 3,
        rounds: refine.loop.rounds.map((round) => ({ ...round, done: false, outcome: null })),
      },
    };
    rerender(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={legacy}
          events={[]}
          isReplay
          snapshot={runSnapshot()}
        />,
      ),
    );
    expect(screen.queryByTestId("detail-loop-outcome")).toBeNull();
    expect(screen.getByTestId("detail-loop-limit")).toBeInTheDocument();
  });
});
