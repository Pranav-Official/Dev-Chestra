import {
  type GateNode,
  type JoinNode,
  parseWorkflow,
  validateWorkflow,
  type WorkflowFile,
} from "@relay/schema";
import { describe, expect, it } from "vitest";
import {
  applyCommandToFile,
  createDefaultNode,
  createEdgeId,
  createEditorState,
  type EditorState,
  executeCommand,
  MAX_EDGE_ID_LENGTH,
} from "../src/editor/model/index.js";
import {
  addGateBranch,
  addJoinInput,
  edgesFromGateBranch,
  edgesIntoJoinInput,
  moveGateBranch,
} from "../src/editor/model/routing.js";

function blank(): WorkflowFile {
  return { schemaVersion: 1, id: "routing", name: "Routing", graph: { nodes: [], edges: [] } };
}

function add(
  state: EditorState,
  type: Parameters<typeof createDefaultNode>[0],
): { state: EditorState; id: string } {
  const node = createDefaultNode(type, state.file.graph.nodes);
  const outcome = executeCommand(state, { kind: "addNode", node });
  if (!outcome.ok) throw new Error(outcome.error);
  return { state: outcome.state, id: node.id };
}

function connect(state: EditorState, from: string, to: string): EditorState {
  const outcome = executeCommand(state, {
    kind: "connect",
    connection: { source: from, target: to },
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.state;
}

function branching(): { state: EditorState; gateId: string; joinId: string } {
  let state = createEditorState(blank());
  const startNode = add(state, "start");
  state = startNode.state;
  const gateNode = add(state, "gate");
  state = gateNode.state;
  const aNode = add(state, "agent");
  state = aNode.state;
  const bNode = add(state, "agent");
  state = bNode.state;
  const joinNode = add(state, "join");
  state = joinNode.state;
  const endNode = add(state, "end");
  state = endNode.state;
  const startId = startNode.id;
  const gateId = gateNode.id;
  const aId = aNode.id;
  const bId = bNode.id;
  const joinId = joinNode.id;
  const endId = endNode.id;
  const withInputs = executeCommand(state, {
    kind: "updateRouting",
    nodeId: joinId,
    patch: { inputs: ["yes", "no"] },
  });
  if (!withInputs.ok) throw new Error(withInputs.error);
  state = withInputs.state;
  state = connect(state, startId, gateId);
  state = connect(state, `${gateId}.branch`, aId);
  state = connect(state, `${gateId}.otherwise`, bId);
  state = connect(state, aId, `${joinId}.yes`);
  state = connect(state, bId, `${joinId}.no`);
  state = connect(state, joinId, endId);
  return { state, gateId, joinId };
}

describe("gate and join editor model", () => {
  it("creates stable defaults with otherwise last and a declared join input", () => {
    let state = createEditorState(blank());
    const gateNode = add(state, "gate");
    state = gateNode.state;
    const joinNode = add(state, "join");
    state = joinNode.state;
    const gateId = gateNode.id;
    const joinId = joinNode.id;
    const gate = state.file.graph.nodes.find((node) => node.id === gateId);
    const join = state.file.graph.nodes.find((node) => node.id === joinId);
    if (gate?.type !== "gate" || join?.type !== "join") throw new Error("missing routing nodes");
    expect(gate.branches.map((branch) => branch.id)).toEqual(["branch", "otherwise"]);
    expect(gate.branches.at(-1)?.otherwise).toBe(true);
    expect(join.mode).toBe("all");
    expect(join.inputs).toEqual(["input"]);

    const added = addGateBranch(gate);
    expect(added.branches.map((branch) => branch.id)).toEqual(["branch", "branch2", "otherwise"]);
    expect(added.branches[1]?.when).toBe("false");
    expect(moveGateBranch(added, "otherwise", "up")).toBeNull();
    expect(addJoinInput(join).inputs).toEqual(["input", "input2"]);
  });

  it("accepts a complete gate/join DAG and preserves endpoints through save and reload", () => {
    const { state, gateId, joinId } = branching();
    const saved = JSON.stringify(state.file);
    const parsed = parseWorkflow(JSON.parse(saved));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);

    const endpoints = parsed.value.graph.edges.map((edge) => [edge.from, edge.to]);
    expect(endpoints).toContainEqual([`${gateId}.branch`, "agent"]);
    expect(endpoints).toContainEqual([`${gateId}.otherwise`, "agent2"]);
    expect(endpoints).toContainEqual(["agent", `${joinId}.yes`]);
    expect(endpoints).toContainEqual(["agent2", `${joinId}.no`]);
    expect(parsed.value).toEqual(state.file);
  });

  it("removes a connected gate branch and its edge in one undoable command", () => {
    const { state, gateId } = branching();
    const branchEdge = edgesFromGateBranch(state.file, gateId, "branch");
    expect(branchEdge).toHaveLength(1);
    const gate = state.file.graph.nodes.find((node) => node.id === gateId);
    if (gate?.type !== "gate") throw new Error("missing gate");

    const outcome = executeCommand(state, {
      kind: "updateRouting",
      nodeId: gateId,
      patch: { branches: gate.branches.filter((branch) => branch.id !== "branch") },
      removeEdgeIds: branchEdge.map((edge) => edge.id),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.file.graph.edges.some((edge) => edge.from === `${gateId}.branch`)).toBe(
      false,
    );

    const undone = executeCommand(outcome.state, { kind: "undo" });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.file.graph.edges).toEqual(state.file.graph.edges);
    const restored = undone.state.file.graph.nodes.find((node) => node.id === gateId);
    if (restored?.type !== "gate") throw new Error("missing gate");
    expect(restored.branches).toEqual(gate.branches);
  });

  it("rejects renaming connected handles and allows unconnected ones", () => {
    const { state, gateId, joinId } = branching();
    const gate = state.file.graph.nodes.find((node) => node.id === gateId);
    if (gate?.type !== "gate") throw new Error("missing gate");
    const rejected = executeCommand(state, {
      kind: "updateRouting",
      nodeId: gateId,
      patch: {
        branches: gate.branches.map((branch) =>
          branch.id === "branch" ? { ...branch, id: "renamed" } : branch,
        ),
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/connected/);

    const join = state.file.graph.nodes.find((node) => node.id === joinId);
    if (join?.type !== "join") throw new Error("missing join");
    const inputRejected = executeCommand(state, {
      kind: "updateRouting",
      nodeId: joinId,
      patch: { inputs: ["renamed", "no"] },
    });
    expect(inputRejected.ok).toBe(false);

    const unconnected = addGateBranch(gate);
    const renamed = executeCommand(state, {
      kind: "updateRouting",
      nodeId: gateId,
      patch: {
        branches: unconnected.branches.map((branch) =>
          branch.id === "branch2" ? { ...branch, id: "other" } : branch,
        ),
      },
    });
    expect(renamed.ok).toBe(true);
  });

  it("removes a connected join input and its edge atomically", () => {
    const { state, joinId } = branching();
    const edge = edgesIntoJoinInput(state.file, joinId, "yes");
    expect(edge).toHaveLength(1);
    const join = state.file.graph.nodes.find((node) => node.id === joinId);
    if (join?.type !== "join") throw new Error("missing join");
    const outcome = executeCommand(state, {
      kind: "updateRouting",
      nodeId: joinId,
      patch: { inputs: join.inputs.filter((input) => input !== "yes") },
      removeEdgeIds: edge.map((item) => item.id),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.file.graph.edges.some((item) => item.to === `${joinId}.yes`)).toBe(false);
  });

  it("requires branch/input handles, one edge per join input, and blocks local cycles", () => {
    const { state, gateId, joinId } = branching();
    const gate = state.file.graph.nodes.find((node) => node.id === gateId);
    if (gate?.type !== "gate") throw new Error("missing gate");

    const plainGate = executeCommand(state, {
      kind: "connect",
      connection: { source: gateId, target: "join" },
    });
    expect(plainGate.ok).toBe(false);
    if (!plainGate.ok) expect(plainGate.error).toMatch(/branch handle/);

    const duplicateInput = executeCommand(state, {
      kind: "connect",
      connection: { source: "agent", target: `${joinId}.yes` },
    });
    expect(duplicateInput.ok).toBe(false);

    const plainJoin = applyCommandToFile(state.file, {
      kind: "connect",
      connection: { source: "agent", target: joinId },
    });
    expect(plainJoin.ok).toBe(false);

    const cycle = executeCommand(state, {
      kind: "connect",
      connection: { source: "end", target: `${gateId}.branch` },
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error).toMatch(/End/);
  });

  it("caps generated edge ids at 128 for maximum-valid endpoints and collision suffixes", () => {
    const gateId = "a".repeat(48);
    const branchId = "b".repeat(64);
    const joinId = "c".repeat(48);
    const inputName = "d".repeat(64);
    const gate: GateNode = {
      ...(createDefaultNode("gate", []) as GateNode),
      id: gateId,
      branches: [
        { id: branchId, when: "true" },
        { id: "otherwise", otherwise: true },
      ],
    };
    const join: JoinNode = {
      ...(createDefaultNode("join", []) as JoinNode),
      id: joinId,
      inputs: [inputName],
    };
    const file: WorkflowFile = {
      schemaVersion: 1,
      id: "routing",
      name: "Routing",
      graph: { nodes: [gate, join], edges: [] },
    };
    const source = `${gateId}.${branchId}`;
    const target = `${joinId}.${inputName}`;
    const outcome = applyCommandToFile(file, {
      kind: "connect",
      connection: { source, target },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [edge] = outcome.state.file.graph.edges;
    if (edge === undefined) throw new Error("missing edge");
    expect(edge.id.length).toBeLessThanOrEqual(MAX_EDGE_ID_LENGTH);
    expect(edge.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(edge.from).toBe(source);
    expect(edge.to).toBe(target);

    const collision = createEdgeId(source, target, [edge]);
    expect(collision).not.toBe(edge.id);
    expect(collision.length).toBeLessThanOrEqual(MAX_EDGE_ID_LENGTH);
    expect(collision).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(collision.endsWith("-2")).toBe(true);
  });

  it("allows fanout from a normal node without creating a second inbound edge", () => {
    let state = createEditorState(blank());
    const startNode = add(state, "start");
    state = startNode.state;
    const agentNode = add(state, "agent");
    state = agentNode.state;
    const firstNode = add(state, "end");
    state = firstNode.state;
    const secondNode = add(state, "end");
    state = secondNode.state;
    state = connect(state, startNode.id, agentNode.id);
    state = connect(state, agentNode.id, firstNode.id);
    state = connect(state, agentNode.id, secondNode.id);
    expect(state.file.graph.edges).toHaveLength(3);
  });
});
