import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { makeWorkspace, scriptPath } from "../src/fixtures.js";
import { errorCode, RelayHttp } from "../src/http.js";
import { registerProject, waitTerminal } from "../src/workflow-api.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  type RunWorkspaceRepo,
  tempRoot,
} from "./support/run-workspace-fixtures.js";
import {
  createManaged,
  cwdsFor,
  execution,
  runDetail,
  startRun,
  stdoutOf,
  withServer,
  workspaceWorkflow,
} from "./support/run-workspace-harness.js";

let repo: RunWorkspaceRepo;
let rogueDir = "";

beforeAll(() => {
  repo = makeRunWorkspaceRepo("relay-run-ws-");
  rogueDir = tempRoot("relay-run-ws-rogue-").dir;
});

afterAll(() => {
  cleanupTempRoots();
});

function envOf(): Record<string, string> {
  return {
    HOME: repo.home,
    GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function runCount(http: RelayHttp, projectId: string): Promise<number> {
  const result = await http.api("GET", `/api/runs?project=${encodeURIComponent(projectId)}`);
  assert.equal(result.status, 200);
  return ((result.body as { items?: unknown[] }).items ?? []).length;
}

describe("run-level workspace selection", () => {
  it("defaults to the dirty project root, accepts one listed worktree and creates a new one", async () => {
    const ws = await makeWorkspace("relay-run-ws-http-");
    await withServer(
      {
        dataDir: ws.dataDir,
        projectRoot: repo.root,
        fakeScript: scriptPath("summary"),
        env: envOf(),
      },
      async (server) => {
        const http = new RelayHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, workspaceWorkflow("scratch"));

        const catalog = await http.api(
          "GET",
          `/api/projects/${encodeURIComponent(managed.projectId)}/workspaces`,
        );
        assert.equal(catalog.status, 200, `GET workspaces: ${catalog.text.slice(0, 600)}`);
        const catalogBody = catalog.body as {
          projectRoot: string;
          git: boolean;
          worktrees: Array<{
            path: string;
            branch: string | null;
            head: string;
            detached: boolean;
          }>;
        };
        assert.equal(catalogBody.git, true);
        assert.equal(catalogBody.projectRoot, realpathSync(repo.root));
        assert.deepEqual(catalogBody.worktrees, [
          {
            path: repo.existingWorktree,
            branch: repo.existingBranch,
            head: repo.base,
            detached: false,
          },
        ]);
        assert.ok(!catalogBody.worktrees.some((entry) => entry.path === catalogBody.projectRoot));

        const folder = await makeWorkspace("relay-run-ws-folder-");
        const folderProject = await registerProject(http, folder.projectDir);
        const folderCatalog = await http.api(
          "GET",
          `/api/projects/${encodeURIComponent(folderProject.id)}/workspaces`,
        );
        assert.equal(folderCatalog.status, 200);
        assert.deepEqual(folderCatalog.body, {
          projectRoot: realpathSync(folder.projectDir),
          worktrees: [],
          git: false,
        });

        const baseline = await runCount(http, managed.projectId);
        const projectRun = await startRun(
          http,
          managed.projectId,
          managed.workflowId,
          managed.etag,
        );
        assert.equal(projectRun.status, 202, `project run: ${projectRun.text.slice(0, 800)}`);
        const projectId = String(projectRun.body.runId);
        const projectTerminal = await waitTerminal(http, projectId);
        assert.equal(
          projectTerminal.status,
          "succeeded",
          JSON.stringify(projectTerminal.raw).slice(0, 1200),
        );
        const projectDetail = await runDetail(http, projectId);
        assert.deepEqual(projectDetail.workspace, { mode: "project" });
        const projectCwds = await cwdsFor(http, projectId);
        assert.equal(new Set(Object.values(projectCwds)).size, 1, "all nodes share one cwd");
        assert.equal(projectCwds.first, realpathSync(repo.root));
        const projectFirst = stdoutOf(await execution(http, projectId, "first"));
        assert.match(projectFirst, /dirty=dirty-local/u);
        assert.match(projectFirst, /untracked=present/u);
        assert.match(stdoutOf(await execution(http, projectId, "second")), /shared=shared-value/u);
        assert.equal(readFileSync(join(repo.root, "shared.txt"), "utf8"), "shared-value");

        const existingRun = await startRun(
          http,
          managed.projectId,
          managed.workflowId,
          managed.etag,
          { mode: "existing-worktree", path: repo.existingWorktree },
        );
        assert.equal(existingRun.status, 202, `existing run: ${existingRun.text.slice(0, 800)}`);
        const existingId = String(existingRun.body.runId);
        const existingTerminal = await waitTerminal(http, existingId);
        assert.equal(existingTerminal.status, "succeeded");
        const existingDetail = await runDetail(http, existingId);
        assert.deepEqual(existingDetail.workspace, {
          mode: "existing-worktree",
          path: repo.existingWorktree,
        });
        const existingCwds = await cwdsFor(http, existingId);
        assert.equal(new Set(Object.values(existingCwds)).size, 1);
        assert.equal(existingCwds.agent, repo.existingWorktree);
        const existingFirst = stdoutOf(await execution(http, existingId, "first"));
        assert.match(existingFirst, /dirty=committed/u);
        assert.match(existingFirst, /untracked=absent/u);
        assert.match(stdoutOf(await execution(http, existingId, "second")), /shared=shared-value/u);
        assert.equal(
          readFileSync(join(repo.existingWorktree, "shared.txt"), "utf8"),
          "shared-value",
        );

        const newRun = await startRun(http, managed.projectId, managed.workflowId, managed.etag, {
          mode: "new-worktree",
        });
        assert.equal(newRun.status, 202, `new run: ${newRun.text.slice(0, 800)}`);
        const newId = String(newRun.body.runId);
        const newTerminal = await waitTerminal(http, newId);
        assert.equal(newTerminal.status, "succeeded");
        const newDetail = await runDetail(http, newId);
        assert.deepEqual(newDetail.workspace, { mode: "new-worktree" });
        const newCwds = await cwdsFor(http, newId);
        assert.equal(new Set(Object.values(newCwds)).size, 1);
        const newDir = newCwds.first;
        assert.ok(newDir !== undefined, "new worktree cwd missing");
        assert.ok(newDir.startsWith(ws.dataDir), "new worktree must live under the data dir");
        assert.equal(newDir.startsWith(repo.root), false);
        const newFirst = stdoutOf(await execution(http, newId, "first"));
        assert.match(newFirst, /dirty=committed/u);
        assert.match(newFirst, /untracked=absent/u);
        assert.match(stdoutOf(await execution(http, newId, "second")), /shared=shared-value/u);

        const invalid = await startRun(http, managed.projectId, managed.workflowId, managed.etag, {
          mode: "existing-worktree",
          path: rogueDir,
        });
        assert.equal(invalid.status, 400, `unlisted path: ${invalid.text.slice(0, 600)}`);
        assert.equal(errorCode(invalid.result), "E_VALIDATION");
        assert.equal(await runCount(http, managed.projectId), baseline + 3);

        const key = "run-workspace-idempotent";
        const firstStart = await startRun(
          http,
          managed.projectId,
          managed.workflowId,
          managed.etag,
          { mode: "project" },
          key,
        );
        assert.equal(firstStart.status, 202);
        const sameStart = await startRun(
          http,
          managed.projectId,
          managed.workflowId,
          managed.etag,
          { mode: "project" },
          key,
        );
        assert.equal(sameStart.status, 202);
        assert.equal(sameStart.body.duplicate, true);
        assert.equal(sameStart.body.runId, firstStart.body.runId);
        const changed = await startRun(
          http,
          managed.projectId,
          managed.workflowId,
          managed.etag,
          { mode: "new-worktree" },
          key,
        );
        assert.equal(changed.status, 409, `different selection: ${changed.text.slice(0, 600)}`);
        assert.equal(errorCode(changed.result), "E_CONFLICT");
        assert.equal(await runCount(http, managed.projectId), baseline + 4);
      },
    );
  }, 240_000);
});
