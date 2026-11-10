import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { makeWorkspace, scriptPath } from "../src/fixtures.js";
import { DevChestraHttp } from "../src/http.js";
import type { WorkflowFileLike } from "../src/workflow-api.js";
import { cleanupTempRoots, makeRunWorkspaceRepo } from "./support/run-workspace-fixtures.js";
import {
  createManaged,
  execution,
  runDetail,
  startRun,
  stdoutOf,
  waitTerminal,
  withServer,
} from "./support/run-workspace-harness.js";

afterAll(cleanupTempRoots);
describe.skipIf(process.env.DEVCHESTRA_TEST_CONTAINER !== "1")(
  "container workspace HTTP acceptance",
  () => {
    it("runs shell nodes against one clone and returns a branch without changing the host checkout", async () => {
      const repo = makeRunWorkspaceRepo("dc-container-http-");
      const ws = await makeWorkspace("dc-container-http-data-");
      const workflow: WorkflowFileLike = {
        schemaVersion: 1,
        id: "run-workspace",
        name: "Container acceptance",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            {
              id: "first",
              type: "shell",
              name: "Write",
              command:
                "printf 'container-result' > tracked.txt; git add tracked.txt; git -c commit.gpgsign=false commit -m result; printf '%s' \"$PWD\"",
              timeoutMin: 1,
            },
            {
              id: "second",
              type: "shell",
              name: "Read",
              command: "cat tracked.txt; printf ' HOME=%s' \"$HOME\"",
              timeoutMin: 1,
            },
            { id: "end", type: "end", name: "End", status: "success", result: "{}" },
          ],
          edges: [
            { id: "one", from: "start", to: "first" },
            { id: "two", from: "first", to: "second" },
            { id: "three", from: "second", to: "end" },
          ],
        },
      };
      await withServer(
        { dataDir: ws.dataDir, projectRoot: repo.root, fakeScript: scriptPath("summary"), env: {} },
        async (server) => {
          const http = new DevChestraHttp(server.baseUrl);
          await http.health();
          await http.bootstrap(server.meta.token);
          const managed = await createManaged(http, repo.root, workflow);
          const started = await startRun(
            http,
            managed.projectId,
            managed.workflowId,
            managed.etag,
            { mode: "container" },
          );
          assert.equal(started.status, 202, started.text);
          const id = String(started.body.runId);
          const terminal = await waitTerminal(http, id);
          assert.equal(terminal.status, "succeeded", JSON.stringify(terminal.raw).slice(0, 3000));
          assert.deepEqual((await runDetail(http, id)).workspace, { mode: "container" });
          const first = await execution(http, id, "first");
          const second = await execution(http, id, "second");
          assert.equal(first.process?.cwd, second.process?.cwd);
          assert.notEqual(first.process?.cwd, repo.root);
          assert.match(stdoutOf(second), /container-result HOME=\/home\/devchestra/);
          assert.equal(readFileSync(join(repo.root, "tracked.txt"), "utf8"), "base\n");
        },
      );
    }, 120_000);
  },
);
