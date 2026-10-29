import { readFileSync } from "node:fs";
import {
  compileExpression,
  compileTemplate,
  evaluateGate,
  normalizeOutputSchema,
  normalizeWorkflow,
  parseWorkflowJson,
  validateParams,
  validateWorkflow,
  type WorkflowFile,
  workflowNodes,
} from "@devchestra/schema";
import { createNodeExpressionExecutor } from "@devchestra/schema/node";
import { describe, expect, it } from "vitest";
import { projectSkillTemplate } from "../src/index.js";

const text = projectSkillTemplate().toString("utf8");

interface Fence {
  info: string;
  body: string;
  line: number;
}

function fences(markdown: string): Fence[] {
  const out: Fence[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^```(.*)$/u.exec(lines[index] ?? "");
    if (open === null) continue;
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && lines[end] !== "```") {
      body.push(lines[end] ?? "");
      end += 1;
    }
    out.push({ info: (open[1] ?? "").trim(), body: body.join("\n"), line: index + 1 });
    index = end;
  }
  return out;
}

const all = fences(text);
const workflows = all.filter((fence) => fence.info === "json");
const fragments = all.filter((fence) => fence.info === "json fragment");

describe("skill.md embedded examples", () => {
  it("keeps every fence tagged so none escapes validation", () => {
    for (const fence of all) {
      expect(["json", "json fragment", "text"], `fence at line ${fence.line}`).toContain(
        fence.info,
      );
    }
    expect(workflows.length).toBeGreaterThanOrEqual(4);
  });

  it("covers every supported node type in complete workflows", () => {
    const seen = new Set<string>();
    for (const fence of workflows) {
      const parsed = parseWorkflowJson(fence.body);
      if (!parsed.ok) continue;
      for (const node of workflowNodes(parsed.value.graph)) seen.add(node.type);
    }
    expect([...seen].sort()).toEqual([
      "agent",
      "approval",
      "decision",
      "end",
      "gate",
      "join",
      "loop",
      "shell",
      "start",
    ]);
  });

  describe.each(workflows.map((fence) => [`line ${fence.line}`, fence] as const))(
    "complete workflow at %s",
    (_label, fence) => {
      const parsed = parseWorkflowJson(fence.body);

      it("parses strictly", () => {
        expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
      });

      it("validates with no errors", () => {
        if (!parsed.ok) throw parsed.error;
        const report = validateWorkflow(parsed.value, { projectKind: "git" });
        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);
      });

      it("uses a canonical id, real CLIs only, and normalizes", () => {
        if (!parsed.ok) throw parsed.error;
        const file: WorkflowFile = parsed.value;
        expect(file.id).toMatch(/^[a-z0-9-]{1,64}$/u);
        for (const node of workflowNodes(file.graph)) {
          expect(node.id).toMatch(/^[a-z][a-z0-9_]{0,47}$/u);
          if (node.type === "agent") {
            expect(["claude-code", "codex", "opencode", "pi"]).toContain(node.cli);
            expect(node.promptFile).toBeUndefined();
            expect(node.cliOptions).toBeUndefined();
            expect(node.workspace).toBeUndefined();
            expect(node.permissions.write).not.toContain("project");
          }
          expect(node.ui).toBeDefined();
        }
        const normalized = normalizeWorkflow(file);
        expect(normalized.ok, normalized.ok ? "" : normalized.error.message).toBe(true);
      });

      it("accepts the declared parameter defaults", () => {
        if (!parsed.ok) throw parsed.error;
        const start = parsed.value.graph.nodes.find((node) => node.type === "start");
        if (start?.type !== "start") throw new Error("no start");
        const supplied: Record<string, unknown> = {};
        for (const param of start.params) {
          if (param.default === undefined) {
            supplied[param.name] =
              param.type === "number" ? 1 : param.type === "boolean" ? true : "value";
          }
        }
        const resolved = validateParams(parsed.value, supplied);
        expect(resolved.errors).toEqual([]);
      });
    },
  );

  it("has valid JSON in every fragment", () => {
    expect(fragments.length).toBeGreaterThan(0);
    for (const fence of fragments) {
      expect(() => JSON.parse(fence.body), `fragment at line ${fence.line}`).not.toThrow();
    }
  });

  it("compiles every expression and template that appears in a fragment node", () => {
    for (const fence of fragments) {
      const value = JSON.parse(fence.body) as unknown;
      const nodes = Array.isArray(value) ? value : [value];
      for (const node of nodes as Record<string, unknown>[]) {
        for (const key of ["prompt", "command", "message", "state"] as const) {
          const source = node[key];
          if (typeof source === "string") {
            const compiled = compileTemplate(source, { shell: key === "command" });
            expect(compiled.ok, `${key} at line ${fence.line}`).toBe(true);
          }
        }
        for (const key of ["result", "until", "nextState", "initialState"] as const) {
          const source = node[key];
          if (typeof source === "string") {
            expect(compileExpression(source).ok, `${key} at line ${fence.line}`).toBe(true);
          }
        }
        const branches = node.branches;
        if (Array.isArray(branches)) {
          for (const branch of branches as { when?: string }[]) {
            if (typeof branch.when === "string")
              expect(compileExpression(branch.when).ok).toBe(true);
          }
        }
      }
    }
  });

  it("documents the rejected shell contexts it claims are rejected", () => {
    expect(compileTemplate('echo "{{ start.name }}"', { shell: true }).ok).toBe(false);
    expect(compileTemplate("echo $({{ start.cmd }})", { shell: true }).ok).toBe(false);
    expect(compileTemplate("git log --oneline -n {{ start.count }}", { shell: true }).ok).toBe(
      true,
    );
    expect(compileTemplate("grep -rn -- {{ start.pattern }} src", { shell: true }).ok).toBe(true);
  });

  it("matches the documented missing-value semantics of the real evaluator", async () => {
    const executor = createNodeExpressionExecutor();
    const run = async (source: string, scope: Record<string, unknown>): Promise<unknown> =>
      executor.evaluate(source, scope, { timeoutMs: 1_000 });
    expect(await run("x.y = true", { x: null })).toBe(false);
    expect(await run("x.y != 'a'", {})).toBe(false);
    expect(typeof (await run("x.y > 3", { x: {} }))).not.toBe("boolean");
    expect(await run("$exists(x.y) and x.y > 3", { x: {} })).toBe(false);
    expect(await run("result.passed = true", { result: {} })).toBe(false);
  });

  it("fails a gate on a non-boolean comparison instead of falling through", async () => {
    const executor = createNodeExpressionExecutor();
    const decision = await evaluateGate(
      {
        branches: [
          { id: "big", when: "x.y > 3" },
          { id: "rest", otherwise: true },
        ],
      },
      { x: {} },
      { executor },
    );
    if (!decision.ok) throw decision.error;
    expect(decision.value.branch).toBeNull();
    expect(decision.value.error?.code).toBe("E_EXPR");
  });

  it("is plain text the guide can be read from disk without loading extra tooling", () => {
    expect(readFileSync(new URL("../assets/devchestra-skill.md", import.meta.url), "utf8")).toBe(
      text,
    );
  });

  describe("rejections the guide documents", () => {
    const base = (): WorkflowFile => {
      const parsed = parseWorkflowJson(workflows[0]?.body ?? "");
      if (!parsed.ok) throw parsed.error;
      return structuredClone(parsed.value);
    };
    const exampleWith = (type: string): WorkflowFile => {
      for (const fence of workflows) {
        const parsed = parseWorkflowJson(fence.body);
        if (parsed.ok && parsed.value.graph.nodes.some((node) => node.type === type)) {
          return structuredClone(parsed.value);
        }
      }
      throw new Error(`no ${type} example`);
    };
    const codes = (file: WorkflowFile): string[] =>
      validateWorkflow(file, { projectKind: "git" }).errors.map((issue) => issue.code);
    const agentOf = (file: WorkflowFile): Record<string, unknown> => {
      const node = file.graph.nodes.find((candidate) => candidate.type === "agent");
      if (node === undefined) throw new Error("no agent");
      return node as unknown as Record<string, unknown>;
    };

    it("rejects unsupported agent and workflow fields", () => {
      const withCliOptions = base();
      agentOf(withCliOptions).cliOptions = { flag: true };
      expect(codes(withCliOptions)).toContain("E_WORKFLOW_INVALID");

      const withProject = base();
      agentOf(withProject).permissions = { network: false, write: ["project"] };
      expect(codes(withProject)).toContain("E_WORKFLOW_INVALID");

      const withBudget = base();
      withBudget.budget = { maxUsd: 1 };
      expect(codes(withBudget)).toContain("E_WORKFLOW_INVALID");

      const withEnv = base();
      agentOf(withEnv).env = ["TOKEN"];
      expect(codes(withEnv)).toContain("E_WORKFLOW_INVALID");

      const withContext = base();
      agentOf(withContext).context = { project: "read", workflow: "none" };
      expect(codes(withContext)).toContain("E_WORKFLOW_INVALID");

      const withNodeField = base();
      (agentOf(withNodeField) as Record<string, unknown>).description = "nope";
      expect(parseWorkflowJson(JSON.stringify(withNodeField)).ok).toBe(false);
    });

    it("rejects hyphenated node ids and references to non-ancestors", () => {
      const hyphen = base();
      agentOf(hyphen).id = "my-agent";
      expect(codes(hyphen)).toContain("E_NODE_ID");

      const scope = base();
      agentOf(scope).prompt = "Use {{ end.result }}";
      expect(codes(scope)).toContain("E_EXPR_SCOPE");
    });

    it("rejects a second inbound edge on an end and a gate without otherwise", () => {
      const file = base();
      file.graph.edges.push({ id: "extra", from: "start", to: "end" });
      expect(codes(file)).toContain("E_CHAIN_IN");

      const gate = exampleWith("gate");
      const route = gate.graph.nodes.find((node) => node.type === "gate");
      if (route?.type !== "gate") throw new Error("no gate");
      route.branches = route.branches.filter((branch) => branch.otherwise !== true);
      expect(codes(gate)).toContain("E_GATE_OTHERWISE");
    });

    it("enforces the loop rules the guide states", () => {
      const loopFile = (): WorkflowFile => exampleWith("loop");
      const loopOf = (file: WorkflowFile) => {
        const node = file.graph.nodes.find((candidate) => candidate.type === "loop");
        if (node?.type !== "loop") throw new Error("no loop");
        return node;
      };

      const tooMany = loopFile();
      loopOf(tooMany).maxIterations = 1001;
      expect(codes(tooMany)).toContain("E_LOOP_MAX_ITERATIONS");

      const failedEnd = loopFile();
      const bodyEnd = loopOf(failedEnd).body.nodes.find((node) => node.type === "end");
      if (bodyEnd?.type !== "end") throw new Error("no body end");
      bodyEnd.status = "failed";
      expect(codes(failedEnd)).toContain("E_LOOP_BODY_END_STATUS");

      const reserved = loopFile();
      const implement = loopOf(reserved).body.nodes.find((node) => node.id === "implement");
      if (implement === undefined) throw new Error("no implement");
      implement.id = "result";
      expect(codes(reserved)).toContain("E_LOOP_BODY_ID");

      const badHandle = loopFile();
      badHandle.graph.edges.push({ id: "bad", from: "refine.success", to: "spent" });
      expect(codes(badHandle)).toContain("E_EDGE_HANDLE");

      const untilScope = loopFile();
      loopOf(untilScope).initialState = '{"goal": review.passed}';
      expect(codes(untilScope)).toContain("E_EXPR_SCOPE");
    });

    it("applies the restricted output-schema profile and expression policy", () => {
      const object = { type: "object", properties: { a: { type: "string" } } };
      expect(normalizeOutputSchema(object).ok).toBe(true);
      const bad: Record<string, unknown>[] = [
        { type: "array", items: { type: "string" } },
        { type: "object", oneOf: [] },
        { type: "object", properties: { a: { type: "string", format: "date" } } },
        { type: "object", properties: { a: { type: "object" } }, required: ["b"] },
        { type: "object", additionalProperties: {} },
        { type: "string" },
      ];
      for (const schema of bad)
        expect(normalizeOutputSchema(schema).ok, JSON.stringify(schema)).toBe(false);
      expect(
        normalizeOutputSchema({
          type: "object",
          properties: { a: { type: "array", items: {}, maxItems: 3 }, any: {} },
        }).ok,
      ).toBe(true);

      for (const source of ["$now()", "$x := 1", "a ~> $uppercase()", "$uuid()", "$random()"]) {
        expect(compileExpression(source).ok, source).toBe(false);
      }
      expect(compileTemplate("a {{{ x }}} b").ok).toBe(false);
      expect(compileTemplate("a \\{{ x }} b").ok).toBe(true);
    });
  });
});
