import {
  emptyRunView,
  type NodeKind,
  type Path,
  type RunId,
  type RunView,
  reduce,
} from "@devchestra/core";
import { type Graph, nodeAtPath } from "@devchestra/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailPanel } from "../src/run/DetailPanel.js";
import type { WorkflowSnapshot } from "../src/run/RunCanvas.js";

function execution(path: string, kind: NodeKind = "loop") {
  const view = reduce(emptyRunView(), {
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
      init: { kind, requireSubmission: false },
    },
  });
  const created = view.executions[path];
  if (!created) throw new Error(`Missing fixture execution '${path}'`);
  return created;
}

function withQuery(c: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {c}
    </QueryClientProvider>
  );
}

const snapshot: WorkflowSnapshot = {
  name: "Loops",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start" },
      { id: "refine", type: "loop", name: "Refine" },
      { id: "end", type: "end", name: "End" },
    ],
    edges: [
      { id: "e1", from: "start", to: "refine" },
      { id: "e2", from: "refine", to: "end" },
    ],
  },
};

const snapshotWithBody = {
  ...snapshot,
  graph: {
    ...snapshot.graph,
    nodes: snapshot.graph.nodes.map((n) =>
      n.id === "refine"
        ? {
            ...n,
            body: {
              nodes: [
                { id: "start", type: "start", name: "Start round" },
                { id: "review", type: "approval", name: "Review" },
                { id: "done", type: "end", name: "Finish round" },
              ],
              edges: [
                { id: "b1", from: "start", to: "review" },
                { id: "b2", from: "review", to: "done" },
              ],
            },
          }
        : n,
    ),
  },
} as unknown as WorkflowSnapshot;

describe("loop run viewer", () => {
  it("resolves child approval configs via nodeAtPath", () => {
    const found = nodeAtPath(snapshotWithBody.graph as unknown as Graph, "refine#2/review");
    expect(found?.type).toBe("approval");
    expect(nodeAtPath(snapshotWithBody.graph as unknown as Graph, "refine")?.type).toBe("loop");
  });

  it("shows iteration, history and child selection", () => {
    const view: RunView = {
      ...emptyRunView(),
      status: "running" as const,
      executions: {
        refine: {
          ...execution("refine"),
          path: "refine" as Path,
          nodeId: "refine",
          status: "running" as const,
          attempt: 1,
          generation: 2,
          kind: "loop" as const,
          loop: {
            iteration: 2,
            parent: { start: { topic: "captured" } },
            state: { n: 1 },
            rounds: [
              {
                iteration: 1,
                result: { ok: false },
                done: false,
                nextState: { n: 1 },
                eventId: 10,
              },
            ],
          },
        },
      },
    };
    const onSelect = vi.fn();
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={view}
          events={[]}
          isReplay
          snapshot={snapshotWithBody}
          onSelectPath={onSelect}
        />,
      ),
    );
    expect(screen.getByTestId("detail-loop")).toBeDefined();
    expect(screen.getByTestId("detail-loop-iteration")).toHaveTextContent("iteration 2");
    expect(screen.getByTestId("detail-loop-round-1")).toBeDefined();
    const child = screen.getByTestId("detail-loop-child-1-start");
    fireEvent.click(child);
    expect(onSelect).toHaveBeenCalledWith("refine#1/start");
  });

  it("exposes live first-round children before any decision", () => {
    const view: RunView = {
      ...emptyRunView(),
      status: "running" as const,
      executions: {
        refine: {
          ...execution("refine"),
          path: "refine" as Path,
          nodeId: "refine",
          status: "running" as const,
          attempt: 1,
          generation: 1,
          kind: "loop" as const,
          loop: { iteration: 1, parent: {}, state: { n: 0 }, rounds: [] },
        },
        "refine#1/start": {
          ...execution("refine#1/start", "start"),
          path: "refine#1/start" as Path,
          nodeId: "start",
          status: "succeeded" as const,
          attempt: 1,
          generation: 1,
          kind: "start" as const,
        },
        "refine#1/review": {
          ...execution("refine#1/review", "agent"),
          path: "refine#1/review" as Path,
          nodeId: "review",
          status: "running" as const,
          attempt: 1,
          generation: 1,
          kind: "agent" as const,
        },
      },
    };
    const onSelect = vi.fn();
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={view}
          events={[]}
          isReplay
          snapshot={snapshotWithBody}
          onSelectPath={onSelect}
        />,
      ),
    );
    expect(screen.getByTestId("detail-loop-current")).toBeDefined();
    const live = screen.getByTestId("detail-loop-current-review");
    expect(live).toHaveTextContent("running");
    fireEvent.click(live);
    expect(onSelect).toHaveBeenCalledWith("refine#1/review");
  });

  it("clamps the presented round at the iteration limit", () => {
    const limited = {
      ...snapshotWithBody,
      graph: {
        ...snapshotWithBody.graph,
        nodes: snapshotWithBody.graph.nodes.map((n) =>
          n.id === "refine" ? { ...n, maxIterations: 2 } : n,
        ),
      },
    } as unknown as WorkflowSnapshot;
    const view: RunView = {
      ...emptyRunView(),
      status: "failed" as const,
      executions: {
        refine: {
          ...execution("refine"),
          path: "refine" as Path,
          nodeId: "refine",
          status: "failed" as const,
          attempt: 1,
          generation: 1,
          kind: "loop" as const,
          loop: {
            iteration: 3,
            parent: {},
            state: { n: 2 },
            rounds: [
              {
                iteration: 1,
                result: { ok: false },
                done: false,
                nextState: { n: 1 },
                eventId: 10,
              },
              { iteration: 2, result: { ok: false }, done: false, nextState: null, eventId: 11 },
            ],
          },
        },
      },
    };
    render(
      withQuery(
        <DetailPanel
          run={null}
          runId="run-1"
          path="refine"
          nodeLabel="Refine"
          view={view}
          events={[]}
          isReplay
          snapshot={limited}
        />,
      ),
    );
    expect(screen.getByTestId("detail-loop-iteration")).toHaveTextContent("iteration 2");
    expect(screen.getByTestId("detail-loop-limit")).toBeDefined();
  });
});
