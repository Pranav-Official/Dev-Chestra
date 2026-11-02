import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";

import { DevChestraHttp } from "../src/http.js";
import { collectSpawnedAgents } from "../src/store-read.js";
import { registerProject } from "../src/workflow-api.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  tempRoot,
} from "./support/run-workspace-fixtures.js";
import { withServer } from "./support/run-workspace-harness.js";

let preserveRoots = false;

afterEach((context) => {
  const state = (context as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (state !== "pass") preserveRoots = true;
});

afterAll(() => {
  if (preserveRoots) {
    process.stderr.write("gate tester retained owned temp roots after failure\n");
    return;
  }
  cleanupTempRoots();
});

const FAKE_SCRIPT = join(import.meta.dirname, "fixtures/routing/scripts/gate-output.json");

const GATE = {
  id: "route_gate",
  type: "gate",
  name: "Route",
  branches: [
    { id: "a", when: 'start.route = "a"' },
    { id: "b", otherwise: true },
  ],
};

async function runCount(http: DevChestraHttp, projectId: string): Promise<number> {
  const result = await http.api("GET", `/api/runs?project=${encodeURIComponent(projectId)}`);
  assert.equal(result.status, 200, result.text.slice(0, 500));
  return ((result.body as { items?: unknown[] }).items ?? []).length;
}

describe("gate tester", () => {
  it("previews a gate without runs, processes, model calls or store writes", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-preview-");
    const dataDir = tempRoot("devchestra-preview-data-").dir;
    await withServer(
      {
        dataDir,
        projectRoot: ws.root,
        fakeScript: FAKE_SCRIPT,
        env: {
          HOME: ws.home,
          GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const project = await registerProject(http, ws.root);
        const runsBefore = await runCount(http, project.id);
        const agentsBefore = collectSpawnedAgents(dataDir).length;

        const trueResult = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: { gate: GATE, scope: { start: { route: "a" } } },
        });
        assert.equal(trueResult.status, 200, trueResult.text.slice(0, 800));
        assert.deepEqual(trueResult.body, {
          branch: "a",
          evaluated: [{ branch: "a", matched: true }],
        });

        const fallback = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: { gate: GATE, scope: { start: { route: "z" } } },
        });
        assert.equal(fallback.status, 200, fallback.text.slice(0, 800));
        assert.deepEqual(fallback.body, {
          branch: "b",
          evaluated: [
            { branch: "a", matched: false },
            { branch: "b", matched: true },
          ],
        });

        const nonBoolean = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: {
            gate: {
              ...GATE,
              branches: [
                { id: "bad", when: "start.route" },
                { id: "b", otherwise: true },
              ],
            },
            scope: { start: { route: "a" } },
          },
        });
        assert.equal(nonBoolean.status, 200, nonBoolean.text.slice(0, 800));
        const nonBooleanBody = nonBoolean.body as Record<string, unknown>;
        assert.equal(nonBooleanBody.branch, null);
        assert.equal((nonBooleanBody.error as { code?: string }).code, "E_EXPR");
        assert.match(
          String((nonBooleanBody.evaluated as Array<{ error?: string }>)[0]?.error),
          /boolean/u,
        );

        const runtimeError = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: {
            gate: {
              ...GATE,
              branches: [
                { id: "bad", when: '$error("boom")' },
                { id: "b", otherwise: true },
              ],
            },
            scope: { start: { route: "a" } },
          },
        });
        assert.equal(runtimeError.status, 200, runtimeError.text.slice(0, 800));
        assert.equal((runtimeError.body as Record<string, unknown>).branch, null);
        assert.equal(
          ((runtimeError.body as Record<string, unknown>).error as { code?: string }).code,
          "E_EXPR",
        );

        const badGate = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: {
            gate: { ...GATE, branches: [{ id: "a", when: "true" }] },
            scope: {},
          },
        });
        assert.equal(badGate.status, 400, badGate.text.slice(0, 800));

        const oversized = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: { gate: GATE, scope: { blob: "x".repeat(40 * 1024) } },
        });
        assert.equal(oversized.status, 400, oversized.text.slice(0, 800));

        const noCsrf = await http.api("POST", `/api/projects/${project.id}/gates/test`, {
          body: { gate: GATE, scope: {} },
          csrf: false,
        });
        assert.equal(noCsrf.status, 403);

        assert.equal(await runCount(http, project.id), runsBefore, "no run row may be created");
        assert.equal(collectSpawnedAgents(dataDir).length, agentsBefore, "no process may spawn");
      },
    );
  }, 240_000);
});
