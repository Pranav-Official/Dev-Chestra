import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { executeRun } from "../src/commands.js";

let root: string;
let project: string;
let dataDir: string;

const shell = (id: string) => ({
  id,
  type: "shell",
  name: id,
  command: "true",
  workspace: { mode: "scratch" },
  timeoutMin: 1,
});

function routed() {
  return {
    schemaVersion: 1,
    id: "routed",
    name: "Routed",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "gate",
          type: "gate",
          name: "Gate",
          branches: [
            { id: "yes", when: "true" },
            { id: "no", otherwise: true },
          ],
        },
        shell("left"),
        shell("right"),
        { id: "join", type: "join", name: "Join", mode: "all", inputs: ["left", "right"] },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "gate" },
        { id: "e2", from: "gate.yes", to: "left" },
        { id: "e3", from: "gate.no", to: "right" },
        { id: "e4", from: "left", to: "join.left" },
        { id: "e5", from: "right", to: "join.right" },
        { id: "e6", from: "join", to: "end" },
      ],
    },
  };
}

function conflicting() {
  return {
    schemaVersion: 1,
    id: "conflicting",
    name: "Conflicting",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        shell("a"),
        shell("b"),
        { id: "join", type: "join", name: "Join", mode: "first", inputs: ["a", "b"] },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "a" },
        { id: "e2", from: "start", to: "b" },
        { id: "e3", from: "a", to: "join.a" },
        { id: "e4", from: "b", to: "join.b" },
        { id: "e5", from: "join", to: "end" },
      ],
    },
  };
}

function options(workflow: string): CliOptions {
  return {
    command: "run",
    workflow: `.devchestra/workflows/${workflow}.json`,
    project,
    params: {},
    json: false,
    embedded: false,
    nonInteractive: false,
    retryUncertainShell: false,
    allowExperimentalAdapters: false,
    noOpen: true,
    printUrl: false,
    probeDecisions: false,
  };
}

async function write(workflow: { id: string }): Promise<void> {
  const dir = join(project, ".devchestra", "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "devchestra-cli-routing-"));
  project = join(root, "project");
  dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CLI DAG execution", () => {
  it("executes an exclusive gate/join DAG to success", async () => {
    await write(routed());
    await expect(executeRun(options("routed"), dataDir)).resolves.toBe(0);
  }, 30_000);

  it("returns the controlled exit for a join-first conflict", async () => {
    await write(conflicting());
    await expect(executeRun(options("conflicting"), dataDir)).resolves.toBe(4);
  }, 30_000);
});
