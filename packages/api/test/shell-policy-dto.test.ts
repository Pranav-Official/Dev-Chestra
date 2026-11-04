import { parseWorkflowDraft, validateWorkflow } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { workflowDraftSchema } from "../src/index.js";

/** Minimal draft: start -> agent -> end, with the given agent permissions. */
function draftWith(permissions: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "shell-policy",
    name: "Shell policy",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Inputs", params: [] },
        {
          id: "agent",
          type: "agent",
          name: "Research",
          cli: "codex",
          prompt: "Find the facts.",
          output: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
          permissions,
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
        { id: "e2", from: "agent", to: "end" },
      ],
    },
  };
}

describe("workflow draft DTO shellPolicy pass-through", () => {
  it("keeps a valid shellPolicy exactly as written", () => {
    const policy = {
      allow: ["^rg [^;|&<>$`]+$"],
      deny: ["^rg\\b.*\\s--pre(\\s|=|$)"],
      timeoutSec: 60,
      maxOutputBytes: 262144,
    };
    const draft = draftWith({ network: false, write: [], shell: true, shellPolicy: policy });

    const result = workflowDraftSchema.safeParse(draft);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(draft);
    const data = result.data as {
      graph: { nodes: Array<{ id: string; permissions?: { shellPolicy?: unknown } }> };
    };
    const agent = data.graph.nodes.find((node) => node.id === "agent");
    expect(agent?.permissions?.shellPolicy).toEqual(policy);
  });

  it("accepts a policy when shell is omitted", () => {
    const result = workflowDraftSchema.safeParse(
      draftWith({ network: false, write: [], shellPolicy: { allow: ["^ls$"] } }),
    );
    expect(result.success).toBe(true);
  });

  // The draft schema is structural; semantic policy problems are reported by
  // validateWorkflow as E_SHELL_POLICY, so the editor can show them inline.
  it("leaves an invalid pattern to validateWorkflow, which reports E_SHELL_POLICY", () => {
    const draft = draftWith({
      network: false,
      write: [],
      shell: true,
      shellPolicy: { allow: ["("] },
    });
    expect(workflowDraftSchema.safeParse(draft).success).toBe(true);

    const parsed = parseWorkflowDraft(draft);
    if (!parsed.ok) throw parsed.error;
    const codes = validateWorkflow(parsed.value).errors.map((item) => item.code);
    expect(codes).toContain("E_SHELL_POLICY");
  });

  it("leaves shell:false with a policy to validateWorkflow, which reports E_SHELL_POLICY", () => {
    const draft = draftWith({
      network: false,
      write: [],
      shell: false,
      shellPolicy: { deny: ["^rm\\b"] },
    });
    expect(workflowDraftSchema.safeParse(draft).success).toBe(true);

    const parsed = parseWorkflowDraft(draft);
    if (!parsed.ok) throw parsed.error;
    const codes = validateWorkflow(parsed.value).errors.map((item) => item.code);
    expect(codes).toContain("E_SHELL_POLICY");
  });
});
