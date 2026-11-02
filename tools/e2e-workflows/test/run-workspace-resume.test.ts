import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { CLI, makeWorkspace, scriptPath } from "../src/fixtures.js";
import { DevChestraHttp, errorCode } from "../src/http.js";
import { startSentinel, startServer } from "../src/owned.js";
import { readStoreSnapshot } from "../src/store-read.js";
import { isTerminal, waitTerminal } from "../src/workflow-api.js";
import {
  cleanupTempRoots,
  git,
  isolatedGitEnv,
  makeRunWorkspaceRepo,
  type RunWorkspaceRepo,
} from "./support/run-workspace-fixtures.js";
import {
  cleanupRestarted,
  createManaged,
  cwdsFor,
  dirIdentity,
  execution,
  readEventPage,
  runDetail,
  startRun,
  stdoutOf,
  waitSpawn,
  withServer,
  workflowWithCommit,
  workspaceWorkflow,
} from "./support/run-workspace-harness.js";

function envOf(repo: RunWorkspaceRepo): Record<string, string> {
  return {
    HOME: repo.home,
    GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function expectFailureEvidence(dataDir: string, runId: string): void {
  const snapshot = readStoreSnapshot(dataDir, runId);
  assert.match(JSON.stringify(snapshot.events), /E_(VALIDATION|CONFLICT|WORKSPACE)/u);
  assert.equal(snapshot.view?.status, "failed");
}

async function restartAndResume(
  dataDir: string,
  projectRoot: string,
  env: Record<string, string>,
  runId: string,
  resume: (http: DevChestraHttp) => Promise<void>,
  options: { allowBootFailure?: boolean } = {},
): Promise<void> {
  const sentinel = startSentinel();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let failure: unknown;
  let failed = false;
  try {
    server = await startServer({
      cli: CLI,
      dataDir,
      cwd: projectRoot,
      fakeScript: scriptPath("slow"),
      env,
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const detail = await runDetail(http, runId);
    if (isTerminal(detail.status)) {
      if (options.allowBootFailure !== true) {
        assert.fail(`run became terminal during boot: ${detail.status}`);
      }
    } else {
      await resume(http);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const failures = await cleanupRestarted(server, dataDir, sentinel, { keep: true });
  if (failed) {
    if (failures.length > 0) throw new AggregateError([failure, ...failures], "resume + cleanup");
    throw failure;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "resume cleanup failed");
}

describe("run workspace durability and identity", () => {
  it("keeps the selected cwd across a real server restart and resume, including a workflow commit", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-resume-");
    const env = isolatedGitEnv(repo.home);
    const ws = await makeWorkspace("devchestra-run-ws-resume-work-");
    const projectHeadBefore = git(repo.root, ["rev-parse", "HEAD"], env);
    const existingBefore = dirIdentity(repo.existingWorktree, env);
    let runId = "";
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("slow"),
        env: envOf(repo),
        keepDataDir: true,
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workflowWithCommit());
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag, {
          mode: "existing-worktree",
          path: repo.existingWorktree,
        });
        assert.equal(started.status, 202, started.text.slice(0, 600));
        runId = String(started.body.runId);
        await waitSpawn(http, runId, "agent");
        const first = await execution(http, runId, "first");
        assert.equal(first.execution.status, "succeeded");
        assert.equal(first.process?.cwd, repo.existingWorktree);
        assert.notEqual(git(repo.existingWorktree, ["rev-parse", "HEAD"], env), repo.base);
        await server.stop();
      },
    );

    await restartAndResume(ws.dataDir, repo.root, envOf(repo), runId, async (http) => {
      const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
        body: {},
      });
      assert.equal(resumed.status, 202, `resume: ${resumed.text.slice(0, 800)}`);
      const terminal = await waitTerminal(http, runId, 120_000);
      assert.equal(terminal.status, "succeeded", JSON.stringify(terminal.raw).slice(0, 1400));
      const cwds = await cwdsFor(http, runId);
      assert.deepEqual(new Set(Object.values(cwds)), new Set([repo.existingWorktree]));
      assert.match(stdoutOf(await execution(http, runId, "second")), /shared=shared-v1/u);
      assert.equal(git(repo.root, ["rev-parse", "HEAD"], env), projectHeadBefore);
      assert.equal(readFileSync(join(repo.existingWorktree, "shared.txt"), "utf8"), "shared-v1");
      assert.equal(existsSync(join(repo.root, "shared.txt")), false);
      assert.deepEqual(dirIdentity(repo.existingWorktree, env), existingBefore);
    });
    cleanupTempRoots();
  }, 300_000);

  it("refuses to resume into a different repository placed at the selected worktree path", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-replaced-");
    const env = isolatedGitEnv(repo.home);
    const ws = await makeWorkspace("devchestra-run-ws-replaced-work-");
    const identityBefore = dirIdentity(repo.existingWorktree, env);
    let runId = "";
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("slow"),
        env: envOf(repo),
        keepDataDir: true,
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workflowWithCommit());
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag, {
          mode: "existing-worktree",
          path: repo.existingWorktree,
        });
        assert.equal(started.status, 202, started.text.slice(0, 600));
        runId = String(started.body.runId);
        await waitSpawn(http, runId, "agent");
        await server.stop();
      },
    );

    rmSync(repo.existingWorktree, { recursive: true, force: true });
    mkdirSync(repo.existingWorktree, { recursive: true });
    git(repo.existingWorktree, ["init", "-q"], env);
    git(repo.existingWorktree, ["config", "user.email", "replacement@example.invalid"], env);
    git(repo.existingWorktree, ["config", "user.name", "Replacement"], env);
    writeFileSync(join(repo.existingWorktree, "replacement.txt"), "replacement\n");
    git(repo.existingWorktree, ["add", "."], env);
    git(repo.existingWorktree, ["commit", "-qm", "replacement"], env);
    const identityAfter = dirIdentity(repo.existingWorktree, env);
    assert.notDeepEqual(identityAfter, identityBefore, "replacement must be a distinct directory");

    await restartAndResume(
      ws.dataDir,
      repo.root,
      envOf(repo),
      runId,
      async (http) => {
        const detail = await runDetail(http, runId);
        assert.deepEqual(detail.workspace, {
          mode: "existing-worktree",
          path: repo.existingWorktree,
        });
        const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
          body: {},
        });
        if (resumed.status === 202) {
          const terminal = await waitTerminal(http, runId, 60_000);
          assert.equal(
            terminal.status,
            "failed",
            `replaced worktree must fail the run: ${JSON.stringify(terminal.raw).slice(0, 1000)}`,
          );
        } else {
          assert.equal(resumed.status, 409, resumed.text.slice(0, 600));
          assert.ok(
            ["E_CONFLICT", "E_WORKSPACE"].includes(errorCode(resumed) ?? ""),
            `unexpected code: ${String(errorCode(resumed))}`,
          );
        }
        const page = await readEventPage(http, runId);
        assert.match(
          JSON.stringify(page.events),
          /E_(VALIDATION|CONFLICT|WORKSPACE)/u,
          "identity failure must be recorded",
        );
        assert.equal(
          readFileSync(join(repo.existingWorktree, "replacement.txt"), "utf8"),
          "replacement\n",
        );
        assert.equal(git(repo.existingWorktree, ["status", "--porcelain"], env), "");
        assert.equal(
          existsSync(join(repo.existingWorktree, "shared.txt")),
          false,
          "no workflow command may run in the replacement directory",
        );
      },
      { allowBootFailure: true },
    );
    expectFailureEvidence(ws.dataDir, runId);
    cleanupTempRoots();
  }, 300_000);

  it("fails closed when the durable run workspace binding is missing during resume", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-nobind-");
    const ws = await makeWorkspace("devchestra-run-ws-nobind-work-");
    let runId = "";
    let projectId = "";
    let binding = "";
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("slow"),
        env: envOf(repo),
        keepDataDir: true,
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workspaceWorkflow("scratch"));
        projectId = managed.projectId;
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
        assert.equal(started.status, 202, started.text.slice(0, 600));
        runId = String(started.body.runId);
        await waitSpawn(http, runId, "agent");
        binding = join(ws.dataDir, "projects", projectId, "runs", runId, "run-workspace.json");
        assert.equal(existsSync(binding), true, "durable run binding must exist");
        await server.stop();
      },
    );

    rmSync(binding, { force: true });
    assert.equal(existsSync(binding), false);
    await restartAndResume(
      ws.dataDir,
      repo.root,
      envOf(repo),
      runId,
      async (http) => {
        const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
          body: {},
        });
        if (resumed.status === 202) {
          const terminal = await waitTerminal(http, runId, 60_000);
          assert.equal(
            terminal.status,
            "failed",
            `missing binding must fail: ${JSON.stringify(terminal.raw).slice(0, 1000)}`,
          );
        } else {
          assert.equal(resumed.status, 409, resumed.text.slice(0, 600));
          assert.equal(errorCode(resumed), "E_WORKSPACE");
        }
        const page = await readEventPage(http, runId);
        assert.match(JSON.stringify(page.events), /E_WORKSPACE/u);
        assert.equal(existsSync(binding), false, "resume must not recreate a missing binding");
        const detail = await runDetail(http, runId);
        assert.deepEqual(detail.workspace, { mode: "project" });
      },
      { allowBootFailure: true },
    );
    expectFailureEvidence(ws.dataDir, runId);
    cleanupTempRoots();
  }, 240_000);

  it("fails closed when the project repository is replaced at the frozen root path", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-root-replaced-");
    const env = isolatedGitEnv(repo.home);
    const ws = await makeWorkspace("devchestra-run-ws-root-replaced-work-");
    let runId = "";
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("slow"),
        env: envOf(repo),
        keepDataDir: true,
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workspaceWorkflow("scratch"));
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
        assert.equal(started.status, 202, started.text.slice(0, 600));
        runId = String(started.body.runId);
        await waitSpawn(http, runId, "agent");
        await server.stop();
      },
    );

    const moved = `${repo.root}.moved`;
    renameSync(repo.root, moved);
    mkdirSync(repo.root, { recursive: true });
    git(repo.root, ["init", "-q"], env);
    git(repo.root, ["config", "user.email", "root-replacement@example.invalid"], env);
    git(repo.root, ["config", "user.name", "Root Replacement"], env);
    writeFileSync(join(repo.root, "replacement.txt"), "replacement\n");
    git(repo.root, ["add", "."], env);
    git(repo.root, ["commit", "-qm", "replacement"], env);

    await restartAndResume(
      ws.dataDir,
      repo.root,
      envOf(repo),
      runId,
      async (http) => {
        const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
          body: {},
        });
        if (resumed.status === 202) {
          const terminal = await waitTerminal(http, runId, 60_000);
          assert.equal(
            terminal.status,
            "failed",
            `replaced root must fail: ${JSON.stringify(terminal.raw).slice(0, 1000)}`,
          );
        } else {
          assert.equal(resumed.status, 409, resumed.text.slice(0, 600));
          assert.ok(
            ["E_CONFLICT", "E_WORKSPACE"].includes(errorCode(resumed) ?? ""),
            `unexpected code: ${String(errorCode(resumed))}`,
          );
        }
        const page = await readEventPage(http, runId);
        assert.match(JSON.stringify(page.events), /E_(VALIDATION|CONFLICT|WORKSPACE)/u);
        assert.equal(existsSync(join(repo.root, "shared.txt")), false);
        assert.equal(git(repo.root, ["status", "--porcelain"], env), "");
      },
      { allowBootFailure: true },
    );
    expectFailureEvidence(ws.dataDir, runId);
    cleanupTempRoots();
  }, 240_000);

  it("rejects a tampered frozen binding instead of running with it", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-run-ws-tamper-");
    const ws = await makeWorkspace("devchestra-run-ws-tamper-work-");
    let runId = "";
    let binding = "";
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("slow"),
        env: envOf(repo),
        keepDataDir: true,
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workspaceWorkflow("scratch"));
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
        assert.equal(started.status, 202, started.text.slice(0, 600));
        runId = String(started.body.runId);
        await waitSpawn(http, runId, "agent");
        binding = join(
          ws.dataDir,
          "projects",
          managed.projectId,
          "runs",
          runId,
          "run-workspace.json",
        );
        await server.stop();
      },
    );

    const stored = JSON.parse(readFileSync(binding, "utf8")) as Record<string, unknown>;
    stored.dirId = "0:0";
    writeFileSync(binding, `${JSON.stringify(stored)}\n`);
    await restartAndResume(
      ws.dataDir,
      repo.root,
      envOf(repo),
      runId,
      async (http) => {
        const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
          body: {},
        });
        if (resumed.status === 202) {
          const terminal = await waitTerminal(http, runId, 60_000);
          assert.equal(
            terminal.status,
            "failed",
            `tampered binding must fail: ${JSON.stringify(terminal.raw).slice(0, 1000)}`,
          );
        } else {
          assert.equal(resumed.status, 409, resumed.text.slice(0, 600));
          assert.equal(errorCode(resumed), "E_CONFLICT");
        }
        const page = await readEventPage(http, runId);
        assert.match(JSON.stringify(page.events), /E_CONFLICT/u);
        assert.equal(JSON.parse(readFileSync(binding, "utf8")).dirId, "0:0");
      },
      { allowBootFailure: true },
    );
    expectFailureEvidence(ws.dataDir, runId);
    cleanupTempRoots();
  }, 240_000);
});
