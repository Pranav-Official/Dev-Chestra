import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSkillTemplate } from "@devchestra/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { executeRun } from "../src/commands.js";

let root: string;
let project: string;
let dataDir: string;

const workflow = {
  schemaVersion: 1,
  id: "noop",
  name: "No-op",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "step", type: "shell", name: "Step", command: "true", timeoutMin: 1 },
      { id: "end", type: "end", name: "End", status: "success", result: "{}" },
    ],
    edges: [
      { id: "e1", from: "start", to: "step" },
      { id: "e2", from: "step", to: "end" },
    ],
  },
};

function options(): CliOptions {
  return {
    command: "run",
    workflow: ".devchestra/workflows/noop.json",
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

const skill = (): string => join(project, ".devchestra", "skill.md");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devchestra-cli-skill-"));
  project = join(root, "project");
  dataDir = join(root, "data");
  mkdirSync(join(project, ".devchestra", "workflows"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(
    join(project, ".devchestra", "workflows", "noop.json"),
    `${JSON.stringify(workflow, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("devchestra run registers the project implicitly", () => {
  it("seeds .devchestra/skill.md, then preserves an edit on the next run", async () => {
    expect(existsSync(skill())).toBe(false);
    await expect(executeRun(options(), dataDir)).resolves.toBe(0);
    expect(readFileSync(skill()).equals(projectSkillTemplate())).toBe(true);

    writeFileSync(skill(), "# my edit\n");
    await expect(executeRun(options(), dataDir)).resolves.toBe(0);
    expect(readFileSync(skill(), "utf8")).toBe("# my edit\n");
  }, 30_000);

  it("rejects a symlinked guide before starting the run", async () => {
    const target = join(root, "elsewhere.md");
    writeFileSync(target, "outside");
    symlinkSync(target, skill());
    await expect(executeRun(options(), dataDir)).rejects.toMatchObject({
      code: "E_FORBIDDEN_PATH",
    });
    expect(readFileSync(target, "utf8")).toBe("outside");
    expect(lstatSync(skill()).isSymbolicLink()).toBe(true);
  }, 30_000);
});
