import { describe, expect, it } from "vitest";
import {
  buildPollAgentOutputSchema,
  buildPollPromptPreamble,
  normalizeWorkflow,
  POLL_AGENT_PROMPT_MAX_BYTES,
  parseWorkflow,
  resolvePollResult,
  validatePollingConfig,
  validateWorkflow,
  type WorkflowParam,
} from "../src/index.js";

const PARAMS: WorkflowParam[] = [
  { name: "pr", type: "number", required: true },
  { name: "title", type: "string", required: false, default: "none" },
];

const SINGLE: WorkflowParam[] = [{ name: "url", type: "string", required: true }];

function startNode(polling?: unknown, params: WorkflowParam[] = PARAMS) {
  return {
    id: "start",
    type: "start",
    name: "Start",
    params,
    ...(polling === undefined ? {} : { polling }),
  } as never;
}

function workflow(start: unknown) {
  return {
    schemaVersion: 1,
    id: "polled",
    name: "Polled",
    graph: {
      nodes: [start, { id: "end", type: "end", name: "End", status: "success", result: "{}" }],
      edges: [{ id: "e0", from: "start", to: "end" }],
    },
  };
}

const SHELL_POLLING = {
  enabled: true,
  probe: { type: "shell", command: "gh pr list --json number" },
};

const AGENT_POLLING = {
  enabled: true,
  probe: { type: "agent", cli: "codex", prompt: "Check for new PRs." },
};

describe("validatePollingConfig", () => {
  it("accepts shell and agent probes", () => {
    expect(validatePollingConfig(startNode(SHELL_POLLING), "/graph/nodes/0/polling")).toEqual([]);
    expect(validatePollingConfig(startNode(AGENT_POLLING), "/graph/nodes/0/polling")).toEqual([]);
  });

  it("accepts explicit dedupe and workspace values", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: { type: "shell", command: "true", timeoutMin: 5 },
        dedupe: false,
        workspace: "worktree",
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues).toEqual([]);
  });

  it("reports probe field problems with underlying and poll codes", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: { type: "shell", command: "   ", timeoutMin: 9999 },
        dedupe: "yes",
        workspace: "scratch",
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "E_SHELL_COMMAND",
      "E_LIMITS",
      "E_POLL_PROBE",
      "E_POLL_PROBE",
    ]);
    expect(issues[0]?.pointer).toBe("/graph/nodes/0/polling/probe/command");
  });

  it("reports agent probe problems with underlying and poll codes", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: { type: "agent", cli: "nope", model: "", prompt: "" },
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "E_WORKFLOW_INVALID",
      "E_POLL_PROBE",
      "E_POLL_PROBE",
    ]);
  });

  it("rejects an oversized agent prompt", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: {
          type: "agent",
          cli: "codex",
          prompt: `x${"y".repeat(POLL_AGENT_PROMPT_MAX_BYTES)}`,
        },
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toEqual(["E_POLL_PROBE"]);
  });

  it("rejects an unknown probe type", () => {
    const issues = validatePollingConfig(
      startNode({ enabled: true, probe: { type: "cron" } }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toEqual(["E_POLL_PROBE"]);
  });

  it("warns on the fake CLI like agent nodes do", () => {
    const issues = validatePollingConfig(
      startNode({ enabled: true, probe: { type: "agent", cli: "fake", prompt: "Check." } }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toEqual(["W_FAKE_CLI"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("accepts a probe with mcpServers and explicit permissions", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: {
          id: "probe",
          type: "agent",
          name: "Poll probe",
          cli: "codex",
          prompt: "Check for work.",
          permissions: { network: true, write: [], shell: true },
          mcpServers: [{ name: "gh", scope: "global" }],
          limits: { timeoutMin: 5 },
        },
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues).toEqual([]);
  });

  it("rejects old-shape agent probe with top-level timeoutMin", () => {
    const issues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: { type: "agent", cli: "codex", prompt: "Check.", timeoutMin: 5 },
      }),
      "/graph/nodes/0/polling",
    );
    expect(issues.map((issue) => issue.code)).toContain("E_POLL_PROBE");
    expect(issues.map((issue) => issue.message).join(" ")).toContain("limits.timeoutMin");
  });

  it("rejects engine-owned output/workspace with E_POLL_PROBE", () => {
    const agentIssues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: {
          type: "agent",
          cli: "codex",
          prompt: "Check.",
          output: { type: "object" },
          workspace: { mode: "scratch" },
        },
      }),
      "/graph/nodes/0/polling",
    );
    expect(agentIssues.map((issue) => issue.code)).toContain("E_POLL_PROBE");
    const shellIssues = validatePollingConfig(
      startNode({
        enabled: true,
        probe: { type: "shell", command: "true", workspace: { mode: "scratch" } },
      }),
      "/graph/nodes/0/polling",
    );
    expect(shellIssues.map((issue) => issue.code)).toContain("E_POLL_PROBE");
  });
});

describe("resolvePollResult with shell output", () => {
  const start = startNode(SHELL_POLLING);

  it.each(["", "   ", "null", "{}", '{"found":false}', '{"found": false}'])(
    "treats %s as nothing",
    (stdout) => {
      const result = resolvePollResult(start, { kind: "shell", stdout, exitCode: 0 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ found: false });
    },
  );

  it("resolves a JSON object through param validation with defaults", () => {
    const result = resolvePollResult(start, {
      kind: "shell",
      stdout: '{"pr": 12}',
      exitCode: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ found: true, params: { pr: 12, title: "none" } });
  });

  it("extracts a top-level dedupeKey before validation", () => {
    const result = resolvePollResult(start, {
      kind: "shell",
      stdout: '{"pr": 12, "dedupeKey": "abc:3"}',
      exitCode: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      found: true,
      params: { pr: 12, title: "none" },
      dedupeKey: "abc:3",
    });
  });

  it("fails on a non-zero exit instead of reporting nothing", () => {
    const result = resolvePollResult(start, { kind: "shell", stdout: "", exitCode: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_POLL_PROBE");
  });

  it("resolves a bare line for a single-param start", () => {
    const single = startNode(SHELL_POLLING, SINGLE);
    const result = resolvePollResult(single, {
      kind: "shell",
      stdout: "https://example.test/pr/7\n",
      exitCode: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      found: true,
      params: { url: "https://example.test/pr/7" },
    });
  });

  it("keeps scalar types for a bare line", () => {
    const single = startNode(SHELL_POLLING, [{ name: "pr", type: "number", required: true }]);
    const result = resolvePollResult(single, { kind: "shell", stdout: "42", exitCode: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ found: true, params: { pr: 42 } });
  });

  it("fails a bare value when several params are declared", () => {
    const result = resolvePollResult(start, {
      kind: "shell",
      stdout: "just a line",
      exitCode: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_POLL_PROBE");
  });

  it("fails when required params are missing", () => {
    const result = resolvePollResult(start, {
      kind: "shell",
      stdout: '{"title": "hi"}',
      exitCode: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_POLL_PROBE");
  });
});

describe("resolvePollResult with agent output", () => {
  const start = startNode(AGENT_POLLING);

  it("treats found:false as nothing", () => {
    const result = resolvePollResult(start, {
      kind: "agent",
      output: { found: false, params: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ found: false });
  });

  it("resolves found:true through param validation with dedupeKey", () => {
    const result = resolvePollResult(start, {
      kind: "agent",
      output: { found: true, params: { pr: 3 }, dedupeKey: "sha:9" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      found: true,
      params: { pr: 3, title: "none" },
      dedupeKey: "sha:9",
    });
  });

  it("fails without found or params", () => {
    for (const output of [{ params: { pr: 1 } }, { found: true }, "nope", null, []]) {
      const result = resolvePollResult(start, { kind: "agent", output });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("E_POLL_PROBE");
    }
  });

  it("fails when agent params do not validate", () => {
    const result = resolvePollResult(start, {
      kind: "agent",
      output: { found: true, params: { pr: "three" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_POLL_PROBE");
  });
});

describe("agent probe builders", () => {
  it("generates an output schema with all start params optional", () => {
    const schema = buildPollAgentOutputSchema(startNode(AGENT_POLLING));
    expect(schema).toEqual({
      type: "object",
      properties: {
        found: { type: "boolean" },
        params: {
          type: "object",
          properties: { pr: { type: "number" }, title: { type: "string" } },
          additionalProperties: false,
        },
        dedupeKey: { type: "string" },
      },
      required: ["found", "params"],
      additionalProperties: false,
    });
  });

  it("maps enum params to string enums", () => {
    const schema = buildPollAgentOutputSchema({
      params: [{ name: "style", type: "enum", options: ["brief", "detailed"], required: false }],
    });
    const params = schema.properties as Record<string, { properties: Record<string, unknown> }>;
    expect(params.params?.properties.style).toEqual({
      type: "string",
      enum: ["brief", "detailed"],
    });
  });

  it("builds a preamble naming each param", () => {
    const preamble = buildPollPromptPreamble(startNode(AGENT_POLLING));
    expect(preamble).toContain("found");
    expect(preamble).toContain("dedupeKey");
    expect(preamble).toContain("pr (number, required)");
    expect(preamble).toContain('title (string, optional, default: "none")');
  });
});

describe("start node polling block in workflow files", () => {
  it("parses, validates, and normalizes the polling block with defaults", () => {
    const parsed = parseWorkflow(workflow(startNode(SHELL_POLLING)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkflow(parsed.value).ok).toBe(true);
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start).toMatchObject({
      polling: {
        enabled: true,
        probe: { type: "shell", command: "gh pr list --json number" },
        dedupe: true,
        workspace: "project",
      },
    });
  });

  it("keeps explicit dedupe and workspace values", () => {
    const parsed = parseWorkflow(
      workflow(
        startNode({
          enabled: false,
          probe: { type: "agent", cli: "pi", model: "m", prompt: "Check." },
          dedupe: false,
          workspace: "worktree",
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start).toMatchObject({
      polling: {
        enabled: false,
        probe: { type: "agent", cli: "pi", model: "m", prompt: "Check." },
        dedupe: false,
        workspace: "worktree",
      },
    });
  });

  it("rejects unknown keys in the polling block", () => {
    expect(parseWorkflow(workflow(startNode({ enabled: true, cron: "* * *" }))).ok).toBe(false);
    expect(
      parseWorkflow(
        workflow(startNode({ enabled: true, probe: { type: "shell", command: "x", extra: 1 } })),
      ).ok,
    ).toBe(false);
  });

  it("reports probe errors against the saved file", () => {
    const parsed = parseWorkflow(
      workflow(startNode({ enabled: true, probe: { type: "shell", command: "" } })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("E_SHELL_COMMAND");
  });

  it("validates and round-trips a probe with mcpServers and permissions", () => {
    const polling = {
      enabled: true,
      probe: {
        id: "probe",
        type: "agent",
        name: "Poll probe",
        cli: "codex",
        prompt: "Check for work.",
        permissions: { network: true, write: [], shell: true },
        mcpServers: [{ name: "gh", scope: "global" }],
        limits: { timeoutMin: 5 },
      },
    };
    const parsed = parseWorkflow(workflow(startNode(polling)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkflow(parsed.value).ok).toBe(true);
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start).toMatchObject({
      polling: {
        enabled: true,
        probe: {
          id: "probe",
          type: "agent",
          cli: "codex",
          prompt: "Check for work.",
          permissions: { network: true, write: [], shell: true },
          mcpServers: [{ name: "gh", scope: "global" }],
          limits: expect.objectContaining({ timeoutMin: 5 }),
        },
      },
    });
  });

  it("rejects old-shape agent probe with top-level timeoutMin at parse", () => {
    const parsed = parseWorkflow(
      workflow(
        startNode({
          enabled: true,
          probe: { type: "agent", cli: "codex", prompt: "Check.", timeoutMin: 5 },
        }),
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("limits.timeoutMin");
  });

  it("rejects engine-owned output/workspace in the probe", () => {
    const parsed = parseWorkflow(
      workflow(
        startNode({
          enabled: true,
          probe: {
            type: "agent",
            cli: "codex",
            prompt: "Check.",
            output: { type: "object" },
            workspace: { mode: "scratch" },
          },
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("E_POLL_PROBE");
  });

  it("keeps workflows without a polling block unchanged", () => {
    const parsed = parseWorkflow(workflow(startNode()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start && "polling" in start).toBe(false);
  });
});
