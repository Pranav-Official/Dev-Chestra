import {
  decisionHandles,
  parseWorkflow,
  validateWorkflow,
  type DecisionNode,
  type Edge,
  type WorkflowFile,
  type WorkflowNode,
} from "@relay/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorCanvas } from "../src/editor/canvas/EditorCanvas.js";
import { NodePalette } from "../src/editor/canvas/Palette.js";
import { createDefaultNode } from "../src/editor/model/graph.js";
import {
  addDecisionBranch,
  addDecisionLevel,
  addDecisionOption,
  defaultDecisionBandsForLevels,
  defaultDecisionMode,
  removeDecisionBranch,
  removeDecisionLevel,
  removeDecisionOption,
  renameDecisionBranch,
  setDecisionOptionBranch,
  updateDecisionBand,
  updateDecisionLevel,
  updateDecisionOption,
} from "../src/editor/model/routing.js";
import { applyCommandToFile, createEditorState, executeCommand } from "../src/editor/model/commands.js";

function decision(overrides: Partial<DecisionNode> = {}): DecisionNode {
  const base = createDefaultNode("decision", []);
  if (base.type !== "decision") throw new Error("missing decision default");
  return { ...base, ...overrides } as DecisionNode;
}

function fileWith(nodes: WorkflowNode[], edges: Edge[] = []): WorkflowFile {
  return { schemaVersion: 1, id: "wf", name: "Workflow", graph: { nodes, edges } };
}

describe("decision defaults", () => {
  it("creates a valid boolean decision node", () => {
    const node = decision();
    expect(node.provider).toBe("typesafe-jev");
    expect(node.mode).toEqual({ kind: "boolean" });
    expect(node.onError).toBe("fail");
    expect(node.instructions.length).toBeGreaterThan(0);
    expect(node.state).not.toBe("");
  });

  it("validates a start -> decision -> end graph", () => {
    const start = createDefaultNode("start", []);
    const dec = createDefaultNode("decision", [start]);
    const end = createDefaultNode("end", [start, dec]);
    const file = fileWith([start, dec, end], [
      { id: "e1", from: "start", to: dec.id },
      { id: "e2", from: `${dec.id}.true`, to: end.id },
    ]);
    const parsed = parseWorkflow(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.errors).toEqual([]);
  });

  it("builds mode defaults with consistent option<->branch mapping", () => {
    const choice = defaultDecisionMode("choice");
    expect(choice.kind).toBe("choice");
    if (choice.kind !== "choice") return;
    const covered = new Map<string, string>();
    for (const branch of choice.branches)
      for (const value of branch.values) covered.set(value, branch.id);
    for (const option of choice.options) expect(covered.get(option.value)).toBeDefined();

    const score = defaultDecisionMode("score");
    expect(score.kind).toBe("score");
    if (score.kind !== "score") return;
    expect(score.levels.length).toBeGreaterThanOrEqual(2);
    expect(score.bands.at(-1)?.atLeast).toBeNull();
    const numbers = score.bands.map((band) => band.atLeast);
    for (let i = 1; i < numbers.length - 1; i += 1)
      expect(numbers[i] as number).toBeLessThan(numbers[i - 1] as number);
  });
});

describe("decision option<->branch consistency", () => {
  function choiceNode(): DecisionNode {
    return decision({ mode: defaultDecisionMode("choice") });
  }

  it("adds an option into the first branch", () => {
    const next = addDecisionOption(choiceNode());
    expect(next).not.toBeNull();
    if (next === null || next.mode.kind !== "choice") return;
    const added = next.mode.options.at(-1)?.value ?? "";
    expect(next.mode.branches[0]?.values).toContain(added);
    const count = next.mode.branches.flatMap((branch) => branch.values).filter((v) => v === added);
    expect(count).toHaveLength(1);
  });

  it("removes an option from its branch", () => {
    const added = addDecisionOption(choiceNode());
    if (added === null || added.mode.kind !== "choice") throw new Error("no option");
    const value = added.mode.options.at(-1)?.value ?? "";
    const next = removeDecisionOption(added, value);
    expect(next).not.toBeNull();
    if (next === null || next.mode.kind !== "choice") return;
    expect(next.mode.options.some((option) => option.value === value)).toBe(false);
    expect(next.mode.branches.flatMap((branch) => branch.values)).not.toContain(value);
  });

  it("moves an option between branches exactly once", () => {
    const node = choiceNode();
    if (node.mode.kind !== "choice") return;
    const second = node.mode.branches[1]?.id ?? "";
    const moved = setDecisionOptionBranch(node, "yes", second);
    expect(moved).not.toBeNull();
    if (moved === null || moved.mode.kind !== "choice") return;
    const all = moved.mode.branches.flatMap((branch) => branch.values);
    expect(all.filter((value) => value === "yes")).toHaveLength(1);
    expect(moved.mode.branches.find((branch) => branch.id === second)?.values).toContain("yes");
  });

  it("renames an option everywhere it appears", () => {
    const renamed = updateDecisionOption(choiceNode(), "yes", { value: "affirmative" });
    expect(renamed).not.toBeNull();
    if (renamed === null || renamed.mode.kind !== "choice") return;
    expect(renamed.mode.options.some((option) => option.value === "affirmative")).toBe(true);
    expect(renamed.mode.branches.flatMap((branch) => branch.values)).toContain("affirmative");
  });

  it("removing a branch moves orphans to the first remaining branch", () => {
    const node = choiceNode();
    if (node.mode.kind !== "choice") return;
    const removed = removeDecisionBranch(node, "yes");
    expect(removed).not.toBeNull();
    if (removed === null || removed.mode.kind !== "choice") return;
    const all = removed.mode.branches.flatMap((branch) => branch.values);
    expect(all).toContain("yes");
    expect(all.filter((value) => value === "yes")).toHaveLength(1);
  });

  it("refuses to remove the last branch", () => {
    const single = decision({
      mode: {
        kind: "choice",
        options: [{ value: "only" }],
        branches: [{ id: "only", values: ["only"] }],
      },
    });
    expect(removeDecisionBranch(single, "only")).toBeNull();
  });

  it("adds a branch and renames it", () => {
    const added = addDecisionBranch(choiceNode());
    expect(added).not.toBeNull();
    if (added === null || added.mode.kind !== "choice") return;
    const id = added.mode.branches.at(-1)?.id ?? "";
    const renamed = renameDecisionBranch(added, id, "maybe");
    expect(renamed?.mode.kind).toBe("choice");
    if (renamed === null || renamed.mode.kind !== "choice") return;
    expect(renamed.mode.branches.map((branch) => branch.id)).toContain("maybe");
    expect(renameDecisionBranch(renamed, "maybe", "uncertain")).toBeNull();
  });
});

describe("decision level<->band consistency", () => {
  function scoreNode(): DecisionNode {
    return decision({ mode: defaultDecisionMode("score") });
  }

  it("rebuilds default bands when levels change", () => {
    const added = addDecisionLevel(scoreNode());
    expect(added).not.toBeNull();
    if (added === null || added.mode.kind !== "score") return;
    expect(added.mode.bands).toEqual(defaultDecisionBandsForLevels(added.mode.levels));
    const label = added.mode.levels.at(-1)?.label ?? "";
    const removed = removeDecisionLevel(added, label);
    expect(removed?.mode.kind).toBe("score");
    if (removed === null || removed.mode.kind !== "score") return;
    expect(removed.mode.bands).toEqual(defaultDecisionBandsForLevels(removed.mode.levels));
  });

  it("refuses fewer than two levels", () => {
    const node = scoreNode();
    if (node.mode.kind !== "score") return;
    const labels = node.mode.levels.map((level) => level.label);
    const once = removeDecisionLevel(node, labels[0] ?? "");
    expect(once).not.toBeNull();
    if (once === null || once.mode.kind !== "score") return;
    expect(removeDecisionLevel(once, once.mode.levels[0]?.label ?? "")).toBeNull();
  });

  it("renames a level without touching bands", () => {
    const node = scoreNode();
    if (node.mode.kind !== "score") return;
    const bands = node.mode.bands;
    const renamed = updateDecisionLevel(node, "low", { label: "lowest" });
    expect(renamed).not.toBeNull();
    if (renamed === null || renamed.mode.kind !== "score") return;
    expect(renamed.mode.levels.map((level) => level.label)).toContain("lowest");
    expect(renamed.mode.bands).toEqual(bands);
  });

  it("edits band atLeast including the null floor", () => {
    const node = scoreNode();
    if (node.mode.kind !== "score") return;
    const first = node.mode.bands[0]?.id ?? "";
    const lowered = updateDecisionBand(node, first, { atLeast: 1 });
    expect(lowered).not.toBeNull();
    if (lowered === null || lowered.mode.kind !== "score") return;
    expect(lowered.mode.bands[0]?.atLeast).toBe(1);
    expect(updateDecisionBand(node, "nope", { atLeast: 1 })).toBeNull();
  });
});

describe("decision connection rules", () => {
  function connected(): { start: WorkflowNode; dec: DecisionNode; end: WorkflowNode } {
    const start = createDefaultNode("start", []);
    const decBase = createDefaultNode("decision", [start]);
    const end = createDefaultNode("end", [start, decBase]);
    if (decBase.type !== "decision") throw new Error("missing decision");
    return { start, dec: decBase, end };
  }

  it("requires a decision source edge to name one of its handles", () => {
    const { start, dec, end } = connected();
    const file = fileWith([start, dec, end], [{ id: "e1", from: "start", to: dec.id }]);
    const plain = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: dec.id, target: end.id },
    });
    expect(plain.ok).toBe(false);

    const bogus = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: `${dec.id}.nope`, target: end.id },
    });
    expect(bogus.ok).toBe(false);

    const good = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: `${dec.id}.true`, target: end.id },
    });
    expect(good.ok).toBe(true);

    const uncertain = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: `${dec.id}.uncertain`, target: end.id },
    });
    expect(uncertain.ok).toBe(true);
  });

  it("follows the chosen handle when the mode changes", () => {
    const { start, dec, end } = connected();
    const choice: DecisionNode = { ...dec, mode: defaultDecisionMode("choice") };
    const file = fileWith([start, choice, end], [
      { id: "e1", from: "start", to: choice.id },
      { id: "e2", from: `${choice.id}.yes`, to: end.id },
    ]);
    const stale = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: `${choice.id}.true`, target: end.id },
    });
    expect(stale.ok).toBe(false);
  });

  it("rejects a patch that orphans a connected decision handle", () => {
    const { start, dec, end } = connected();
    const choice: DecisionNode = { ...dec, mode: defaultDecisionMode("choice") };
    const file = fileWith([start, choice, end], [
      { id: "e1", from: "start", to: choice.id },
      { id: "e2", from: `${choice.id}.yes`, to: end.id },
    ]);
    const renamed = renameDecisionBranch(choice, "yes", "affirmative");
    expect(renamed).not.toBeNull();
    if (renamed === null) return;
    const outcome = applyCommandToFile(file, {
      kind: "updateRouting",
      nodeId: choice.id,
      patch: { mode: renamed.mode },
    });
    expect(outcome.ok).toBe(false);
    const withRemoval = applyCommandToFile(file, {
      kind: "updateRouting",
      nodeId: choice.id,
      patch: { mode: renamed.mode },
      removeEdgeIds: ["e2"],
    });
    expect(withRemoval.ok).toBe(true);
  });

  it("exposes one handle per branch or band plus uncertain", () => {
    const boolean = decision();
    expect(decisionHandles(boolean)).toEqual(["true", "false", "uncertain"]);
    const choice = decision({ mode: defaultDecisionMode("choice") });
    expect(decisionHandles(choice)).toEqual(["yes", "no", "uncertain"]);
    const score = decision({ mode: defaultDecisionMode("score") });
    expect(decisionHandles(score)).toEqual(["high", "medium", "low", "uncertain"]);
  });
});

describe("decision canvas", () => {
  function canvasFile(edges: Edge[]): WorkflowFile {
    const start = createDefaultNode("start", [], { x: 0, y: 0 });
    const dec = createDefaultNode("decision", [start], { x: 208, y: 0 });
    const end = createDefaultNode("end", [start, dec], { x: 416, y: 0 });
    return { schemaVersion: 1, id: "wf", name: "WF", graph: { nodes: [start, dec, end], edges } };
  }

  function renderCanvas(file: WorkflowFile): void {
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
  }

  it("offers Decision in the palette", () => {
    render(
      <NodePalette
        file={{ schemaVersion: 1, id: "blank", name: "Blank", graph: { nodes: [], edges: [] } }}
        onAdd={() => undefined}
      />,
    );
    expect(screen.getByTestId("palette-add-decision")).toHaveTextContent("Decision");
  });

  it("draws one handle per decision output including uncertain", () => {
    renderCanvas(canvasFile([]));
    expect(screen.getByTestId("ed-decision-handles-decision")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-decision-out-true")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-decision-out-false")).toBeInTheDocument();
    expect(screen.getByTestId("ed-handle-decision-out-uncertain")).toBeInTheDocument();
  });

  it("warns when the uncertain handle is unwired and clears once wired", () => {
    const { rerender } = render(
      <EditorCanvas
        file={canvasFile([])}
        selection={null}
        issues={[]}
        onSelectionChange={() => undefined}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Uncertain route is not wired")).toBeInTheDocument();
    rerender(
      <EditorCanvas
        file={canvasFile([
          { id: "e1", from: "start", to: "decision" },
          { id: "e2", from: "decision.true", to: "end" },
          { id: "e3", from: "decision.uncertain", to: "end" },
        ])}
        selection={null}
        issues={[]}
        onSelectionChange={() => undefined}
        onChange={() => undefined}
        onConnectionRejected={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Uncertain route is not wired")).toBeNull();
  });
});
