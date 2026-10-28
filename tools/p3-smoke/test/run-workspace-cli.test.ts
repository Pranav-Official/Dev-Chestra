import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { CLI } from "../src/fixtures.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  type RunWorkspaceRepo,
  tempRoot,
} from "./support/run-workspace-fixtures.js";
import { workspaceWorkflow } from "./support/run-workspace-harness.js";

let repo: RunWorkspaceRepo;

beforeAll(() => {
  repo = makeRunWorkspaceRepo("devchestra-run-ws-cli-");
});

afterAll(() => {
  cleanupTempRoots();
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function envOf(): Record<string, string> {
  return {
    HOME: repo.home,
    GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo.root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...envOf() },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function summary(stdout: string): Record<string, unknown> {
  for (const line of stdout.trim().split("\n")) {
    if (!line.startsWith("{")) continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "summary") return value;
  }
  throw new Error(`CLI emitted no summary: ${stdout.slice(0, 2000)}`);
}

function spawnCwds(stdout: string): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line) as {
      type?: string;
      path?: string;
      payload?: { cwd?: string };
    };
    if (event.type === "node.process.spawned" && event.path && event.payload?.cwd) {
      cwds.set(event.path, event.payload.cwd);
    }
  }
  return cwds;
}

function assertPrereqs(): void {
  if (!existsSync(CLI)) {
    throw new Error("CLI acceptance prerequisite is missing: packages/cli/dist/main.js");
  }
}

function runMode(
  label: string,
  extraArgs: string[],
  dataName: string,
  expectedWorkspace: "project" | "existing" | "new",
): void {
  assertPrereqs();
  const workflowPath = join(repo.root, `run-workspace-${label}.json`);
  writeFileSync(workflowPath, JSON.stringify(workspaceWorkflow("scratch"), null, 2));
  const scriptPath = join(repo.root, `run-workspace-${label}.json.fake`);
  writeFileSync(
    scriptPath,
    JSON.stringify([
      {
        type: "submit",
        output: { summary: "cli summary", points: ["one", "two"] },
      },
    ]),
  );
  const dataDir = tempRoot(`devchestra-run-ws-cli-data-${dataName}-`).dir;
  const result = runCli([
    "run",
    workflowPath,
    "--project",
    repo.root,
    "--data-dir",
    dataDir,
    "--fake-script",
    scriptPath,
    "--json",
    ...extraArgs,
  ]);
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout.slice(0, 1200)}`);
  const line = summary(result.stdout);
  assert.equal(line.status, "succeeded", `${label}: ${JSON.stringify(line).slice(0, 1200)}`);

  const cwds = spawnCwds(result.stdout);
  const values = ["first", "agent", "second"].map((path) => {
    const cwd = cwds.get(path);
    assert.ok(cwd !== undefined, `${label}: ${path} has no spawn cwd`);
    return cwd;
  });
  assert.equal(new Set(values).size, 1, `${label}: every node must share one cwd`);
  const cwd = values[0] as string;
  if (expectedWorkspace === "project") {
    assert.equal(cwd, realpathSync(repo.root), `${label}: default must use project root`);
  } else if (expectedWorkspace === "existing") {
    assert.equal(cwd, realpathSync(repo.existingWorktree), `${label}: existing worktree cwd`);
  } else {
    assert.ok(cwd.startsWith(dataDir), `${label}: new worktree must live under data dir`);
    assert.equal(cwd.startsWith(repo.root), false);
  }
}

describe("run-level workspace through the real CLI", () => {
  it("runs prepare plus first and downstream acquisition in all three selections", () => {
    runMode("default", [], "default", "project");
    runMode(
      "existing",
      ["--workspace", "existing-worktree", "--worktree-path", repo.existingWorktree],
      "existing",
      "existing",
    );
    runMode("new", ["--workspace", "new-worktree"], "new", "new");
  }, 240_000);
});
