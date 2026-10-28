import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { describe, it } from "vitest";
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
import { CLI, scriptPath } from "../../src/fixtures.js";
import { DevChestraHttp } from "../../src/http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { collectSpawnedAgents } from "../../src/store-read.js";
import { getWorkflow } from "../../src/workflow-api.js";
import {
  cleanupTempRoots,
  git,
  isolatedGitEnv,
  makeRunWorkspaceRepo,
  tempRoot,
} from "../support/run-workspace-fixtures.js";

interface ExecutionDetail {
  process: { cwd: string } | null;
  output: { data: Record<string, unknown> | null } | null;
  workspace: { dir: string } | null;
}

interface DirIdentity {
  dev: number;
  ino: number;
  commonDir: string;
}

function directoryIdentity(path: string, env: NodeJS.ProcessEnv): DirIdentity {
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  const common = git(path, ["rev-parse", "--git-common-dir"], env);
  return { dev: info.dev, ino: info.ino, commonDir: realpathSync(resolve(path, common)) };
}

async function execution(
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

function shellStdout(detail: ExecutionDetail): string {
  const data = detail.output?.data;
  assert.ok(data !== null && data !== undefined, "shell execution has no output");
  return String(data.stdout);
}

async function startRunThroughUi(
  page: Page,
  selection:
    | { mode: "project" }
    | { mode: "existing-worktree"; path: string }
    | { mode: "new-worktree" },
): Promise<{ runId: string; body: Record<string, unknown>; status: number; request: Request }> {
  await page.getByRole("button", { name: /^run$/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /run workflow/i });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  await dialog.getByTestId("run-workspace-choice").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await dialog.getByTestId("run-workspace-mode-project").isChecked(),
    true,
    "project root must be the default",
  );
  if (selection.mode === "existing-worktree") {
    await dialog.getByTestId("run-workspace-mode-existing").check();
    const select = dialog.getByTestId("run-workspace-existing-path");
    await select.waitFor({ state: "visible", timeout: 10_000 });
    await select.selectOption(selection.path);
  }
  if (selection.mode === "new-worktree") {
    await dialog.getByTestId("run-workspace-mode-new").check();
  }
  await dialog.getByRole("button", { name: /review and run|review/i }).click();
  await dialog.getByTestId("run-workspace-review").waitFor({ state: "visible", timeout: 10_000 });
  if (selection.mode === "existing-worktree") {
    const review = (await dialog.getByTestId("run-workspace-review").textContent()) ?? "";
    assert.ok(review.includes(selection.path), "review must name the selected worktree");
  }
  if (selection.mode === "new-worktree") {
    const review = (await dialog.getByTestId("run-workspace-review").textContent()) ?? "";
    assert.match(review, /new Git worktree/i);
    assert.match(review, /committed HEAD/i);
  }
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(request.url()).pathname),
    { timeout: 30_000 },
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
    { timeout: 60_000 },
  );
  await dialog.getByRole("button", { name: /start run/i }).click();
  const request = await requestPromise;
  const response = await responsePromise;
  await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
  const match = /\/p\/[^/]+\/r\/([^/?#]+)/u.exec(page.url());
  assert.ok(match?.[1] !== undefined, "run navigation has no run id");
  const body = request.postDataJSON() as Record<string, unknown>;
  return {
    runId: decodeURIComponent(match[1]),
    body,
    status: response.status(),
    request,
  };
}

async function assertInspectorHasNoSelector(page: Page): Promise<void> {
  for (const id of ["agent", "shell"]) {
    await selectNode(page, id);
    assert.equal(
      await page.getByTestId("inspector-workspace-mode").count(),
      0,
      `${id} inspector must not expose a workspace selector`,
    );
    assert.equal(
      await page.getByTestId("inspector-workspace-worktree-note").count(),
      0,
      `${id} inspector must not expose a worktree note`,
    );
    const note = page.getByTestId("inspector-workspace-note");
    await note.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      ((await note.textContent()) ?? "").trim(),
      "Workspace is chosen when starting the workflow.",
    );
  }
}

describe("run workspace Chromium acceptance", () => {
  it("chooses one workspace in Run Start, leaves inspectors clean, and sees dirty/untracked files only in root mode", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-browser-");
    const work = tempRoot("devchestra-run-ws-browser-work-");
    const dataDir = join(work.dir, "data");
    const profileDir = join(work.dir, "profile");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const env = isolatedGitEnv(repo.home);
    const rootIdentityBefore = directoryIdentity(repo.root, env);
    const existingIdentityBefore = directoryIdentity(repo.existingWorktree, env);
    const dirtyBefore = readFileSync(join(repo.root, "dirty.txt"), "utf8");
    const untrackedBefore = readFileSync(join(repo.root, "untracked.txt"), "utf8");
    const projectHeadBefore = git(repo.root, ["rev-parse", "HEAD"], env);

    const sentinel = startSentinel();
    let server: OwnedServer | null = null;
    let context: BrowserContext | null = null;
    let testFailure: unknown;
    let failed = false;
    try {
      server = await startServer({
        cli: CLI,
        dataDir,
        cwd: repo.root,
        fakeScript: scriptPath("summary"),
        env: {
          HOME: repo.home,
          GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      const http = new DevChestraHttp(server.baseUrl);
      await http.health();
      await http.bootstrap(server.meta.token);
      const session = await launchBrowser({
        root: work.dir,
        projectDir: repo.root,
        dataDir,
        profileDir,
      });
      context = session.context;
      const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
      const projectId = await registerProjectThroughUi(page, repo.root);
      const workflowId = await createBlankWorkflowThroughUi(
        page,
        projectId,
        "Run workspace browser",
        "run-workspace-browser",
      );

      for (const type of ["start", "agent", "shell", "end"] as const) await addNode(page, type);
      await fitView(page);
      await selectNode(page, "agent");
      await page.getByTestId("inspector-node-name").fill("Workspace agent");
      await setAgentCliFake(http, page, projectId, workflowId, "agent");
      await page.getByTestId("inspector-agent-prompt").fill("Return the accepted fake output.");
      await selectNode(page, "shell");
      await page.getByTestId("inspector-node-name").fill("Workspace shell");
      await page
        .getByTestId("inspector-shell-command")
        .fill(
          "printf 'tracked=%s dirty=%s untracked=%s cwd=%s' " +
            '"$(cat tracked.txt)" "$(cat dirty.txt)" ' +
            '"$(test -f untracked.txt && echo present || echo absent)" "$PWD"',
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
      assert.ok(saved.validation.ok, "workflow must validate before run");
      await assertInspectorHasNoSelector(page);

      const projectRun = await startRunThroughUi(page, { mode: "project" });
      assert.equal(projectRun.status, 202, "project run must start asynchronously");
      assert.deepEqual(projectRun.body.workspace, { mode: "project" });
      await waitRunSucceeded(page, 90_000);
      const projectAgent = await execution(http, projectRun.runId, "agent");
      const projectShell = await execution(http, projectRun.runId, "shell");
      assert.equal(projectAgent.process?.cwd, realpathSync(repo.root));
      assert.equal(projectShell.process?.cwd, realpathSync(repo.root));
      assert.equal(projectShell.workspace?.dir, realpathSync(repo.root));
      const projectStdout = shellStdout(projectShell);
      assert.match(projectStdout, /dirty=dirty-local/u);
      assert.match(projectStdout, /untracked=present/u);
      assert.ok(
        projectStdout.endsWith(`cwd=${realpathSync(repo.root)}`),
        `root-mode shell cwd: ${projectStdout}`,
      );

      await openEditor(page, projectId, workflowId);
      await waitSaved(page);
      const existingRun = await startRunThroughUi(page, {
        mode: "existing-worktree",
        path: repo.existingWorktree,
      });
      assert.equal(existingRun.status, 202, "existing-worktree run must start");
      assert.deepEqual(existingRun.body.workspace, {
        mode: "existing-worktree",
        path: repo.existingWorktree,
      });
      await waitRunSucceeded(page, 90_000);
      const existingAgent = await execution(http, existingRun.runId, "agent");
      const existingShell = await execution(http, existingRun.runId, "shell");
      assert.equal(existingAgent.process?.cwd, realpathSync(repo.existingWorktree));
      assert.equal(existingShell.process?.cwd, realpathSync(repo.existingWorktree));
      const existingStdout = shellStdout(existingShell);
      assert.match(existingStdout, /dirty=committed/u);
      assert.match(existingStdout, /untracked=absent/u);

      await openEditor(page, projectId, workflowId);
      await waitSaved(page);
      const newRun = await startRunThroughUi(page, { mode: "new-worktree" });
      assert.equal(newRun.status, 202, "new-worktree run must start");
      assert.deepEqual(newRun.body.workspace, { mode: "new-worktree" });
      await waitRunSucceeded(page, 90_000);
      const newAgent = await execution(http, newRun.runId, "agent");
      const newShell = await execution(http, newRun.runId, "shell");
      const newAgentCwd = newAgent.process?.cwd;
      const newShellCwd = newShell.process?.cwd;
      assert.ok(newAgentCwd !== undefined, "new-worktree agent has no cwd");
      assert.equal(newAgentCwd, newShellCwd, "new-worktree agent and shell must share cwd");
      assert.notEqual(newAgentCwd, realpathSync(repo.root), "new worktree must not be the root");
      assert.notEqual(
        newAgentCwd,
        realpathSync(repo.existingWorktree),
        "new worktree must not reuse the existing worktree",
      );
      const dataReal = realpathSync(dataDir);
      assert.ok(
        newAgentCwd === dataReal || newAgentCwd.startsWith(`${dataReal}/`),
        `new worktree must live under the server data dir: ${newAgentCwd}`,
      );
      assert.equal(newShell.workspace?.dir, newAgentCwd);
      const newStdout = shellStdout(newShell);
      assert.match(newStdout, /dirty=committed/u);
      assert.match(newStdout, /untracked=absent/u);
      assert.ok(newStdout.endsWith(`cwd=${newAgentCwd}`), `new-worktree shell cwd: ${newStdout}`);
      const newIdentity = directoryIdentity(newAgentCwd, env);
      assert.equal(
        newIdentity.commonDir,
        rootIdentityBefore.commonDir,
        "new worktree must belong to the registered repository",
      );

      const existingIdentityAfter = directoryIdentity(repo.existingWorktree, env);
      assert.equal(existingIdentityAfter.dev, existingIdentityBefore.dev);
      assert.equal(existingIdentityAfter.ino, existingIdentityBefore.ino);
      assert.equal(existingIdentityAfter.commonDir, existingIdentityBefore.commonDir);
      const rootIdentityAfter = directoryIdentity(repo.root, env);
      assert.equal(rootIdentityAfter.dev, rootIdentityBefore.dev);
      assert.equal(rootIdentityAfter.ino, rootIdentityBefore.ino);
      assert.equal(rootIdentityAfter.commonDir, rootIdentityBefore.commonDir);
      assert.equal(readFileSync(join(repo.root, "dirty.txt"), "utf8"), dirtyBefore);
      assert.equal(readFileSync(join(repo.root, "untracked.txt"), "utf8"), untrackedBefore);
      assert.equal(git(repo.root, ["rev-parse", "HEAD"], env), projectHeadBefore);
    } catch (error) {
      failed = true;
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    if (context !== null) {
      try {
        await context.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (server !== null) {
      let agents: ReturnType<typeof collectSpawnedAgents> = [];
      let keep = false;
      try {
        agents = collectSpawnedAgents(dataDir);
      } catch (error) {
        cleanupFailures.push(error);
        keep = true;
      }
      try {
        await shutdownOwned({ server, agents, sentinel, keep, dataDir });
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else if (sentinel.exitCode !== null || sentinel.signalCode !== null) {
      cleanupFailures.push(new Error("unrelated sentinel died during cleanup"));
    } else {
      sentinel.kill("SIGKILL");
    }
    try {
      cleanupTempRoots();
    } catch (error) {
      cleanupFailures.push(error);
    }

    if (failed) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [testFailure, ...cleanupFailures],
          "browser test + cleanup failed",
        );
      }
      throw testFailure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "browser cleanup failed");
    }
  }, 300_000);
});
