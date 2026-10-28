import { describe, expect, it } from "vitest";
import type { AgentNode } from "../src/index.js";
import {
  normalizeWorkflow,
  parseWorkflow,
  parseWorkflowJson,
  serializeWorkflow,
  validateWorkflow,
} from "../src/index.js";
import { chainRaw, clone, node, parseOk } from "./helpers.js";

function agentOf(raw: Record<string, unknown>): Record<string, unknown> {
  return node(raw, "agent");
}

function normalizedAgent(raw: Record<string, unknown>) {
  const result = normalizeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  const agent = result.value.graph.nodes.find((item) => item.id === "agent");
  if (agent?.type !== "agent") throw new Error("missing agent node");
  return agent;
}

describe("agent shell toggle and mcpServers selection", () => {
  it("parses shell true/false and a server selection", () => {
    const raw = chainRaw();
    const agent = agentOf(raw);
    agent.permissions = { network: false, write: ["workspace"], shell: true };
    agent.mcpServers = [
      { name: "github", scope: "global" },
      { name: "docs", scope: "project" },
      { name: "notion", scope: "connector" },
    ];
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    const parsedAgent = parsed.value.graph.nodes.find((item) => item.id === "agent");
    expect(parsedAgent).toMatchObject({
      permissions: { network: false, write: ["workspace"], shell: true },
      mcpServers: [
        { name: "github", scope: "global" },
        { name: "docs", scope: "project" },
        { name: "notion", scope: "connector" },
      ],
    });
    expect(validateWorkflow(parsed.value).ok).toBe(true);
  });

  it("leaves old workflows unchanged: absent stays absent", () => {
    const parsed = parseWorkflow(chainRaw());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    const agent = parsed.value.graph.nodes.find((item): item is AgentNode => item.id === "agent");
    expect(agent?.permissions).not.toHaveProperty("shell");
    expect(agent).not.toHaveProperty("mcpServers");

    const normalized = normalizedAgent(chainRaw());
    expect(normalized.permissions).not.toHaveProperty("shell");
    expect(normalized).not.toHaveProperty("mcpServers");
  });

  it("carries shell and the selection through normalize", () => {
    for (const shell of [true, false]) {
      const raw = chainRaw();
      agentOf(raw).permissions = { network: false, write: [], shell };
      agentOf(raw).mcpServers = [{ name: "github", scope: "global" }];
      const normalized = normalizedAgent(raw);
      expect(normalized.permissions).toMatchObject({ shell });
      expect(normalized.mcpServers).toEqual([{ name: "github", scope: "global" }]);
    }
  });

  it("round-trips shell and mcpServers through serialize", () => {
    const raw = chainRaw();
    agentOf(raw).permissions = { network: true, write: ["workspace"], shell: false };
    agentOf(raw).mcpServers = [
      { name: "github", scope: "global" },
      { name: "docs", scope: "project" },
    ];
    const serialized = serializeWorkflow(parseOk(raw));
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw serialized.error;
    const reparsed = parseWorkflowJson(serialized.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw reparsed.error;
    const agent = reparsed.value.graph.nodes.find((item) => item.id === "agent");
    expect(agent).toMatchObject({
      permissions: { network: true, write: ["workspace"], shell: false },
      mcpServers: [
        { name: "github", scope: "global" },
        { name: "docs", scope: "project" },
      ],
    });
  });

  it("rejects invalid selections and shell values at parse time", () => {
    const cases: Array<{ label: string; mutate: (agent: Record<string, unknown>) => void }> = [
      {
        label: "too many entries",
        mutate: (agent) => {
          agent.mcpServers = Array.from({ length: 33 }, (_, index) => ({
            name: `s${index}`,
            scope: "global",
          }));
        },
      },
      {
        label: "duplicate scope:name",
        mutate: (agent) => {
          agent.mcpServers = [
            { name: "github", scope: "global" },
            { name: "github", scope: "global" },
          ];
        },
      },
      {
        label: "empty name",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "", scope: "global" }];
        },
      },
      {
        label: "name over 128 chars",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "x".repeat(129), scope: "global" }];
        },
      },
      {
        label: "control characters in name",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "gi\nthub", scope: "global" }];
        },
      },
      {
        label: "reserved devchestra name",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "devchestra", scope: "global" }];
        },
      },
      {
        label: "unknown scope",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "github", scope: "user" }];
        },
      },
      {
        label: "unknown field in selection",
        mutate: (agent) => {
          agent.mcpServers = [{ name: "github", scope: "global", command: "evil" }];
        },
      },
      {
        label: "non-boolean shell",
        mutate: (agent) => {
          agent.permissions = { network: false, write: [], shell: "yes" };
        },
      },
    ];
    for (const { label, mutate } of cases) {
      const raw = chainRaw();
      mutate(agentOf(raw));
      const parsed = parseWorkflow(raw);
      expect(parsed.ok, label).toBe(false);
    }
  });

  it("allows the same name in different scopes", () => {
    const raw = chainRaw();
    agentOf(raw).mcpServers = [
      { name: "docs", scope: "global" },
      { name: "docs", scope: "project" },
    ];
    expect(parseWorkflow(raw).ok).toBe(true);
  });

  it("reports semantic issues with JSON pointers", () => {
    const file = parseOk(chainRaw());
    const raw = clone(file) as unknown as Record<string, unknown>;
    const agent = node(raw, "agent");
    agent.permissions = { network: false, write: [], shell: "yes" };
    agent.mcpServers = [
      { name: "github", scope: "global" },
      { name: "github", scope: "global" },
      { name: "devchestra", scope: "project" },
      { name: "docs", scope: "user" },
    ];
    const report = validateWorkflow(raw as unknown as Parameters<typeof validateWorkflow>[0]);
    expect(report.ok).toBe(false);
    const pointers = report.errors.map((item) => `${item.code} ${item.pointer}`);
    expect(pointers).toContain("E_PERMISSIONS /graph/nodes/1/permissions/shell");
    expect(pointers).toContain("E_MCP_SERVERS /graph/nodes/1/mcpServers/1");
    expect(pointers).toContain("E_MCP_SERVERS /graph/nodes/1/mcpServers/2/name");
    expect(pointers).toContain("E_MCP_SERVERS /graph/nodes/1/mcpServers/3/scope");
  });

  it("flags an oversized selection in validate", () => {
    const file = parseOk(chainRaw());
    const raw = clone(file) as unknown as Record<string, unknown>;
    node(raw, "agent").mcpServers = Array.from({ length: 33 }, (_, index) => ({
      name: `s${index}`,
      scope: "global",
    }));
    const report = validateWorkflow(raw as unknown as Parameters<typeof validateWorkflow>[0]);
    expect(report.ok).toBe(false);
    expect(report.errors.map((item) => `${item.code} ${item.pointer}`)).toContain(
      "E_MCP_SERVERS /graph/nodes/1/mcpServers",
    );
  });
});
