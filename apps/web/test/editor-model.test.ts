import {
  parseWorkflow,
  validateWorkflow,
  type WorkflowFile,
  type WorkflowNode,
} from "@relay/schema";
import { describe, expect, it } from "vitest";
import {
  addNodeToFile,
  ancestorNodes,
  applyCommandToFile,
  createDefaultNode,
  createEditorModel,
  createEditorState,
  executeCommand,
  HISTORY_LIMIT,
  markSavedState,
} from "../src/editor/model/index.js";
import type { EditorCommand, EditorState } from "../src/editor/model/types.js";

function blank(): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: { nodes: [], edges: [] },
  };
}

function run(state: EditorState, command: EditorCommand): EditorState {
  const outcome = executeCommand(state, command);
  expect(outcome.ok).toBe(true);
  return outcome.state;
}

function add(state: EditorState, type: Parameters<typeof createDefaultNode>[0]): EditorState {
  return run(state, {
    kind: "addNode",
    node: createDefaultNode(type, state.file.graph.nodes),
  });
}

function chain(): EditorState {
  let state = createEditorState(blank());
  state = add(state, "start");
  state = add(state, "agent");
  state = add(state, "shell");
  state = add(state, "end");
  state = run(state, { kind: "connect", connection: { source: "start", target: "agent" } });
  state = run(state, { kind: "connect", connection: { source: "agent", target: "shell" } });
  state = run(state, { kind: "connect", connection: { source: "shell", target: "end" } });
  return state;
}

describe("editor commands", () => {
  it("adds the four types with stable ergonomic ids and no mutation", () => {
    const initial = blank();
    let state = createEditorState(initial);
    state = add(state, "start");
    state = add(state, "agent");
    state = add(state, "agent");
    state = add(state, "shell");
    state = add(state, "end");
    expect(state.file.graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "agent",
      "agent2",
      "shell",
      "end",
    ]);
    expect(initial.graph.nodes).toHaveLength(0);
    expect(state.revision).toBe(5);
    expect(state.dirty).toBe(true);
  });

  it("builds the empty-to-four-node acceptance graph that the full schema accepts", () => {
    const state = chain();
    const parsed = parseWorkflow(state.file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).not.toContain("W_FAKE_CLI");
  });

  it("uses test-safe defaults for the four palette nodes", () => {
    let state = createEditorState(blank());
    state = add(state, "start");
    state = add(state, "agent");
    state = add(state, "shell");
    state = add(state, "end");
    const byType = new Map(state.file.graph.nodes.map((node) => [node.type, node]));
    const agent = byType.get("agent");
    const shell = byType.get("shell");
    const end = byType.get("end");
    if (agent?.type !== "agent" || shell?.type !== "shell" || end?.type !== "end") {
      throw new Error("missing defaults");
    }
    expect(agent.cli).toBe("codex");
    expect(agent.permissions).toEqual({ network: false, write: ["workspace"] });
    expect(agent).not.toHaveProperty("workspace");
    expect(agent.context).toEqual({ project: "none", workflow: "none" });
    expect(agent.output).toEqual({ type: "object", additionalProperties: true });
    expect(agent.prompt).not.toMatch(/summary|points/iu);
    expect(shell.command.startsWith("printf")).toBe(true);
    expect(shell).not.toHaveProperty("workspace");
    expect(end.result).toBe("{}");
  });

  it("preserves ids when renaming and only changes ui on moves", () => {
    let state = chain();
    state = run(state, { kind: "renameNode", nodeId: "agent", name: "Research" });
    expect(state.file.graph.nodes.find((node) => node.id === "agent")?.name).toBe("Research");
    const before = state.file.graph.nodes.find((node) => node.id === "agent");
    if (before === undefined) throw new Error("missing agent");
    const outcome = executeCommand(state, {
      kind: "moveNode",
      nodeId: "agent",
      position: { x: 251, y: 99 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.change === null) throw new Error("move did not change");
    expect(outcome.change).toEqual({ layoutOnly: true, nodeId: "agent" });
    const after = outcome.state.file.graph.nodes.find((node) => node.id === "agent");
    if (after === undefined) throw new Error("missing moved agent");
    expect(after.ui).toMatchObject({ x: 248, y: 96 });
    const strip = (node: WorkflowNode): unknown => {
      const { ui: _ui, ...rest } = node;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
  });

  it("treats one drag stop moveNodes as one undo step", () => {
    let state = chain();
    const before = state.revision;
    const past = state.past.length;
    state = run(state, {
      kind: "moveNodes",
      positions: { start: { x: 8, y: 8 }, agent: { x: 216, y: 8 } },
    });
    expect(state.revision).toBe(before + 1);
    expect(state.past).toHaveLength(past + 1);
    expect(state.lastChange).toEqual({ layoutOnly: true });
  });

  it("clears the redo branch after a new command", () => {
    let state = chain();
    state = run(state, { kind: "undo" });
    expect(state.future).toHaveLength(1);
    state = add(state, "shell");
    expect(state.future).toHaveLength(0);
    const redo = executeCommand(state, { kind: "redo" });
    expect(redo.ok).toBe(true);
    expect(redo.state.revision).toBe(state.revision);
  });

  it("undoes a CLI change that clears the old model as one command", () => {
    const model = createEditorModel(chain().file);
    expect(model.updateNode("agent", { model: "gpt-5" }).ok).toBe(true);
    const revision = model.getState().revision;
    const clearModel = { cli: "claude-code", model: undefined } as unknown as Parameters<
      typeof model.updateNode
    >[1];
    expect(model.updateNode("agent", clearModel).ok).toBe(true);
    const changed = model.getFile().graph.nodes.find((node) => node.id === "agent");
    expect(changed?.type).toBe("agent");
    if (changed?.type !== "agent") throw new Error("missing agent");
    expect(changed.cli).toBe("claude-code");
    expect(changed.model).toBeUndefined();
    expect(model.getState().revision).toBe(revision + 1);

    expect(model.undo().ok).toBe(true);
    const undone = model.getFile().graph.nodes.find((node) => node.id === "agent");
    if (undone?.type !== "agent") throw new Error("missing agent");
    expect(undone.cli).toBe("codex");
    expect(undone.model).toBe("gpt-5");

    expect(model.redo().ok).toBe(true);
    const redone = model.getFile().graph.nodes.find((node) => node.id === "agent");
    if (redone?.type !== "agent") throw new Error("missing agent");
    expect(redone.cli).toBe("claude-code");
    expect(redone.model).toBeUndefined();
  });

  it("bounds undo history to 100 entries", () => {
    let state = add(createEditorState(blank()), "start");
    for (let index = 1; index <= HISTORY_LIMIT + 20; index += 1) {
      state = run(state, {
        kind: "moveNode",
        nodeId: "start",
        position: { x: index * 8, y: 0 },
      });
    }
    expect(state.past.length).toBe(HISTORY_LIMIT);
    for (let index = 0; index < HISTORY_LIMIT; index += 1) {
      state = run(state, { kind: "undo" });
    }
    const empty = executeCommand(state, { kind: "undo" });
    expect(empty.ok).toBe(true);
    expect(empty.state.file.graph.nodes[0]?.ui).not.toMatchObject({ x: 8, y: 0 });
  });

  it("does not bump revision for selection-only changes", () => {
    let state = chain();
    const revision = state.revision;
    const past = state.past.length;
    state = run(state, { kind: "select", selection: { kind: "node", nodeId: "agent" } });
    expect(state.selection).toEqual({ kind: "node", nodeId: "agent" });
    expect(state.revision).toBe(revision);
    expect(state.past).toHaveLength(past);
  });

  it("marks only the acknowledged revision saved and stays dirty for newer edits", () => {
    let state = add(createEditorState(blank()), "start");
    state = add(state, "agent");
    state = markSavedState(state, 1);
    expect(state.savedRevision).toBe(1);
    expect(state.dirty).toBe(true);
    state = markSavedState(state, 2);
    expect(state.savedRevision).toBe(2);
    expect(state.dirty).toBe(false);
    state = add(state, "end");
    state = markSavedState(state, 2);
    expect(state.savedRevision).toBe(2);
    expect(state.dirty).toBe(true);
    state = markSavedState(state, 3);
    expect(state.dirty).toBe(false);
  });
});

describe("editor model (page-owned history)", () => {
  it("treats a cloned identical document change as a revision-free no-op", () => {
    const model = createEditorModel(blank());
    const before = model.getState();
    const clone = JSON.parse(JSON.stringify(model.getFile())) as WorkflowFile;
    expect(clone).not.toBe(before.file);
    const outcome = model.applyDocumentChange(clone, { layoutOnly: false });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.change).toBeNull();
    expect(model.getState().revision).toBe(0);
    expect(model.getState().past).toHaveLength(0);
    expect(model.getState().file).toBe(before.file);
  });

  it("shares one history between model commands and Canvas full-file changes", () => {
    const model = createEditorModel(blank());
    expect(model.getState().addNode("start").ok).toBe(true);
    expect(model.getState().addNode("agent").ok).toBe(true);
    const added = addNodeToFile(model.getFile(), "shell");
    expect(added).not.toBeNull();
    if (added === null) return;
    expect(model.applyDocumentChange(added.file, added.change).ok).toBe(true);
    expect(model.getState().revision).toBe(3);
    expect(model.getFile().graph.nodes).toHaveLength(3);

    const undone = model.undo();
    expect(undone.ok).toBe(true);
    expect(model.getFile().graph.nodes).toHaveLength(2);
    expect(model.getState().revision).toBe(4);
    model.redo();
    expect(model.getFile().graph.nodes).toHaveLength(3);

    const moved = executeCommand(model.getState(), {
      kind: "moveNode",
      nodeId: "start",
      position: { x: 64, y: 8 },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok || moved.change === null) return;
    model.applyDocumentChange(moved.state.file, moved.change);
    expect(model.getState().lastChange).toEqual({ layoutOnly: true, nodeId: "start" });
    expect(model.getState().dirty).toBe(true);
    model.markSaved(model.getState().revision);
    expect(model.getState().dirty).toBe(false);
    model.load(blank());
    expect(model.getState().past).toHaveLength(0);
    expect(model.getState().revision).toBe(0);
  });
});

describe("connection rules", () => {
  it("allows one linear connection and blocks self, duplicates, start-in and end-out", () => {
    let state = createEditorState(blank());
    state = add(state, "start");
    state = add(state, "agent");
    state = add(state, "end");
    state = run(state, { kind: "connect", connection: { source: "start", target: "agent" } });
    expect(state.file.graph.edges).toHaveLength(1);

    const duplicate = executeCommand(state, {
      kind: "connect",
      connection: { source: "start", target: "agent" },
    });
    expect(duplicate.ok).toBe(false);

    const self = executeCommand(state, {
      kind: "connect",
      connection: { source: "agent", target: "agent" },
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toMatch(/itself/);

    const intoStart = executeCommand(state, {
      kind: "connect",
      connection: { source: "agent", target: "start" },
    });
    expect(intoStart.ok).toBe(false);
    if (!intoStart.ok) expect(intoStart.error).toMatch(/Start/);

    state = add(state, "shell");
    const outOfEnd = executeCommand(state, {
      kind: "connect",
      connection: { source: "end", target: "shell" },
    });
    expect(outOfEnd.ok).toBe(false);
    if (!outOfEnd.ok) expect(outOfEnd.error).toMatch(/End/);
  });

  it("allows fanout but enforces at most one incoming connection", () => {
    let state = createEditorState(blank());
    state = add(state, "start");
    state = add(state, "agent");
    state = add(state, "shell");
    state = add(state, "end");
    state = run(state, { kind: "connect", connection: { source: "start", target: "agent" } });
    const secondIn = executeCommand(state, {
      kind: "connect",
      connection: { source: "shell", target: "agent" },
    });
    expect(secondIn.ok).toBe(false);
    if (!secondIn.ok) expect(secondIn.error).toMatch(/input already/);
    state = run(state, { kind: "connect", connection: { source: "agent", target: "shell" } });
    const secondOut = executeCommand(state, {
      kind: "connect",
      connection: { source: "agent", target: "end" },
    });
    expect(secondOut.ok).toBe(true);
    if (secondOut.ok) expect(secondOut.state.file.graph.edges).toHaveLength(3);
  });

  it("rejects cycles and unsupported node types", () => {
    const agentA = createDefaultNode("agent", []);
    const agentB = createDefaultNode("agent", [agentA]);
    const agentC = createDefaultNode("agent", [agentA, agentB]);
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "Cycles",
      graph: {
        nodes: [agentA, agentB, agentC],
        edges: [
          { id: "e1", from: agentA.id, to: agentB.id },
          { id: "e2", from: agentB.id, to: agentC.id },
        ],
      },
    };
    const cycle = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: agentC.id, target: agentA.id },
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error).toMatch(/cycle/);

    const unsupported = {
      ...agentA,
      id: "map1",
      type: "map",
    } as unknown as WorkflowNode;
    const unsupportedFile: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "Unsupported",
      graph: { nodes: [agentB, unsupported], edges: [] },
    };
    const rejected = executeCommand(createEditorState(unsupportedFile), {
      kind: "connect",
      connection: { source: agentB.id, target: "map1" },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(rejected.error).toMatch(/Start, Agent, Shell, Gate, Join, Approval, Decision and End/);
  });

  it("does not reject a valid edge because another draft field is invalid", () => {
    const start = createDefaultNode("start", []);
    const draft = createDefaultNode("agent", [start]);
    const invalid = {
      ...draft,
      permissions: { network: "not-a-boolean", write: [] },
    } as unknown as WorkflowNode;
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "wf",
      name: "Draft",
      graph: { nodes: [start, invalid], edges: [] },
    };
    const outcome = executeCommand(createEditorState(file), {
      kind: "connect",
      connection: { source: "start", target: invalid.id },
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("deletion and helpers", () => {
  it("removes a node, incident edges and selection atomically", () => {
    let state = chain();
    state = run(state, { kind: "select", selection: { kind: "node", nodeId: "agent" } });
    const outcome = executeCommand(state, { kind: "removeNode", nodeId: "agent" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("remove failed");
    expect(outcome.state.file.graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "shell",
      "end",
    ]);
    expect(outcome.state.file.graph.edges.map((edge) => edge.id)).toEqual(["e-shell-end"]);
    expect(outcome.state.selection).toBeNull();
  });

  it("exports ancestors in graph order and supports addNodeToFile", () => {
    const state = chain();
    expect(ancestorNodes(state.file, "shell").map((node) => node.id)).toEqual(["start", "agent"]);
    const added = addNodeToFile(state.file, "agent");
    expect(added).not.toBeNull();
    if (added === null) return;
    const outcome = applyCommandToFile(state.file, {
      kind: "addNode",
      node: createDefaultNode("shell", state.file.graph.nodes),
    });
    expect(outcome.ok).toBe(true);
  });
});
