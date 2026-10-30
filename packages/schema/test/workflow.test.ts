import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hashWorkflow,
  normalizeWorkflow,
  parseWorkflow,
  SCHEMA_CAPABILITIES,
  validateParams,
  validateWorkflow,
} from "../src/index.js";
import { chainRaw, clone, edges, node, nodes, parseOk } from "./helpers.js";

function example(name: string) {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../../examples/${name}`, import.meta.url), "utf8"),
  );
  return parseOk(raw);
}

function codes(
  report: ReturnType<typeof validateWorkflow>,
  severity: "error" | "warning" = "error",
): string[] {
  return report[severity === "error" ? "errors" : "warnings"].map((item) => item.code);
}

function normalized(raw: Record<string, unknown>) {
  const result = normalizeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  return result.value;
}

describe("parse and validate the P1 chain", () => {
  it("accepts the checked-in examples", () => {
    const fake = example("linear-fake.json");
    const fakeReport = validateWorkflow(fake);
    expect(fakeReport.ok).toBe(true);
    expect(fakeReport.requires.clis).toEqual(["fake"]);
    expect(codes(fakeReport, "warning")).toContain("W_FAKE_CLI");

    const claude = example("linear-claude-code.json");
    const claudeReport = validateWorkflow(claude);
    expect(claudeReport.ok).toBe(true);
    expect(claudeReport.requires.clis).toEqual(["claude-code"]);
    expect(codes(claudeReport, "warning")).not.toContain("W_FAKE_CLI");
  });

  it("parses a minimal valid chain", () => {
    const parsed = parseWorkflow(chainRaw());
    expect(parsed.ok).toBe(true);
    const report = validateWorkflow(parseOk(chainRaw()));
    expect(report).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects unsupported node types, CLIs, versions and unknown fields", () => {
    const map = chainRaw();
    node(map, "agent").type = "map";
    const mapParse = parseWorkflow(map);
    expect(mapParse.ok).toBe(false);
    if (!mapParse.ok) expect(mapParse.error.message).toContain("Unsupported node type");

    const opencode = chainRaw();
    node(opencode, "agent").cli = "opencode";
    const opencodeParse = parseWorkflow(opencode);
    expect(opencodeParse.ok).toBe(true);

    const bogus = chainRaw();
    node(bogus, "agent").cli = "bogus-cli";
    const bogusParse = parseWorkflow(bogus);
    expect(bogusParse.ok).toBe(false);
    if (!bogusParse.ok) expect(bogusParse.error.message).toContain("Unsupported agent CLI");

    const newer = chainRaw();
    newer.schemaVersion = 2;
    const newerParse = parseWorkflow(newer);
    expect(newerParse.ok).toBe(false);
    if (!newerParse.ok) expect(newerParse.error.message).toContain("upgrade DevChestra");

    const unknown = chainRaw();
    node(unknown, "agent").bogus = true;
    const unknownParse = parseWorkflow(unknown);
    expect(unknownParse.ok).toBe(false);
    if (!unknownParse.ok) expect(unknownParse.error.message).toContain("Unrecognized");
  });

  it("rejects broken chains with actionable errors", () => {
    const missingStart = chainRaw();
    missingStart.graph = {
      nodes: nodes(missingStart).filter((item) => item.id !== "start"),
      edges: edges(missingStart),
    };
    expect(codes(validateWorkflow(parseOk(missingStart)))).toContain("E_START_COUNT");

    const twoStarts = chainRaw();
    const start2 = clone(node(twoStarts, "start"));
    start2.id = "start2";
    nodes(twoStarts).push(start2);
    edges(twoStarts).push({ id: "e0", from: "start2", to: "agent" });
    expect(codes(validateWorkflow(parseOk(twoStarts)))).toContain("E_START_COUNT");

    const fork = chainRaw();
    edges(fork).push({ id: "e4", from: "start", to: "shell" });
    const forkCodes = codes(validateWorkflow(parseOk(fork)));
    expect(forkCodes).toContain("E_CHAIN_IN");

    const cycle = chainRaw();
    const last = edges(cycle)[2];
    if (last !== undefined) last.from = "end";
    edges(cycle)[2] = { id: "e3", from: "shell", to: "agent" };
    expect(codes(validateWorkflow(parseOk(cycle)))).toContain("E_CYCLE");

    const dangling = chainRaw();
    edges(dangling)[1] = { id: "e2", from: "agent", to: "ghost" };
    expect(codes(validateWorkflow(parseOk(dangling)))).toContain("E_EDGE_DANGLING");

    const unreachable = chainRaw();
    nodes(unreachable).push({
      id: "island",
      type: "shell",
      name: "Island",
      command: "true",
      workspace: { mode: "scratch" },
    });
    const unreachableCodes = codes(validateWorkflow(parseOk(unreachable)));
    expect(unreachableCodes).toContain("E_UNREACHABLE");
    expect(unreachableCodes).toContain("E_NO_END");

    const duplicateNode = chainRaw();
    node(duplicateNode, "shell").id = "agent";
    expect(codes(validateWorkflow(parseOk(duplicateNode)))).toContain("E_NODE_DUPLICATE");

    const duplicateEdge = chainRaw();
    edges(duplicateEdge)[1] = { id: "e1", from: "agent", to: "shell" };
    expect(codes(validateWorkflow(parseOk(duplicateEdge)))).toContain("E_EDGE_DUPLICATE");
  });

  it("rejects unsupported capabilities instead of silently ignoring them", () => {
    const cases: [string, (raw: Record<string, unknown>) => void][] = [
      [
        "budget",
        (raw) => {
          raw.budget = { maxTokens: 1000 };
        },
      ],
      [
        "supervisor",
        (raw) => {
          raw.supervisor = { goal: "x" };
        },
      ],
      [
        "context",
        (raw) => {
          raw.context = [
            { key: "goal", value: "one" },
            { key: "goal", value: "two" },
          ];
        },
      ],
      [
        "cliOptions",
        (raw) => {
          node(raw, "agent").cliOptions = { foo: true };
        },
      ],
      [
        "env",
        (raw) => {
          node(raw, "agent").env = ["HOME"];
        },
      ],
      [
        "supervise",
        (raw) => {
          node(raw, "agent").supervise = "checkpoint";
        },
      ],
      [
        "projectWrite",
        (raw) => {
          node(raw, "agent").permissions = { network: false, write: ["workspace", "project"] };
        },
      ],
      [
        "quotaWait",
        (raw) => {
          node(raw, "agent").limits = { maxQuotaWaitHours: 1 };
        },
      ],
      [
        "artifact",
        (raw) => {
          const output = node(raw, "agent").output as {
            properties: Record<string, unknown>;
          };
          output.properties.report = { type: "string", format: "devchestra-artifact" };
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const raw = chainRaw();
      mutate(raw);
      const report = validateWorkflow(parseOk(raw));
      expect(report.ok, name).toBe(false);
      expect(codes(report), name).toContain("E_WORKFLOW_INVALID");
    }
    expect(SCHEMA_CAPABILITIES.workspaces).toEqual(["scratch", "worktree"]);
    expect(SCHEMA_CAPABILITIES.runWorkspaces).toEqual([
      "project",
      "existing-worktree",
      "new-worktree",
    ]);
    expect(SCHEMA_CAPABILITIES.defaultRunWorkspace).toBe("project");
  });

  it("accepts explicit worktree workspaces, legacy project metadata and rejects bad options", () => {
    const worktree = chainRaw();
    node(worktree, "agent").workspace = { mode: "worktree" };
    node(worktree, "shell").workspace = { mode: "worktree" };
    const report = validateWorkflow(parseOk(worktree));
    expect(report.ok).toBe(true);
    expect(report.requires.worktreeNodes).toEqual(["agent", "shell"]);

    for (const key of ["base", "setup", "from"] as const) {
      const raw = chainRaw();
      node(raw, "agent").workspace = { mode: "worktree", [key]: "x" };
      const bad = validateWorkflow(parseOk(raw));
      expect(bad.ok, key).toBe(false);
      expect(bad.errors[0]?.message, key).toContain(key);
    }

    const project = chainRaw();
    node(project, "agent").workspace = { mode: "project", access: "read" };
    expect(validateWorkflow(parseOk(project)).ok).toBe(true);

    const folder = chainRaw();
    node(folder, "agent").workspace = { mode: "worktree" };
    const folderReport = validateWorkflow(parseOk(folder), { projectKind: "folder" });
    expect(folderReport.ok).toBe(false);
    expect(folderReport.errors[0]?.message).toContain("Git project");
  });
});

describe("normalization and hashing", () => {
  it("applies explicit defaults, strips ui and sorts nodes/edges", () => {
    const result = normalized(chainRaw());
    expect(result.graph.nodes.map((item) => item.id)).toEqual(["agent", "end", "shell", "start"]);
    expect(result.graph.edges.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);
    const agent = result.graph.nodes.find((item) => item.id === "agent");
    expect(agent).toMatchObject({
      type: "agent",
      prompt: "Write about {{ start.topic }}.",
      workspace: { mode: "scratch" },
      limits: { timeoutMin: 30, validationRetries: 2, crashRetries: 1 },
      context: { project: "none", workflow: "none" },
      supervise: "default",
      env: [],
      permissions: { network: false, write: ["workspace"] },
    });
    const shell = result.graph.nodes.find((item) => item.id === "shell");
    expect(shell).toMatchObject({ timeoutMin: 10, allowFailure: false });
    expect(JSON.stringify(result)).not.toContain('"ui"');

    const worktreeRaw = chainRaw();
    node(worktreeRaw, "agent").workspace = { mode: "worktree" };
    const worktree = normalized(worktreeRaw);
    expect(worktree.graph.nodes.find((item) => item.id === "agent")).toMatchObject({
      workspace: { mode: "worktree" },
    });
  });

  it("hashes canonically regardless of ui/order and changes with prompts", async () => {
    const base = normalized(chainRaw());
    const baseHash = await hashWorkflow(base);

    const noisyRaw = chainRaw();
    node(noisyRaw, "agent").ui = { x: 900, y: 400, selected: true };
    node(noisyRaw, "shell").ui = { collapsed: false };
    edges(noisyRaw)[0] = { ...edges(noisyRaw)[0], ui: { route: [[1, 2]] } };
    nodes(noisyRaw).reverse();
    edges(noisyRaw).reverse();
    const noisyHash = await hashWorkflow(normalized(noisyRaw));
    expect(noisyHash).toBe(baseHash);

    const changed = chainRaw();
    node(changed, "agent").prompt = "Different prompt about {{ start.topic }}.";
    expect(await hashWorkflow(normalized(changed))).not.toBe(baseHash);
  });

  it("inlines promptFile from the supplied map or fails actionably", () => {
    const raw = chainRaw();
    const agent = node(raw, "agent");
    delete agent.prompt;
    agent.promptFile = "brief.md";
    const file = parseOk(raw);
    expect(codes(validateWorkflow(file), "warning")).toContain("W_PROMPT_FILE");

    const missing = normalizeWorkflow(file);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("prompts map");

    const inlined = normalizeWorkflow(file, {
      prompts: { "brief.md": "Inlined {{ start.topic }}" },
    });
    expect(inlined.ok).toBe(true);
    if (inlined.ok) {
      const normalizedAgent = inlined.value.graph.nodes.find((item) => item.id === "agent");
      expect(normalizedAgent).toMatchObject({ prompt: "Inlined {{ start.topic }}" });
      expect(JSON.stringify(inlined.value)).not.toContain("promptFile");
    }

    const traversal = chainRaw();
    delete node(traversal, "agent").prompt;
    node(traversal, "agent").promptFile = "../secret.md";
    expect(codes(validateWorkflow(parseOk(traversal)))).toContain("E_PROMPT_FILE");
  });
});

describe("parameters and scope", () => {
  it("applies defaults, rejects unknown and validates types", () => {
    const file = parseOk(chainRaw());
    const resolved = validateParams(file, { topic: "devchestra" });
    expect(resolved.ok).toBe(true);
    expect(resolved.value).toEqual({ topic: "devchestra", style: "brief" });

    expect(validateParams(file, {}).errors.map((item) => item.code)).toContain("E_PARAM_MISSING");
    expect(
      validateParams(file, { topic: "x", extra: 1 }).errors.map((item) => item.code),
    ).toContain("E_PARAM_UNKNOWN");
    expect(validateParams(file, { topic: 1 }).errors.map((item) => item.code)).toContain(
      "E_PARAM_TYPE",
    );
    expect(
      validateParams(file, { topic: "x", style: "huge" }).errors.map((item) => item.code),
    ).toContain("E_PARAM_ENUM");
    expect(
      validateParams(file, { topic: "x", style: true }).errors.map((item) => item.code),
    ).toContain("E_PARAM_TYPE");
  });

  it("does not warn about empty properties for raw or AP-true outputs", () => {
    const raw = chainRaw();
    node(raw, "agent").output = { type: "object", additionalProperties: true };
    const rawReport = validateWorkflow(parseOk(raw));
    expect(rawReport.ok).toBe(true);
    expect(codes(rawReport, "warning")).not.toContain("W_EMPTY_OUTPUT");

    const apTrueEmpty = chainRaw();
    node(apTrueEmpty, "agent").output = {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
    expect(codes(validateWorkflow(parseOk(apTrueEmpty)), "warning")).not.toContain(
      "W_EMPTY_OUTPUT",
    );

    const closed = chainRaw();
    node(closed, "agent").output = { type: "object" };
    expect(codes(validateWorkflow(parseOk(closed)), "warning")).toContain("W_EMPTY_OUTPUT");
  });

  it("only allows start and validated ancestors in scope", () => {
    const forward = chainRaw();
    node(forward, "agent").prompt = "{{ start.topic }} {{ shell.command }}";
    const forwardReport = validateWorkflow(parseOk(forward));
    expect(forwardReport.ok).toBe(false);
    expect(forwardReport.errors.some((item) => item.code === "E_EXPR_SCOPE")).toBe(true);

    const ghost = chainRaw();
    node(ghost, "shell").command = "printf '%s' {{ ghost.value }}";
    expect(
      validateWorkflow(parseOk(ghost)).errors.some((item) => item.code === "E_EXPR_SCOPE"),
    ).toBe(true);

    const ancestors = chainRaw();
    node(ancestors, "shell").command = "printf '%s' {{ start.topic }} {{ agent.summary }}";
    node(ancestors, "end").result = '{ "topic": start.topic, "summary": agent.summary }';
    expect(validateWorkflow(parseOk(ancestors)).ok).toBe(true);
  });
});
