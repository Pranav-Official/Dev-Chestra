import { parseWorkflow, type WorkflowFile } from "../src/index.js";

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function parseOk(raw: unknown): WorkflowFile {
  const parsed = parseWorkflow(raw);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

/** Minimal valid four-node chain. Every test mutates a deep clone. */
export function chainRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "chain",
    name: "Chain",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Inputs",
          params: [
            { name: "topic", type: "string", required: true },
            {
              name: "style",
              type: "enum",
              options: ["brief", "detailed"],
              default: "brief",
              required: false,
            },
          ],
        },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          cli: "fake",
          prompt: "Write about {{ start.topic }}.",
          output: {
            type: "object",
            properties: {
              summary: { type: "string", maxLength: 100 },
              tags: { type: "array", items: { type: "string" }, maxItems: 3 },
            },
            required: ["summary"],
          },
          permissions: { network: false, write: ["workspace"] },
          workspace: { mode: "scratch" },
        },
        {
          id: "shell",
          type: "shell",
          name: "Shell",
          command: "printf '%s' {{ agent.summary }}",
          workspace: { mode: "scratch" },
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: '{ "summary": agent.summary }',
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "shell" },
        { id: "e3", from: "shell", to: "end" },
      ],
    },
  };
}

export function nodes(raw: Record<string, unknown>): Record<string, unknown>[] {
  const graph = raw.graph as { nodes: Record<string, unknown>[] };
  return graph.nodes;
}

export function edges(raw: Record<string, unknown>): Record<string, unknown>[] {
  const graph = raw.graph as { edges: Record<string, unknown>[] };
  return graph.edges;
}

export function node(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const found = nodes(raw).find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing node ${id}`);
  return found;
}

function fakeAgent(id: string, output: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: "agent",
    name: id,
    cli: "fake",
    prompt: `Run ${id} on {{ start.topic }}.`,
    output,
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
  };
}

/** Gate fan-out into a join with two fake branches. Join mode 'all'. */
export function routingRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "routing",
    name: "Routing",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Inputs",
          params: [{ name: "topic", type: "string", required: true }],
        },
        {
          id: "gate",
          type: "gate",
          name: "Triage",
          branches: [
            { id: "quick", when: "start.topic = 'quick'" },
            { id: "careful", when: "start.topic = 'careful'" },
            { id: "otherwise", otherwise: true },
          ],
        },
        fakeAgent("fast", {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        }),
        fakeAgent("slow", {
          type: "object",
          properties: { summary: { type: "string" }, note: { type: "string" } },
          required: ["summary"],
        }),
        {
          id: "join",
          type: "join",
          name: "Merge",
          mode: "all",
          inputs: ["slow", "fast"],
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: '{ "fast": fast.summary, "slow": slow.summary }',
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "gate" },
        { id: "e2", from: "gate.quick", to: "fast" },
        { id: "e3", from: "gate.careful", to: "slow" },
        { id: "e4", from: "fast", to: "join.fast" },
        { id: "e5", from: "slow", to: "join.slow" },
        { id: "e6", from: "join", to: "end" },
      ],
    },
  };
}

/** Plain fan-out into a join (no gate). */
export function fanoutRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "fanout",
    name: "Fanout",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Inputs",
          params: [{ name: "topic", type: "string", required: true }],
        },
        fakeAgent("left", {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        }),
        fakeAgent("right", {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        }),
        {
          id: "join",
          type: "join",
          name: "Merge",
          mode: "first",
          inputs: ["left", "right"],
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: '{ "joined": join }',
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "left" },
        { id: "e2", from: "start", to: "right" },
        { id: "e3", from: "left", to: "join.left" },
        { id: "e4", from: "right", to: "join.right" },
        { id: "e5", from: "join", to: "end" },
      ],
    },
  };
}
