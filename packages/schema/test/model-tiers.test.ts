import { describe, expect, it } from "vitest";
import {
  applyModelTiers,
  buildRequires,
  collectModelTierUses,
  mergeModelTiers,
  normalizeWorkflow,
  parseSettings,
  serializeSettings,
  unmappedTierMessage,
  validateWorkflow,
} from "../src/index.js";
import { chainRaw, clone, nodes, parseOk } from "./helpers.js";

function tieredChain(tier = "high"): Record<string, unknown> {
  const raw = clone(chainRaw());
  const agent = nodes(raw)[1] as Record<string, unknown>;
  delete agent.cli;
  agent.tier = tier;
  return raw;
}

function issueCodes(raw: Record<string, unknown>): string[] {
  const report = validateWorkflow(parseOk(raw), { projectKind: "folder" });
  return report.errors.map((entry) => `${entry.code}@${entry.pointer ?? ""}`);
}

describe("agent tier in workflow validation", () => {
  it("accepts a tier in place of cli", () => {
    const report = validateWorkflow(parseOk(tieredChain()), { projectKind: "folder" });
    expect(report.errors).toEqual([]);
  });

  it("rejects a tier combined with cli or model", () => {
    const raw = tieredChain();
    const agent = nodes(raw)[1] as Record<string, unknown>;
    agent.cli = "codex";
    agent.model = "gpt-5";
    const codes = issueCodes(raw);
    expect(codes.some((code) => code.endsWith("/cli"))).toBe(true);
    expect(codes.some((code) => code.endsWith("/model"))).toBe(true);
  });

  it("rejects an agent with neither cli nor tier", () => {
    const raw = tieredChain();
    delete (nodes(raw)[1] as Record<string, unknown>).tier;
    const report = validateWorkflow(parseOk(raw), { projectKind: "folder" });
    expect(report.errors.map((entry) => entry.message)).toContain("Agent must set cli or tier.");
  });

  it("rejects an unknown tier at parse time", () => {
    const raw = tieredChain("ultra");
    expect(() => parseOk(raw)).toThrow();
  });

  it("keeps the tier on the normalized node without a cli", () => {
    const normalized = normalizeWorkflow(parseOk(tieredChain("low")));
    if (!normalized.ok) throw normalized.error;
    const agent = normalized.value.graph.nodes.find((node) => node.type === "agent");
    expect(agent).toMatchObject({ tier: "low" });
    expect(agent).not.toHaveProperty("cli");
  });

  it("lists the tiers a workflow needs", () => {
    const file = parseOk(tieredChain("medium"));
    expect(buildRequires(file.graph.nodes).tiers).toEqual(["medium"]);
    expect(buildRequires(file.graph.nodes).clis).toEqual([]);
  });
});

describe("settings files", () => {
  it("parses and canonicalizes a settings file", () => {
    const parsed = parseSettings(
      JSON.stringify({
        version: 1,
        models: { low: { cli: "pi" }, high: { cli: "claude-code", model: " opus " } },
      }),
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.warnings).toEqual([]);
    expect(parsed.value.file.models?.high).toEqual({ cli: "claude-code", model: "opus" });
    expect(serializeSettings(parsed.value.file)).toBe(
      `${JSON.stringify(
        {
          version: 1,
          models: { high: { cli: "claude-code", model: "opus" }, low: { cli: "pi" } },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("warns about unknown top-level keys instead of failing", () => {
    const parsed = parseSettings('{"version":1,"variables":{"a":1}}');
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.warnings).toEqual(["Ignoring unknown settings key 'variables'."]);
  });

  it.each([
    ["not json", "{"],
    ["wrong version", '{"version":2}'],
    ["unknown tier", '{"version":1,"models":{"ultra":{"cli":"pi"}}}'],
    ["unknown cli", '{"version":1,"models":{"high":{"cli":"fake"}}}'],
    ["extra tier key", '{"version":1,"models":{"high":{"cli":"pi","effort":"x"}}}'],
    ["non-string model", '{"version":1,"models":{"high":{"cli":"pi","model":3}}}'],
  ])("rejects %s", (_name, text) => {
    expect(parseSettings(text).ok).toBe(false);
  });

  it("treats a blank model as the CLI default", () => {
    const parsed = parseSettings('{"version":1,"models":{"high":{"cli":"codex","model":"  "}}}');
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.file.models?.high).toEqual({ cli: "codex" });
  });

  it("lets the local layer win per tier", () => {
    const project = parseSettings(
      '{"version":1,"models":{"high":{"cli":"claude-code","model":"opus"},"low":{"cli":"pi"}}}',
    );
    const local = parseSettings('{"version":1,"models":{"high":{"cli":"codex"}}}');
    if (!project.ok || !local.ok) throw new Error("fixture settings must parse");
    expect(mergeModelTiers(project.value.file, local.value.file)).toEqual({
      high: { ref: { cli: "codex" }, source: "local" },
      low: { ref: { cli: "pi" }, source: "project" },
    });
    expect(mergeModelTiers(null, null)).toEqual({});
  });
});

describe("applyModelTiers", () => {
  const tiers = {
    high: { ref: { cli: "claude-code" as const, model: "opus" }, source: "local" as const },
    low: { ref: { cli: "pi" as const }, source: "project" as const },
  };

  function normalizedWithBody(): unknown {
    const raw = tieredChain("high");
    const graph = raw.graph as { nodes: Record<string, unknown>[] };
    const loopBodyAgent = clone(nodes(raw)[1] as Record<string, unknown>);
    loopBodyAgent.id = "inner";
    loopBodyAgent.tier = "low";
    graph.nodes.push({
      id: "each",
      type: "foreach",
      name: "Each",
      source: { kind: "expression", expression: "start.topic" },
      result: "inner.summary",
      output: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      body: {
        nodes: [
          { id: "start", type: "start", name: "Body inputs", params: [] },
          loopBodyAgent,
          { id: "done", type: "end", name: "Done", status: "success", result: "{}" },
        ],
        edges: [
          { id: "b1", from: "start", to: "inner" },
          { id: "b2", from: "inner", to: "done" },
        ],
      },
    });
    return { schemaVersion: 1, id: "x", name: "x", graph: raw.graph };
  }

  it("writes cli and model into top-level and nested tiered agents", () => {
    const snapshot = normalizedWithBody();
    expect(collectModelTierUses(snapshot).map((use) => use.tier)).toEqual(["high", "low"]);
    const applied = applyModelTiers(snapshot, tiers);
    expect(applied.unresolved).toEqual([]);
    const text = JSON.stringify(applied.snapshot);
    expect(text).toContain('"cli":"claude-code","model":"opus"');
    expect(text).toContain('"cli":"pi"');
    expect(text).not.toContain('"tier"');
    expect(JSON.stringify(snapshot)).not.toContain('"cli":"pi"');
  });

  it("reports tiers with no mapping and leaves those nodes alone", () => {
    const applied = applyModelTiers(normalizedWithBody(), { high: tiers.high });
    expect(applied.unresolved.map((item) => item.tier)).toEqual(["low"]);
    expect(unmappedTierMessage(applied.unresolved)).toContain("'low'");
  });

  it("returns a snapshot without tiers untouched", () => {
    const snapshot = { graph: { nodes: [{ id: "a", type: "shell" }], edges: [] } };
    expect(applyModelTiers(snapshot, {}).snapshot).toBe(snapshot);
  });
});
