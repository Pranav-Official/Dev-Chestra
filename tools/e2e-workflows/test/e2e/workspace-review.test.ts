import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addNode,
  bootstrapPage,
  connectNodes,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  openEditor,
  registerProjectThroughUi,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitRunSucceeded,
  waitSaved,
  waitValidation,
} from "../../src/browser-ui.js";
import { CLI, makeWorkspace, scriptPath } from "../../src/fixtures.js";
import { DevChestraHttp } from "../../src/http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { collectSpawnedAgents } from "../../src/store-read.js";
import { getWorkflow, type WorkflowFileLike } from "../../src/workflow-api.js";

const EVIDENCE_DIR = "/tmp/opencode/worktree-review";

interface WorkspaceNodeView {
  dir: string;
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
}

interface ProcessView {
  cwd: string;
}

interface ExecutionDetail {
  output: { data: Record<string, unknown> | null } | null;
  process: ProcessView | null;
  workspace: WorkspaceNodeView | null;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function nodeOf(file: WorkflowFileLike, type: "agent" | "shell"): Record<string, unknown> {
  const node = file.graph.nodes.find((item) => item.type === type);
  assert.ok(node !== undefined, `workflow has no ${type} node`);
  return node;
}

async function executionDetail(
  http: DevChestraHttp,
  runId: string,
  path: string,
): Promise<ExecutionDetail> {
  const result = await http.api(
    "GET",
    `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(path)}`,
  );
  assert.equal(result.status, 200, `GET execution ${path}: ${result.text.slice(0, 500)}`);
  return result.body as ExecutionDetail;
}

async function waitPanelText(page: Page, value: string): Promise<string> {
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-testid="detail-panel"]')?.textContent?.includes(needle) ??
      false,
    value,
    { timeout: 20_000 },
  );
  return (await page.getByTestId("detail-panel").textContent()) ?? "";
}

beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

describe("run-level workspace review", () => {
  it("selects a new run worktree in Run Start and confirms it in the run review and details", async () => {
    const ws = await makeWorkspace("devchestra-worktree-review-");
    const home = join(ws.root, "home");
    const codexHome = join(ws.root, "codex-home");
    const gitConfig = join(ws.root, "gitconfig");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(gitConfig, "");

    const savedEnv = {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    };
    process.env.HOME = home;
    process.env.CODEX_HOME = codexHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const env: NodeJS.ProcessEnv = { ...process.env };

    git(ws.projectDir, ["init", "-q"], env);
    git(ws.projectDir, ["config", "user.email", "workspace-review@example.invalid"], env);
    git(ws.projectDir, ["config", "user.name", "Workspace Review"], env);
    writeFileSync(join(ws.projectDir, "project.txt"), "committed-head\n");
    writeFileSync(join(ws.projectDir, "dirty.txt"), "committed\n");
    writeFileSync(join(ws.projectDir, ".gitignore"), "ignored/\n");
    mkdirSync(join(ws.projectDir, "ignored"));
    writeFileSync(join(ws.projectDir, "ignored", "cache.txt"), "ignored\n");
    git(ws.projectDir, ["add", "."], env);
    git(ws.projectDir, ["commit", "-qm", "base"], env);
    const base = git(ws.projectDir, ["rev-parse", "HEAD"], env);
    writeFileSync(join(ws.projectDir, "dirty.txt"), "dirty\n");
    writeFileSync(join(ws.projectDir, "untracked.txt"), "untracked\n");

    const sentinel = startSentinel();
    let server: OwnedServer | null = null;
    let context: BrowserContext | null = null;

    const cleanup = async (): Promise<unknown[]> => {
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };

      const closingContext = context;
      if (closingContext !== null) await attempt(() => closingContext.close());
      const ownedServer = server;
      if (ownedServer !== null) {
        let agents: ReturnType<typeof collectSpawnedAgents> | null = null;
        let keepRoot = false;
        try {
          agents = collectSpawnedAgents(ws.dataDir);
        } catch (error) {
          failures.push(error);
          keepRoot = true;
        }
        await attempt(() =>
          shutdownOwned({
            server: ownedServer,
            agents: agents ?? [],
            sentinel,
            keep: keepRoot,
            dataDir: ws.root,
          }),
        );
      } else {
        await attempt(() => {
          if (sentinel.exitCode !== null || sentinel.signalCode !== null) {
            throw new Error("unrelated sentinel died during cleanup");
          }
          sentinel.kill("SIGKILL");
        });
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return failures;
    };

    let testFailed = false;
    let testFailure: unknown;
    try {
      server = await startServer({
        cli: CLI,
        dataDir: ws.dataDir,
        cwd: ws.projectDir,
        fakeScript: scriptPath("summary"),
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      const http = new DevChestraHttp(server.baseUrl);
      await http.health();
      await http.bootstrap(server.meta.token);

      const session = await launchBrowser(ws);
      context = session.context;
      const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
      const projectId = await registerProjectThroughUi(page, ws.projectDir);
      const workflowId = await createBlankWorkflowThroughUi(
        page,
        projectId,
        "Worktree review workflow",
        "worktree-review",
      );

      for (const type of ["start", "agent", "shell", "end"] as const) await addNode(page, type);
      await fitView(page);

      await selectNode(page, "agent");
      await page.getByTestId("inspector-node-name").fill("Committed agent");
      await setAgentCliFake(http, page, projectId, workflowId, "agent");
      await page.getByTestId("inspector-agent-prompt").fill("Return the accepted fake output.");
      assert.equal(
        await page.getByTestId("inspector-workspace-mode").count(),
        0,
        "Agent inspector must not expose a per-node workspace selector",
      );
      assert.equal(
        ((await page.getByTestId("inspector-workspace-note").textContent()) ?? "").trim(),
        "Workspace is chosen when starting the workflow.",
      );

      await selectNode(page, "shell");
      await page.getByTestId("inspector-node-name").fill("Committed shell");
      const command = [
        "printf 'project=%s dirty=%s untracked=%s ignored=%s cwd=%s'",
        '"$(cat project.txt)"',
        '"$(cat dirty.txt)"',
        '"$(test -f untracked.txt && echo present || echo absent)"',
        '"$(test -f ignored/cache.txt && echo present || echo absent)"',
        '"$PWD"',
      ].join(" ");
      await page.getByTestId("inspector-shell-command").fill(command);
      assert.equal(
        await page.getByTestId("inspector-workspace-mode").count(),
        0,
        "Shell inspector must not expose a per-node workspace selector",
      );
      assert.equal(
        ((await page.getByTestId("inspector-workspace-note").textContent()) ?? "").trim(),
        "Workspace is chosen when starting the workflow.",
      );

      await selectNode(page, "end");
      await page
        .getByTestId("inspector-end-result")
        .fill('{"agent": agent.summary, "shell": shell.stdout}');

      await connectNodes(page, "start", "agent");
      await page.waitForFunction(
        () => document.querySelectorAll(".react-flow__edge").length === 1,
        undefined,
        { timeout: 10_000 },
      );
      await connectNodes(page, "agent", "shell");
      await page.waitForFunction(
        () => document.querySelectorAll(".react-flow__edge").length === 2,
        undefined,
        { timeout: 10_000 },
      );
      await connectNodes(page, "shell", "end");
      await page.waitForFunction(
        () => document.querySelectorAll(".react-flow__edge").length === 3,
        undefined,
        { timeout: 10_000 },
      );

      await saveNow(page);
      await waitValidation(page, "Valid");
      const saved = await getWorkflow(http, projectId, workflowId);
      assert.equal(
        Object.hasOwn(nodeOf(saved.workflow, "agent"), "workspace"),
        false,
        "fresh agent nodes must omit per-node workspace",
      );
      assert.equal(
        Object.hasOwn(nodeOf(saved.workflow, "shell"), "workspace"),
        false,
        "fresh shell nodes must omit per-node workspace",
      );
      const editorShot = join(EVIDENCE_DIR, "editor-run-workspace-note.png");
      await page.screenshot({ path: editorShot, fullPage: true });

      await openEditor(page, projectId, workflowId);
      await waitSaved(page);
      await selectNode(page, "agent");
      assert.equal(
        ((await page.getByTestId("inspector-workspace-note").textContent()) ?? "").trim(),
        "Workspace is chosen when starting the workflow.",
      );
      const reloaded = await getWorkflow(http, projectId, workflowId);
      assert.equal(reloaded.text, saved.text, "save -> reload must be byte-stable");

      await page.getByRole("button", { name: /^run$/i }).first().click();
      const dialog = page.getByRole("dialog", { name: /run workflow/i });
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
      await dialog.getByTestId("run-workspace-mode-new").check();
      await dialog.getByRole("button", { name: /review and run|review/i }).click();
      const reviewText = (await dialog.getByTestId("run-workspace-review").textContent()) ?? "";
      assert.match(reviewText, /new Git worktree is created under DevChestra's data directory/u);
      assert.match(reviewText, /Uncommitted and untracked project files are not present/u);
      assert.match(reviewText, /workspace is fixed for this run/u);
      const reviewShot = join(EVIDENCE_DIR, "run-review-workspace.png");
      await dialog.screenshot({ path: reviewShot });

      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
        { timeout: 60_000 },
      );
      await dialog.getByRole("button", { name: /start run/i }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 202, "managed run must start asynchronously");
      await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
      const match = /\/p\/[^/]+\/r\/([^/?#]+)/u.exec(page.url());
      assert.ok(match?.[1] !== undefined, "run navigation has no run id");
      const runId = decodeURIComponent(match[1]);
      await waitRunSucceeded(page, 90_000);

      const agent = await executionDetail(http, runId, "agent");
      const shell = await executionDetail(http, runId, "shell");
      assert.ok(agent.workspace !== null, "Agent execution has no workspace detail");
      assert.ok(shell.workspace !== null, "Shell execution has no workspace detail");
      assert.equal(agent.workspace.dir, shell.workspace.dir, "agent and shell must share one dir");
      assert.equal(agent.workspace.baseSha, base, "worktree must be pinned to committed HEAD");
      assert.equal(shell.workspace.baseSha, base, "worktree must be pinned to committed HEAD");
      assert.equal(agent.workspace.commitSha, null, "finalizing the worktree must not commit");
      assert.equal(shell.workspace.commitSha, null, "finalizing the worktree must not commit");
      assert.ok(agent.workspace.dir.startsWith(ws.dataDir), "worktree must live under data dir");
      assert.ok(
        agent.workspace.dir.startsWith(ws.projectDir) === false,
        "worktree must not be the project directory",
      );
      assert.equal(agent.process?.cwd, agent.workspace.dir, "Agent process cwd must be worktree");
      assert.equal(shell.process?.cwd, shell.workspace.dir, "Shell process cwd must be worktree");
      assert.equal(agent.process?.cwd, shell.process?.cwd, "Agent and shell must share cwd");

      const shellOutput = shell.output?.data;
      assert.ok(shellOutput !== null && shellOutput !== undefined, "Shell output is missing");
      const stdout = String(shellOutput.stdout);
      assert.equal(
        stdout,
        `project=committed-head dirty=committed untracked=absent ignored=absent cwd=${agent.workspace.dir}`,
        "shell must see only committed HEAD files from the shared worktree",
      );
      const agentOutput = agent.output?.data;
      assert.ok(agentOutput !== null && agentOutput !== undefined, "Agent output is missing");
      assert.equal(agentOutput.summary, "acceptance summary");

      await page.getByTestId("run-node-agent").click();
      const agentPanel = await waitPanelText(page, "CWD");
      assert.ok(
        agentPanel.includes(agent.workspace.dir),
        "run detail must show the agent worktree directory",
      );
      assert.ok(
        agentPanel.includes(agent.process?.cwd ?? ""),
        "run detail must show the agent process cwd",
      );
      assert.ok(
        agentPanel.includes(base.slice(0, 12)),
        "run detail must show the committed HEAD base sha",
      );
      const detailPanel = page.getByTestId("detail-panel");
      await detailPanel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
      const agentShot = join(EVIDENCE_DIR, "run-detail-agent-worktree.png");
      await detailPanel.screenshot({ path: agentShot });

      await page.getByTestId("run-node-shell").click();
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.get("path") === "shell",
        undefined,
        { timeout: 10_000 },
      );
      const shellPanel = await waitPanelText(page, "CWD");
      assert.ok(
        shellPanel.includes(shell.workspace.dir),
        "run detail must show the shell worktree directory",
      );
      assert.ok(
        shellPanel.includes(shell.process?.cwd ?? ""),
        "run detail must show the shell process cwd",
      );
      assert.ok(
        shellPanel.includes(base.slice(0, 12)),
        "run detail must show the committed HEAD base sha",
      );
      await detailPanel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
      const shellShot = join(EVIDENCE_DIR, "run-detail-shell-worktree.png");
      await detailPanel.screenshot({ path: shellShot });

      const evidence = {
        ok: true,
        projectId,
        workflowId,
        runId,
        base,
        worktreeDir: agent.workspace.dir,
        agentCwd: agent.process?.cwd ?? null,
        shellCwd: shell.process?.cwd ?? null,
        reviewWorktreeText: true,
        saveReloadStable: true,
        shellStdout: stdout,
        screenshots: { editorShot, reviewShot, agentShot, shellShot },
      };
      writeFileSync(join(EVIDENCE_DIR, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      expect(evidence.ok).toBe(true);
      process.stdout.write(`WORKTREE_REVIEW_EVIDENCE ${JSON.stringify(evidence)}\n`);
    } catch (error) {
      testFailed = true;
      testFailure = error;
    }
    const cleanupFailures = await cleanup();
    if (testFailed) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError([testFailure, ...cleanupFailures], "test and cleanup failed");
      }
      throw testFailure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "workspace review cleanup failed");
    }
  }, 300_000);
});
