import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DevChestraError, Result } from "@devchestra/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  acquireScratch,
  finalizeScratch,
  releaseScratch,
} from "../../../packages/workspaces/dist/index.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const CLI = join(REPO_ROOT, "packages/cli/dist/main.js");
const WORKSPACES_DIST = pathToFileURL(join(REPO_ROOT, "packages/workspaces/dist/index.js")).href;

const cleanup: (() => void)[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
const envHome = mkdtempSync(join(tmpdir(), "devchestra-worktree-home-"));
process.env.HOME = envHome;
process.env.GIT_CONFIG_GLOBAL = join(envHome, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

afterAll(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  rmSync(envHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

interface Repo {
  root: string;
  base: string;
}

function makeRepo(label: string): Repo {
  const root = tempDir(`devchestra-worktree-${label}-`);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "worktree-qa@example.invalid"]);
  git(root, ["config", "user.name", "Worktree QA"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  writeFileSync(join(root, "dirty.txt"), "committed\n");
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  mkdirSync(join(root, "ignored"));
  writeFileSync(join(root, "ignored", "cache.txt"), "ignored\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "dirty.txt"), "dirty\n");
  writeFileSync(join(root, "untracked.txt"), "untracked\n");
  return { root, base };
}

function worktreeRequest(
  dataDir: string,
  repo: Repo,
  overrides: Record<string, unknown> = {},
): Parameters<typeof acquireScratch>[0] {
  return {
    dataDir,
    projectId: "worktree-project",
    runId: "worktree-run",
    path: "agent",
    attempt: 1,
    generation: 1,
    mode: "worktree",
    projectRoot: repo.root,
    ...overrides,
  } as Parameters<typeof acquireScratch>[0];
}

function unwrap<T>(result: Result<T, DevChestraError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function failure(result: Result<unknown, DevChestraError>): DevChestraError {
  if (result.ok) throw new Error("expected an error result");
  return result.error;
}

function requireCli(): void {
  const missing = [
    [CLI, "packages/cli/dist/main.js"],
    [join(REPO_ROOT, "packages/mcp/dist/bin/shim.js"), "packages/mcp/dist/bin/shim.js"],
    [join(REPO_ROOT, "tools/fake-agent/dist/main.js"), "tools/fake-agent/dist/main.js"],
    [join(REPO_ROOT, "packages/workspaces/dist/index.js"), "packages/workspaces/dist/index.js"],
  ]
    .filter(([path]) => !existsSync(path as string))
    .map(([, label]) => label);
  if (missing.length > 0) {
    throw new Error(`Worktree acceptance prerequisites are missing: ${missing.join(", ")}`);
  }
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], home: string): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function summary(stdout: string): Record<string, unknown> & { result?: Record<string, string> } {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const line = lines.find((item) => item.type === "summary");
  if (line === undefined) throw new Error(`CLI emitted no summary: ${stdout}`);
  return line;
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

const mixedWorkflow = {
  schemaVersion: 1,
  id: "worktree-mixed",
  name: "Worktree mixed",
  graph: {
    nodes: [
      {
        id: "start",
        type: "start",
        name: "Start",
        params: [],
      },
      {
        id: "w1",
        type: "shell",
        name: "Worktree first",
        command:
          "printf 'tracked=%s dirty=%s untracked=%s ignored=%s' " +
          '"$(cat tracked.txt)" "$(cat dirty.txt)" ' +
          '"$(test -f untracked.txt && echo present || echo absent)" ' +
          '"$(test -f ignored/cache.txt && echo present || echo absent)"; ' +
          "printf 'shared' > shared.txt",
        workspace: { mode: "worktree" },
        timeoutMin: 1,
      },
      {
        id: "agent",
        type: "agent",
        name: "Agent",
        cli: "fake",
        prompt: "Return ok.",
        output: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
        permissions: { network: false, write: ["workspace"] },
        workspace: { mode: "worktree" },
        limits: { timeoutMin: 1, validationRetries: 1, crashRetries: 0 },
      },
      {
        id: "scratch",
        type: "shell",
        name: "Scratch",
        command:
          "printf 'tracked=%s shared=%s' " +
          '"$(test -f tracked.txt && echo present || echo absent)" ' +
          '"$(test -f shared.txt && echo present || echo absent)"',
        workspace: { mode: "scratch" },
        timeoutMin: 1,
      },
      {
        id: "w2",
        type: "shell",
        name: "Worktree second",
        command: 'printf \'shared=%s tracked=%s\' "$(cat shared.txt)" "$(cat tracked.txt)"',
        workspace: { mode: "worktree" },
        timeoutMin: 1,
      },
      {
        id: "end",
        type: "end",
        name: "End",
        status: "success",
        result:
          '{ "w1": w1.stdout, "agent": agent.summary, "scratch": scratch.stdout, "w2": w2.stdout }',
      },
    ],
    edges: [
      { id: "e1", from: "start", to: "w1" },
      { id: "e2", from: "w1", to: "agent" },
      { id: "e3", from: "agent", to: "scratch" },
      { id: "e4", from: "scratch", to: "w2" },
      { id: "e5", from: "w2", to: "end" },
    ],
  },
};

describe("explicit worktree workspace lifecycle", () => {
  it("shares one detached worktree pinned to the first project HEAD, committed files only", async () => {
    const repo = makeRepo("pinned");
    const dataDir = join(tempDir("devchestra-worktree-data-"), "data");
    const first = unwrap(await acquireScratch(worktreeRequest(dataDir, repo)));
    const second = unwrap(
      await acquireScratch(worktreeRequest(dataDir, repo, { path: "shell", attempt: 2 })),
    );

    expect(first.mode).toBe("worktree");
    expect(second.dir).toBe(first.dir);
    expect(first.dir.startsWith(dataDir)).toBe(true);
    expect(first.dir.startsWith(repo.root)).toBe(false);
    expect(readFileSync(join(first.dir, "tracked.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(first.dir, "dirty.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(first.dir, "untracked.txt"))).toBe(false);
    expect(existsSync(join(first.dir, "ignored/cache.txt"))).toBe(false);
    expect(git(first.dir, ["rev-parse", "HEAD"])).toBe(repo.base);
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: first.dir }).status).not.toBe(0);

    expect(readFileSync(join(repo.root, "dirty.txt"), "utf8")).toBe("dirty\n");
    expect(existsSync(join(repo.root, "untracked.txt"))).toBe(true);
    expect(git(repo.root, ["rev-parse", "HEAD"])).toBe(repo.base);

    writeFileSync(join(repo.root, "tracked.txt"), "second\n");
    git(repo.root, ["add", "tracked.txt"]);
    git(repo.root, ["commit", "-qm", "later"]);
    const later = git(repo.root, ["rev-parse", "HEAD"]);
    expect(later).not.toBe(repo.base);
    const reacquired = unwrap(await acquireScratch(worktreeRequest(dataDir, repo)));
    expect(reacquired.dir).toBe(first.dir);
    expect(git(reacquired.dir, ["rev-parse", "HEAD"])).toBe(repo.base);
    expect(readFileSync(join(reacquired.dir, "tracked.txt"), "utf8")).toBe("base\n");

    writeFileSync(join(first.dir, "shared.txt"), "shared\n");
    const shell = unwrap(
      await acquireScratch(worktreeRequest(dataDir, repo, { path: "shell", attempt: 2 })),
    );
    expect(readFileSync(join(shell.dir, "shared.txt"), "utf8")).toBe("shared\n");

    const scratch = unwrap(
      await acquireScratch(worktreeRequest(dataDir, repo, { path: "scratch", mode: "scratch" })),
    );
    expect(scratch.mode).toBe("scratch");
    expect(scratch.dir).not.toBe(first.dir);
    expect(existsSync(join(scratch.dir, "tracked.txt"))).toBe(false);
    expect(existsSync(join(scratch.dir, "shared.txt"))).toBe(false);
  });

  it("preserves the directory and files across per-node finalization, release and restart", async () => {
    const repo = makeRepo("recover");
    const dataDir = join(tempDir("devchestra-worktree-data-"), "data");
    const agent = unwrap(await acquireScratch(worktreeRequest(dataDir, repo)));
    writeFileSync(join(agent.dir, "agent.txt"), "kept\n");
    const finalized = unwrap(
      await finalizeScratch(agent, {
        outcome: "success",
        process: { attempt: 1, generation: 1, stopped: true, reason: "exited", exitCode: 0 },
      }),
    );
    expect(finalized.dir).toBe(agent.dir);
    releaseScratch(agent);

    const shell = unwrap(
      await acquireScratch(worktreeRequest(dataDir, repo, { path: "shell", attempt: 1 })),
    );
    expect(shell.dir).toBe(agent.dir);
    expect(readFileSync(join(shell.dir, "agent.txt"), "utf8")).toBe("kept\n");
    writeFileSync(join(shell.dir, "shell.txt"), "also kept\n");
    releaseScratch(shell);

    const requestFile = join(tempDir("devchestra-worktree-recover-"), "request.json");
    writeFileSync(
      requestFile,
      JSON.stringify(worktreeRequest(dataDir, repo, { requireExisting: true })),
    );
    const script = join(tempDir("devchestra-worktree-child-"), "recover.mts");
    writeFileSync(
      script,
      [
        'import { readFileSync } from "node:fs";',
        `import { acquireScratch, releaseScratch } from ${JSON.stringify(WORKSPACES_DIST)};`,
        'const request = JSON.parse(readFileSync(process.argv[2] as string, "utf8"));',
        "const result = await acquireScratch(request);",
        "if (!result.ok) { console.error(JSON.stringify(result.error)); process.exit(1); }",
        "process.stdout.write(JSON.stringify({ dir: result.value.dir, mode: result.value.mode }));",
        "releaseScratch(result.value);",
      ].join("\n"),
    );
    const child = execFileSync(process.execPath, ["--import", "tsx", script, requestFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(JSON.parse(child)).toMatchObject({ dir: agent.dir, mode: "worktree" });
    expect(readFileSync(join(agent.dir, "agent.txt"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(agent.dir, "shell.txt"), "utf8")).toBe("also kept\n");

    const missing = await acquireScratch(
      worktreeRequest(dataDir, repo, { runId: "missing-run", requireExisting: true }),
    );
    expect(failure(missing).code).toBe("E_WORKSPACE");
    expect(existsSync(join(dataDir, "projects", "worktree-project", "runs"))).toBe(true);
  });

  it("rejects a changed project or repository identity instead of recreating", async () => {
    const repo = makeRepo("identity");
    const other = makeRepo("identity-other");
    const dataDir = join(tempDir("devchestra-worktree-data-"), "data");
    const original = unwrap(await acquireScratch(worktreeRequest(dataDir, repo)));
    writeFileSync(join(original.dir, "kept.txt"), "kept\n");

    const movedProject = await acquireScratch(
      worktreeRequest(dataDir, repo, { projectRoot: other.root }),
    );
    expect(["E_WORKSPACE", "E_CONFLICT"]).toContain(failure(movedProject).code);
    expect(readFileSync(join(original.dir, "kept.txt"), "utf8")).toBe("kept\n");

    const movedRoot = `${repo.root}.moved`;
    renameSync(repo.root, movedRoot);
    cleanup.push(() => rmSync(movedRoot, { recursive: true, force: true }));
    mkdirSync(repo.root);
    git(repo.root, ["init", "-q"]);
    git(repo.root, ["config", "user.email", "other@example.invalid"]);
    git(repo.root, ["config", "user.name", "Other"]);
    writeFileSync(join(repo.root, "tracked.txt"), "other\n");
    git(repo.root, ["add", "."]);
    git(repo.root, ["commit", "-qm", "other"]);
    const replaced = await acquireScratch(worktreeRequest(dataDir, repo));
    expect(["E_WORKSPACE", "E_CONFLICT"]).toContain(failure(replaced).code);
    expect(readFileSync(join(original.dir, "kept.txt"), "utf8")).toBe("kept\n");
  });
});

describe("run-level worktree through the linear CLI runner", () => {
  it("runs every node, including a legacy scratch node, in one selected worktree", () => {
    requireCli();
    const home = tempDir("devchestra-worktree-cli-home-");
    const repo = makeRepo("cli");
    const dataDir = join(tempDir("devchestra-worktree-cli-data-"), "data");
    mkdirSync(dataDir, { recursive: true });
    const workflowPath = join(repo.root, "worktree-mixed.json");
    writeFileSync(workflowPath, JSON.stringify(mixedWorkflow, null, 2));
    const scriptPath = join(repo.root, "fake.json");
    writeFileSync(scriptPath, JSON.stringify([{ type: "submit", output: { summary: "ok" } }]));
    const before = {
      tracked: readFileSync(join(repo.root, "tracked.txt"), "utf8"),
      dirty: readFileSync(join(repo.root, "dirty.txt"), "utf8"),
      status: git(repo.root, ["status", "--porcelain"]),
      head: git(repo.root, ["rev-parse", "HEAD"]),
    };

    const run = runCli(
      [
        "run",
        workflowPath,
        "--project",
        repo.root,
        "--data-dir",
        dataDir,
        "--fake-script",
        scriptPath,
        "--workspace",
        "new-worktree",
        "--json",
      ],
      home,
    );
    expect(run.status, run.stderr).toBe(0);
    const result = summary(run.stdout);
    expect(result.status).toBe("succeeded");
    expect(result.result).toEqual({
      w1: "tracked=base dirty=committed untracked=absent ignored=absent",
      agent: "ok",
      scratch: "tracked=present shared=present",
      w2: "shared=shared tracked=base",
    });

    const cwds = spawnCwds(run.stdout);
    const w1 = cwds.get("w1");
    const agent = cwds.get("agent");
    const scratch = cwds.get("scratch");
    const w2 = cwds.get("w2");
    expect(w1).toBeDefined();
    expect(agent).toBe(w1);
    expect(w2).toBe(w1);
    expect(scratch).toBeDefined();
    expect(scratch).toBe(w1);
    for (const cwd of [w1, agent, scratch, w2]) {
      expect((cwd as string).startsWith(dataDir)).toBe(true);
      expect((cwd as string).startsWith(repo.root)).toBe(false);
    }
    expect(readFileSync(join(w1 as string, "tracked.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(w1 as string, "shared.txt"), "utf8")).toBe("shared");

    expect(readFileSync(join(repo.root, "tracked.txt"), "utf8")).toBe(before.tracked);
    expect(readFileSync(join(repo.root, "dirty.txt"), "utf8")).toBe(before.dirty);
    expect(git(repo.root, ["status", "--porcelain"])).toBe(before.status);
    expect(git(repo.root, ["rev-parse", "HEAD"])).toBe(before.head);
  });

  it("rejects unsupported legacy node workspace base/setup/from", () => {
    requireCli();
    const home = tempDir("devchestra-worktree-reject-home-");
    const repo = makeRepo("reject");
    const dataDir = join(tempDir("devchestra-worktree-reject-data-"), "data");
    mkdirSync(dataDir, { recursive: true });
    interface MutableView {
      graph: { nodes: Array<{ workspace: Record<string, unknown> }> };
    }
    const shellNode = (value: MutableView) => {
      const node = value.graph.nodes[1];
      if (node === undefined) throw new Error("mixed workflow is missing its first shell node");
      return node;
    };
    const fakeScript = join(repo.root, "reject-fake.json");
    writeFileSync(
      fakeScript,
      JSON.stringify([{ type: "submit", output: { summary: "not used" } }]),
    );
    const cases: Array<[string, (value: MutableView) => void]> = [
      ["base", (value) => (shellNode(value).workspace.base = "HEAD")],
      ["setup", (value) => (shellNode(value).workspace.setup = "true")],
      ["from", (value) => (shellNode(value).workspace.from = "start")],
    ];
    for (const [name, mutate] of cases) {
      const value = structuredClone(mixedWorkflow) as unknown as MutableView;
      mutate(value);
      const workflowPath = join(repo.root, `reject-${name}.json`);
      writeFileSync(workflowPath, JSON.stringify(value));
      const run = runCli(
        [
          "run",
          workflowPath,
          "--project",
          repo.root,
          "--data-dir",
          dataDir,
          "--fake-script",
          fakeScript,
          "--json",
        ],
        home,
      );
      expect(run.status, `${name}: ${run.stderr}`).toBe(4);
      expect(`${run.stdout}\n${run.stderr}`).toMatch(
        /worktree|workspace|project mode|not supported|unsupported/i,
      );
    }
  });
});
