import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/index.js";
import { chainRaw, clone, node, parseOk } from "./helpers.js";

function codexAgent(id: string): Record<string, unknown> {
  return {
    id,
    type: "agent",
    name: id,
    cli: "codex",
    prompt: "Do {{ foreach.item }}.",
    output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
  };
}

function foreachWithBody(): Record<string, unknown> {
  const raw = clone(chainRaw());
  const graph = raw.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  graph.nodes = [
    graph.nodes[0] as Record<string, unknown>,
    {
      id: "each",
      type: "foreach",
      name: "Each",
      source: { kind: "expression", expression: "start.topic" },
      result: "work.summary",
      output: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      body: {
        nodes: [
          { id: "start", type: "start", name: "Body inputs", params: [] },
          codexAgent("work"),
          {
            id: "done",
            type: "end",
            name: "Round done",
            status: "success",
            result: "work.summary",
          },
        ],
        edges: [
          { id: "b1", from: "start", to: "work" },
          { id: "b2", from: "work", to: "done" },
        ],
      },
    },
    { id: "end", type: "end", name: "End", status: "success", result: "each.summary" },
  ];
  graph.edges = [
    { id: "e1", from: "start", to: "each" },
    { id: "e2", from: "each", to: "end" },
  ];
  return raw;
}

describe("disabled provider warning", () => {
  it("warns once on a disabled codex agent and keeps the workflow ok", () => {
    const raw = clone(chainRaw());
    node(raw, "agent").cli = "codex";
    const report = validateWorkflow(parseOk(raw), { disabledClis: ["codex"] });
    const warnings = report.warnings.filter((item) => item.code === "W_CLI_DISABLED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.pointer?.endsWith("/cli")).toBe(true);
    expect(warnings[0]?.message).toContain("Codex");
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("stays silent when the provider is enabled or the list is absent", () => {
    const raw = clone(chainRaw());
    node(raw, "agent").cli = "codex";
    const file = parseOk(raw);
    const codes = (ctx: Parameters<typeof validateWorkflow>[1]) =>
      validateWorkflow(file, ctx).warnings.map((item) => item.code);
    expect(codes({ disabledClis: [] })).not.toContain("W_CLI_DISABLED");
    expect(codes({ disabledClis: ["claude-code"] })).not.toContain("W_CLI_DISABLED");
    expect(codes({})).not.toContain("W_CLI_DISABLED");
  });

  it("warns on a disabled agent inside a foreach body", () => {
    const report = validateWorkflow(parseOk(foreachWithBody()), { disabledClis: ["codex"] });
    const warnings = report.warnings.filter((item) => item.code === "W_CLI_DISABLED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.nodeId).toBe("work");
    expect(report.ok).toBe(true);
  });
});
