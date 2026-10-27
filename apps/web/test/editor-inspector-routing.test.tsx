import {
  type Edge,
  type GateNode,
  type JoinNode,
  parseWorkflow,
  type WorkflowFile,
  type WorkflowNode,
} from "@relay/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  GateTester,
  type GateTestResultLike,
  MAX_BRANCHES,
} from "../src/editor/inspector/GateTester.js";
import { Inspector } from "../src/editor/inspector/Inspector.js";

const gate: GateNode = {
  id: "gate",
  type: "gate",
  name: "Route",
  branches: [
    { id: "branch", when: "true" },
    { id: "otherwise", otherwise: true },
  ],
};

const join: JoinNode = {
  id: "join",
  type: "join",
  name: "Merge",
  mode: "all",
  inputs: ["yes", "no"],
};

function Harness({ initial, edges = [] }: { initial: WorkflowNode; edges?: Edge[] }) {
  const [node, setNode] = useState<WorkflowNode>(initial);
  const [edgeList, setEdgeList] = useState<Edge[]>(edges);
  const [log, setLog] = useState<Array<{ patch: Record<string, unknown>; removed: string[] }>>([]);
  return (
    <div>
      <Inspector
        node={node}
        issues={[]}
        edges={edgeList}
        onPatch={(_nodeId, patch) =>
          setNode((previous) => ({ ...previous, ...patch }) as WorkflowNode)
        }
        onRoutingChange={(_nodeId, patch, removed) => {
          setLog((previous) => [
            ...previous,
            { patch: patch as Record<string, unknown>, removed: [...removed] },
          ]);
          setNode((previous) => ({ ...previous, ...patch }) as WorkflowNode);
          setEdgeList((previous) => previous.filter((edge) => !removed.includes(edge.id)));
        }}
      />
      <pre data-testid="routing-log">{JSON.stringify(log)}</pre>
    </div>
  );
}

function logs(): Array<{ patch: Record<string, unknown>; removed: string[] }> {
  return JSON.parse(screen.getByTestId("routing-log").textContent ?? "[]") as Array<{
    patch: Record<string, unknown>;
    removed: string[];
  }>;
}

describe("Gate inspector", () => {
  it("edits conditions, inserts before otherwise and keeps otherwise last", async () => {
    render(<Harness initial={gate} />);
    fireEvent.change(screen.getByTestId("gate-branch-0-when"), {
      target: { value: "start.ok = true" },
    });
    await waitFor(() => {
      const branches = logs().at(-1)?.patch.branches as GateNode["branches"];
      expect(branches?.[0]?.when).toBe("start.ok = true");
      expect(branches?.at(-1)).toEqual({ id: "otherwise", otherwise: true });
    });

    fireEvent.click(screen.getByTestId("gate-branch-add"));
    await waitFor(() => {
      const branches = logs().at(-1)?.patch.branches as GateNode["branches"];
      expect(branches?.map((branch) => branch.id)).toEqual(["branch", "branch2", "otherwise"]);
      expect(branches?.at(-1)).toEqual({ id: "otherwise", otherwise: true });
    });
    expect(screen.getByTestId("gate-branch-2")).toHaveTextContent("Otherwise (always last)");
    expect(screen.queryByTestId("gate-branch-2-when")).toBeNull();
  });

  it("blocks renaming a connected branch and removes connected deletions atomically", async () => {
    const edge: Edge = { id: "e1", from: "gate.branch", to: "agent" };
    render(<Harness initial={gate} edges={[edge]} />);
    fireEvent.change(screen.getByTestId("gate-branch-0-id"), {
      target: { value: "renamed" },
    });
    fireEvent.blur(screen.getByTestId("gate-branch-0-id"));
    expect(await screen.findByText(/Disconnect its edge/)).toBeInTheDocument();
    expect(logs()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("gate-branch-0-remove"));
    await waitFor(() => {
      const last = logs().at(-1);
      expect(last?.removed).toEqual(["e1"]);
      const branches = last?.patch.branches as GateNode["branches"];
      expect(branches?.map((branch) => branch.id)).toEqual(["otherwise"]);
    });
  });

  it("renames an unconnected branch", async () => {
    render(<Harness initial={gate} />);
    fireEvent.change(screen.getByTestId("gate-branch-0-id"), { target: { value: "fast_path" } });
    fireEvent.blur(screen.getByTestId("gate-branch-0-id"));
    await waitFor(() => {
      const branches = logs().at(-1)?.patch.branches as GateNode["branches"];
      expect(branches?.[0]?.id).toBe("fast_path");
    });
  });
});

describe("Join inspector", () => {
  it("edits mode, adds and renames inputs, and removes connected inputs", async () => {
    const edge: Edge = { id: "e1", from: "agent", to: "join.yes" };
    render(<Harness initial={join} edges={[edge]} />);
    expect(screen.getByTestId("join-mode")).toHaveAccessibleName("Mode");
    fireEvent.change(screen.getByTestId("join-mode"), { target: { value: "first" } });
    await waitFor(() => expect(logs().at(-1)?.patch.mode).toBe("first"));

    fireEvent.click(screen.getByTestId("join-input-add"));
    await waitFor(() => {
      expect(logs().at(-1)?.patch.inputs).toEqual(["yes", "no", "input"]);
    });

    fireEvent.change(screen.getByTestId("join-input-0-name"), { target: { value: "renamed" } });
    fireEvent.blur(screen.getByTestId("join-input-0-name"));
    expect(await screen.findByText(/Disconnect its edge/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("join-input-0-remove"));
    await waitFor(() => {
      const last = logs().at(-1);
      expect(last?.removed).toEqual(["e1"]);
      expect(last?.patch.inputs).toEqual(["no", "input"]);
    });
  });

  it("commits an input rename on blur and Enter through the real input", async () => {
    render(<Harness initial={join} />);
    const input = screen.getByTestId("join-input-0-name");
    fireEvent.change(input, { target: { value: "renamed" } });
    expect(logs()).toHaveLength(0);
    fireEvent.blur(input);
    await waitFor(() => {
      expect(logs().at(-1)?.patch.inputs).toEqual(["renamed", "no"]);
    });

    const renamedInput = screen.getByTestId("join-input-0-name");
    fireEvent.change(renamedInput, { target: { value: "enter_name" } });
    fireEvent.keyDown(renamedInput, { key: "Enter" });
    await waitFor(() => {
      expect(logs().at(-1)?.patch.inputs).toEqual(["enter_name", "no"]);
    });
  });

  it("keeps an inspector rename through save-file parse and reload", async () => {
    const view = render(<Harness initial={join} />);
    const input = screen.getByTestId("join-input-0-name");
    fireEvent.change(input, { target: { value: "persisted" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(logs().at(-1)?.patch.inputs).toEqual(["persisted", "no"]);
    });
    const inputs = logs().at(-1)?.patch.inputs as string[];
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "routing",
      name: "Routing",
      graph: { nodes: [{ ...join, inputs }], edges: [] },
    };
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(file)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reloaded = parsed.value.graph.nodes[0];
    if (reloaded?.type !== "join") throw new Error("reloaded node is not a join");
    view.unmount();
    render(<Harness initial={reloaded} />);
    expect(screen.getByTestId("join-input-0-name")).toHaveValue("persisted");
    expect(screen.getByTestId("join-input-1-name")).toHaveValue("no");
  });

  it("toggles an optional output schema", async () => {
    render(<Harness initial={join} />);
    fireEvent.click(screen.getByTestId("join-output-toggle"));
    await waitFor(() => {
      expect(logs().at(-1)?.patch.output).toEqual({
        type: "object",
        additionalProperties: true,
      });
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Gate tester", () => {
  it("uses the shared 32-branch bound and refuses to call the server above it", async () => {
    expect(MAX_BRANCHES).toBe(32);
    const tooMany: GateNode = {
      ...gate,
      branches: [
        ...Array.from({ length: 32 }, (_, index) => ({
          id: `b${index}`,
          when: "true",
        })),
        { id: "otherwise", otherwise: true },
      ],
    };
    const runTest = vi.fn(async () => ({ branch: "b0", evaluated: [] }));
    render(<GateTester node={tooMany} projectId="p" runTest={runTest} />);
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    expect(await screen.findByText(/1–32 branches/)).toBeInTheDocument();
    expect(runTest).not.toHaveBeenCalled();
  });

  it("shows the chosen branch and per-branch evaluation", async () => {
    const result: GateTestResultLike = {
      branch: "branch",
      evaluated: [{ branch: "branch", matched: true }],
    };
    render(<GateTester node={gate} projectId="p" runTest={async () => result} />);
    expect(screen.getByTestId("gate-tester-scope")).toHaveAccessibleName("Sample scope (JSON)");
    fireEvent.change(screen.getByTestId("gate-tester-scope"), {
      target: { value: '{"start":{"ok":true}}' },
    });
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    expect(await screen.findByTestId("gate-tester-branch")).toHaveTextContent(
      "Takes branch branch",
    );
    expect(screen.getByTestId("gate-tester-evaluated-branch")).toHaveTextContent("branch: true");
  });

  it("shows non-boolean/evaluation failures and invalid JSON without calling the server", async () => {
    const runTest = vi.fn(async () => ({
      branch: null,
      evaluated: [{ branch: "branch", matched: false, error: "non-boolean result" }],
      error: { code: "E_EXPR", message: "Gate branch returned a non-boolean" },
    }));
    render(<GateTester node={gate} projectId="p" runTest={runTest} />);
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    expect(await screen.findByTestId("gate-tester-error")).toHaveTextContent("non-boolean");

    fireEvent.change(screen.getByTestId("gate-tester-scope"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(runTest).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale reply after the gate or sample changes", async () => {
    const first = deferred<GateTestResultLike>();
    const second = deferred<GateTestResultLike>();
    const calls: Array<GateTestResultLike | Promise<GateTestResultLike>> = [
      first.promise,
      second.promise,
    ];
    const runTest = vi.fn(() => {
      const next = calls.shift();
      if (next === undefined) throw new Error("unexpected call");
      return Promise.resolve(next);
    });
    render(<GateTester node={gate} projectId="p" runTest={runTest} />);
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    await waitFor(() => expect(runTest).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("gate-tester-scope"), { target: { value: '{"x":1}' } });
    fireEvent.click(screen.getByTestId("gate-tester-run"));
    await waitFor(() => expect(runTest).toHaveBeenCalledTimes(2));

    second.resolve({ branch: null, evaluated: [], error: { code: "E_EXPR", message: "second" } });
    expect(await screen.findByTestId("gate-tester-error")).toHaveTextContent("second");
    first.resolve({ branch: "branch", evaluated: [{ branch: "branch", matched: true }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("gate-tester-error")).toHaveTextContent("second");
    expect(screen.queryByTestId("gate-tester-branch")).toBeNull();
  });
});
