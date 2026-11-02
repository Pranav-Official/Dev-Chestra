import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "@devchestra/server";
import { openStore } from "@devchestra/store";
import { realRoot } from "@devchestra/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { executeRun } from "../src/commands.js";

let root: string;
let project: string;
let dataDir: string;

const workflow = {
  schemaVersion: 1,
  id: "identity",
  name: "Identity",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      { id: "done", type: "end", name: "Done", status: "success", result: "{}" },
    ],
    edges: [{ id: "e1", from: "start", to: "done" }],
  },
};

function options(): CliOptions {
  return {
    command: "run",
    workflow: ".devchestra/workflows/identity.json",
    project,
    params: {},
    json: false,
    nonInteractive: false,
    retryUncertainShell: false,
    noOpen: true,
    printUrl: false,
    probeDecisions: false,
  };
}

function registeredProjects(): { id: string; path: string }[] {
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  try {
    return store.projects.list().map(({ id, path }) => ({ id, path }));
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "devchestra-cli-identity-"));
  project = join(root, "project");
  dataDir = join(root, "data");
  await mkdir(join(project, ".devchestra", "workflows"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(project, ".devchestra", "workflows", "identity.json"),
    `${JSON.stringify(workflow, null, 2)}\n`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CLI project identity", () => {
  it("registers a new project under the server's id scheme", async () => {
    await expect(executeRun(options(), dataDir)).resolves.toBe(0);
    const path = realRoot(project);
    expect(registeredProjects()).toEqual([{ id: projectIdForPath(path), path }]);
  }, 30_000);

  it("reuses the row already registered for the project path", async () => {
    const path = realRoot(project);
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    store.projects.ensure({ id: "registered-elsewhere", name: "project", path, kind: "folder" });
    store.close();

    await expect(executeRun(options(), dataDir)).resolves.toBe(0);
    expect(registeredProjects()).toEqual([{ id: "registered-elsewhere", path }]);
  }, 30_000);
});
