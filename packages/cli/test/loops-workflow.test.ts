import { normalizeWorkflow, parseWorkflow } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { requireFakeScriptForFakeNodes, workflowRequiresRealAdapter } from "../src/workflow.js";

function workflow(cli: string) {
  const node = (id: string, type: string, fields: Record<string, unknown> = {}) => ({
    id,
    type,
    name: id,
    ...fields,
  });
  const parsed = parseWorkflow({
    schemaVersion: 1,
    id: "loop-cli",
    name: "Loop CLI",
    graph: {
      nodes: [
        node("start", "start", { params: [] }),
        node("refine", "loop", {
          mode: "repeatUntil",
          maxIterations: 2,
          result: "work",
          until: "true",
          output: { type: "object", additionalProperties: true },
          body: {
            nodes: [
              node("start", "start", { params: [] }),
              node("work", "agent", {
                cli,
                prompt: "Work",
                output: { type: "object", additionalProperties: true },
                permissions: { network: false, write: ["workspace"] },
              }),
              node("done", "end", { status: "success", result: "work" }),
            ],
            edges: [
              { id: "a", from: "start", to: "work" },
              { id: "b", from: "work", to: "done" },
            ],
          },
        }),
        node("end", "end", { status: "success", result: "refine" }),
      ],
      edges: [
        { id: "a", from: "start", to: "refine" },
        { id: "b", from: "refine", to: "end" },
      ],
    },
  });
  if (!parsed.ok) throw parsed.error;
  const normalized = normalizeWorkflow(parsed.value);
  if (!normalized.ok) throw normalized.error;
  return normalized.value;
}

describe("CLI agent discovery in loop bodies", () => {
  it("requires a real adapter when the only agent is inside a loop", () => {
    const file = workflow("codex");
    expect(workflowRequiresRealAdapter(file)).toBe(true);
    expect(requireFakeScriptForFakeNodes(file)).toBe(false);
  });

  it("requires an explicit fake script for fake agents inside loops", () => {
    const file = workflow("fake");
    expect(workflowRequiresRealAdapter(file)).toBe(false);
    expect(requireFakeScriptForFakeNodes(file)).toBe(true);
  });
});
