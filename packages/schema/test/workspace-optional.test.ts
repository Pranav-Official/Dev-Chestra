import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../src/normalize.js";
import { validateWorkflow } from "../src/validate.js";
import { chainRaw, nodes, parseOk } from "./helpers.js";

describe("legacy node workspace is optional", () => {
  it("parses, validates and normalizes missing node workspaces to scratch", () => {
    const raw = chainRaw();
    for (const node of nodes(raw)) {
      if (node.type === "agent" || node.type === "shell") delete node.workspace;
    }
    const parsed = parseOk(raw);
    expect(validateWorkflow(parsed).ok).toBe(true);
    const normalized = normalizeWorkflow(parsed);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw normalized.error;
    for (const node of normalized.value.graph.nodes) {
      if (node.type === "agent" || node.type === "shell") {
        expect(node.workspace).toEqual({ mode: "scratch" });
      }
    }
  });

  it("still accepts explicit legacy worktree metadata", () => {
    const raw = chainRaw();
    for (const node of nodes(raw)) {
      if (node.type === "agent" || node.type === "shell") node.workspace = { mode: "worktree" };
    }
    const normalized = normalizeWorkflow(parseOk(raw));
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw normalized.error;
    const agent = normalized.value.graph.nodes.find((node) => node.type === "agent");
    expect(agent?.workspace).toEqual({ mode: "worktree" });
  });
});
