import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BaseNodeKind, validateBaseNodeConfig } from "../src/node-config.js";

type Node = Record<string, unknown>;

const fixtureNodes = (
  JSON.parse(
    readFileSync(
      new URL("../../../tools/fixtures/engine/linear-research.json", import.meta.url),
      "utf8",
    ),
  ) as { graph: { nodes: Node[] } }
).graph.nodes;

function fixtureNode(id: string): Node {
  const node = fixtureNodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`Missing fixture node ${id}`);
  return structuredClone(node);
}

function record(owner: Node, key: string): Node {
  const value = owner[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing object ${key}`);
  }
  return value as Node;
}

/** Returns the rejection message, or null when the node is accepted. */
function rejection(node: Node, kind: BaseNodeKind = "agent"): string | null {
  try {
    validateBaseNodeConfig(node, kind);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("validateBaseNodeConfig", () => {
  it("accepts the start, agent, shell and end fixture nodes", () => {
    expect(rejection(fixtureNode("start"), "start")).toBeNull();
    expect(rejection(fixtureNode("research"), "agent")).toBeNull();
    expect(rejection(fixtureNode("report"), "shell")).toBeNull();
    expect(rejection(fixtureNode("end"), "end")).toBeNull();
  });

  it("accepts worktree workspaces and rejects their unsupported options", () => {
    const accepted = fixtureNode("research");
    accepted.workspace = { mode: "worktree" };
    expect(rejection(accepted)).toBeNull();

    for (const key of ["base", "setup", "from"] as const) {
      const node = fixtureNode("research");
      node.workspace = { mode: "worktree", [key]: "x" };
      expect(rejection(node)).toContain(key);
    }
  });

  it("accepts legacy project workspace metadata that fresh runs ignore", () => {
    for (const workspace of [
      { mode: "project", access: "read" },
      { mode: "project", access: "write" },
    ]) {
      const node = fixtureNode("research");
      node.workspace = workspace;
      expect(rejection(node)).toBeNull();
    }
  });

  it("rejects unknown workspace modes", () => {
    const node = fixtureNode("research");
    node.workspace = { mode: "remote" };
    expect(rejection(node)).toContain("scratch or worktree");
  });

  it("rejects context banks and project writes", () => {
    const context = fixtureNode("research");
    record(context, "context").project = "read";
    expect(rejection(context)).toContain("Context banks");

    const write = fixtureNode("research");
    record(write, "permissions").write = ["project"];
    expect(rejection(write)).toContain("Project write access");
  });

  it("rejects artifact outputs and prompt files", () => {
    const artifact = fixtureNode("research");
    artifact.output = {
      type: "object",
      properties: { file: { type: "string", format: "devchestra-artifact" } },
    };
    expect(rejection(artifact)).toContain("Artifact outputs");

    const promptFile = fixtureNode("research");
    promptFile.promptFile = "research.md";
    expect(rejection(promptFile)).toContain("promptFile");
  });

  it("accepts a valid shellPolicy and rejects malformed ones", () => {
    const valid = fixtureNode("research");
    record(valid, "permissions").shellPolicy = {
      allow: ["^curl .+$"],
      deny: ["\\s(-o|--output)(\\s|$)"],
      timeoutSec: 60,
      maxOutputBytes: 262144,
    };
    expect(rejection(valid)).toBeNull();

    const absent = fixtureNode("research");
    expect(rejection(absent)).toBeNull();

    const badPattern = fixtureNode("research");
    record(badPattern, "permissions").shellPolicy = { allow: ["("] };
    expect(rejection(badPattern)).toContain("shellPolicy");

    const redos = fixtureNode("research");
    record(redos, "permissions").shellPolicy = { deny: ["(a+)+"] };
    expect(rejection(redos)).toContain("shellPolicy");

    const badLimit = fixtureNode("research");
    record(badLimit, "permissions").shellPolicy = { timeoutSec: 0 };
    expect(rejection(badLimit)).toContain("shellPolicy");

    const disabled = fixtureNode("research");
    record(disabled, "permissions").shell = false;
    record(disabled, "permissions").shellPolicy = { allow: ["^curl .+$"] };
    expect(rejection(disabled)).toContain("shellPolicy");
  });
});
