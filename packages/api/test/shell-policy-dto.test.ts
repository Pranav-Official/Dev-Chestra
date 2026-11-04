import { normalizeWorkflow, parseWorkflowDraft, validateWorkflow } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { normalizedWorkflowSchema, workflowDraftSchema } from "../src/index.js";

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

describe("frozen workflow DTO shellPolicy pass-through", () => {
  function normalize(raw: unknown) {
    const parsed = parseWorkflowDraft(raw);
    if (!parsed.ok) throw parsed.error;
    const result = normalizeWorkflow(parsed.value);
    if (!result.ok) throw result.error;
    return result.value;
  }

  it("accepts normalized agent policies without losing rules or resource limits", () => {
    for (const policy of [
      {},
      { allow: ["^echo allowed$"] },
      { deny: ["^echo denied$"] },
      { allow: ["^echo .*$"], deny: ["^echo denied$"], timeoutSec: 30, maxOutputBytes: 4096 },
    ]) {
      const snapshot = normalize(
        draftWith({ network: false, write: [], shell: true, shellPolicy: policy }),
      );
      const parsed = normalizedWorkflowSchema.safeParse(snapshot);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(parsed.data).toEqual(snapshot);
    }
  });

  it("preserves policies in normalized polling agent probes as well as ordinary agents", () => {
    const policy = { allow: ["^echo probe$"], timeoutSec: 10 };
    const draft = draftWith({ network: false, write: [] });
    const start = (draft.graph as { nodes: Record<string, unknown>[] }).nodes[0];
    if (start === undefined) throw new Error("Missing start");
    start.polling = {
      enabled: true,
      probe: {
        type: "agent",
        cli: "codex",
        prompt: "Check for work.",
        permissions: { network: false, write: [], shellPolicy: policy },
      },
    };
    const snapshot = normalize(draft);
    const parsed = normalizedWorkflowSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toEqual(snapshot);
  });

  it("still rejects malformed policy fields in a frozen snapshot", () => {
    const snapshot = normalize(draftWith({ network: false, write: [], shellPolicy: {} }));
    const agent = snapshot.graph.nodes.find((item) => item.type === "agent");
    if (agent?.type !== "agent") throw new Error("Missing agent");
    Object.assign(agent.permissions, { shellPolicy: { allow: "echo" } });
    expect(normalizedWorkflowSchema.safeParse(snapshot).success).toBe(false);
    Object.assign(agent.permissions, { shellPolicy: { unexpected: true } });
    expect(normalizedWorkflowSchema.safeParse(snapshot).success).toBe(false);
  });
});
