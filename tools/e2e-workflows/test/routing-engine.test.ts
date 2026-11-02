import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import { CLI } from "../src/fixtures.js";
import { DevChestraHttp } from "../src/http.js";
import { startSentinel, startServer } from "../src/owned.js";
import {
  createWorkflow,
  getWorkflow,
  registerProject,
  saveWorkflow,
  type WorkflowFileLike,
} from "../src/workflow-api.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  tempRoot,
} from "./support/run-workspace-fixtures.js";
import {
  cleanupRestarted,
  type EventPageLike,
  execution,
  readEventPage,
  runDetail,
  startRun,
  waitSpawn,
  waitTerminal,
  withServer,
} from "./support/run-workspace-harness.js";

let preserveRoots = false;

afterEach((context) => {
  const state = (context as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (state !== "pass") preserveRoots = true;
});

afterAll(() => {
  if (preserveRoots) {
    process.stderr.write("routing acceptance retained owned temp roots after failure\n");
    return;
  }
  cleanupTempRoots();
});

const FIXTURES = join(import.meta.dirname, "fixtures/routing/workflows");
const SCRIPTS = join(import.meta.dirname, "fixtures/routing/scripts");
const FAKE_SCRIPT = join(SCRIPTS, "gate-output.json");
const SLOW_SCRIPT = join(SCRIPTS, "gate-slow.json");

function fixture(name: string): WorkflowFileLike {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as WorkflowFileLike;
}

interface Managed {
  projectId: string;
  workflowId: string;
  etag: string;
}

async function manage(http: DevChestraHttp, projectRoot: string, name: string): Promise<Managed> {
  const file = fixture(name);
  const project = await registerProject(http, projectRoot);
  await createWorkflow(http, project.id, { name: file.name, id: file.id, template: "blank" });
  const blank = await getWorkflow(http, project.id, file.id);
  const saved = await saveWorkflow(http, project.id, file.id, file, blank.etag);
  assert.ok(
    saved.validation.ok,
    `${name} must validate: ${JSON.stringify(saved.validation).slice(0, 1200)}`,
  );
  return { projectId: project.id, workflowId: saved.id, etag: saved.etag };
}

async function startWith(
  http: DevChestraHttp,
  managed: Managed,
  params?: Record<string, unknown>,
  workspace?: unknown,
) {
  const body: Record<string, unknown> = { etag: managed.etag };
  if (params !== undefined) body.params = params;
  if (workspace !== undefined) body.workspace = workspace;
  const result = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(managed.projectId)}/workflows/${encodeURIComponent(managed.workflowId)}/runs`,
    { body },
  );
  return {
    status: result.status,
    text: result.text,
    body: (result.body ?? {}) as Record<string, unknown>,
  };
}

function eventsOfType(page: EventPageLike, type: string): EventPageLike["events"] {
  return page.events.filter((event) => event.type === type);
}

function spawnedPaths(page: EventPageLike): string[] {
  return eventsOfType(page, "node.process.spawned").map((event) => event.path);
}

function decided(page: EventPageLike): Record<string, unknown> {
  const events = eventsOfType(page, "gate.decided");
  assert.equal(events.length, 1, "exactly one gate.decided");
  return events[0]?.payload as Record<string, unknown>;
}

function resolved(page: EventPageLike): Record<string, unknown> {
  const events = eventsOfType(page, "join.resolved");
  assert.equal(events.length, 1, "exactly one join.resolved");
  return events[0]?.payload as Record<string, unknown>;
}

async function statusOf(http: DevChestraHttp, runId: string, path: string): Promise<string> {
  const result = await http.api(
    "GET",
    `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(path)}`,
  );
  if (result.status === 404) return "missing";
  assert.equal(result.status, 200, result.text.slice(0, 500));
  return String(
    (result.body as { execution?: { status?: string } }).execution?.status ?? "missing",
  );
}

describe("routing engine over real HTTP + fake agent", () => {
  it("routes gate true/otherwise and join first without spawning the dead branch", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-first-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-first-data-").dir,
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
        const managed = await manage(http, ws.root, "gate-join-first");

        for (const [route, active, dead] of [
          ["a", "agent_a", "agent_b"],
          ["b", "agent_b", "agent_a"],
        ] as const) {
          const started = await startWith(http, managed, { route });
          assert.equal(started.status, 202, started.text.slice(0, 800));
          const runId = String(started.body.runId);
          const terminal = await waitTerminal(http, runId);
          assert.equal(terminal.status, "succeeded", JSON.stringify(terminal.raw).slice(0, 1600));

          const page = await readEventPage(http, runId);
          const decision = decided(page);
          assert.equal(decision.branch, route === "a" ? "a" : "b");
          assert.ok(Array.isArray(decision.evaluated));
          const join = resolved(page);
          assert.equal(join.mode, "first");
          assert.deepEqual(join.active, [route === "a" ? "a" : "b"]);
          assert.deepEqual(join.skipped, [route === "a" ? "b" : "a"]);
          assert.equal(await statusOf(http, runId, "route_gate"), "succeeded");
          assert.equal(await statusOf(http, runId, active), "succeeded");
          assert.equal(await statusOf(http, runId, dead), "skipped");
          assert.equal(await statusOf(http, runId, "merge"), "succeeded");
          assert.equal(spawnedPaths(page).includes(dead), false, `${dead} must not spawn`);
          assert.equal(spawnedPaths(page).includes(active), true, `${active} must spawn`);
          assert.equal((await execution(http, runId, active)).output?.data?.verdict, "ok");
          const gateOutput = (await execution(http, runId, "route_gate")).output?.data;
          assert.deepEqual(gateOutput, { branch: route === "a" ? "a" : "b" });
        }
      },
    );
  }, 240_000);

  it("maps a dead join-all input to null and skips every dead descendant", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-dead-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-dead-data-").dir,
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

        const all = await manage(http, ws.root, "gate-join-all");
        const allRun = await startWith(http, all, { route: "b" });
        assert.equal(allRun.status, 202, allRun.text.slice(0, 800));
        const allId = String(allRun.body.runId);
        assert.equal((await waitTerminal(http, allId)).status, "succeeded");
        assert.equal(await statusOf(http, allId, "agent_a"), "skipped");
        assert.equal(await statusOf(http, allId, "agent_b"), "succeeded");
        assert.deepEqual((await execution(http, allId, "merge")).output?.data, {
          a: null,
          b: { verdict: "ok", note: "routing" },
        });

        const dead = await manage(http, ws.root, "dead-descendants");
        const deadRun = await startWith(http, dead, { route: "b" });
        assert.equal(deadRun.status, 202, deadRun.text.slice(0, 800));
        const deadId = String(deadRun.body.runId);
        assert.equal((await waitTerminal(http, deadId)).status, "succeeded");
        const page = await readEventPage(http, deadId);
        for (const path of ["agent_a", "agent_leaf"]) {
          assert.equal(await statusOf(http, deadId, path), "skipped", `${path} skipped`);
          assert.equal(spawnedPaths(page).includes(path), false, `${path} must not spawn`);
          assert.equal(
            eventsOfType(page, "node.session.captured").some((event) => event.path === path),
            false,
            `${path} must not capture a session`,
          );
        }
        assert.equal(await statusOf(http, deadId, "agent_b"), "succeeded");
        assert.deepEqual((await execution(http, deadId, "merge")).output?.data, {
          a: null,
          b: { verdict: "ok", note: "routing" },
        });
      },
    );
  }, 240_000);

  it("durably skips a join with zero active inputs and still reaches the exclusive end", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-zero-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-zero-data-").dir,
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
        const managed = await manage(http, ws.root, "join-all-zero-active");
        const started = await startWith(http, managed, { route: "c" });
        assert.equal(started.status, 202, started.text.slice(0, 800));
        const runId = String(started.body.runId);
        assert.equal((await waitTerminal(http, runId)).status, "succeeded");
        const page = await readEventPage(http, runId);
        assert.equal(
          eventsOfType(page, "join.resolved").length,
          0,
          "zero-active join is not resolved",
        );
        assert.equal(await statusOf(http, runId, "merge"), "skipped");
        assert.equal(await statusOf(http, runId, "done_merge"), "skipped");
        assert.equal(await statusOf(http, runId, "done_direct"), "succeeded");
        for (const path of ["agent_a", "agent_b"]) {
          assert.equal(await statusOf(http, runId, path), "skipped");
          assert.equal(spawnedPaths(page).includes(path), false);
        }
      },
    );
  }, 240_000);

  it("keeps siblings out of scope and uses true ancestors only", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-scope-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-scope-data-").dir,
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
        const managed = await manage(http, ws.root, "sibling-scope");
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
        assert.equal(started.status, 202, started.text.slice(0, 800));
        const runId = String(started.body.runId);
        assert.equal((await waitTerminal(http, runId)).status, "succeeded");
        const page = await readEventPage(http, runId);
        const inputs = new Map<string, Record<string, unknown>>();
        for (const event of eventsOfType(page, "node.input.resolved")) {
          const payload = event.payload as {
            inputs?: { scope?: Record<string, unknown> };
          };
          assert.ok(payload.inputs?.scope !== undefined, "resolved scope must be recorded");
          inputs.set(event.path, payload.inputs.scope);
        }
        const left = inputs.get("agent_left");
        const right = inputs.get("agent_right");
        assert.ok(left !== undefined && right !== undefined);
        assert.equal(Object.hasOwn(left, "agent_right"), false, "left must not see sibling right");
        assert.equal(Object.hasOwn(right, "agent_left"), false, "right must not see sibling left");
        assert.equal(Object.hasOwn(left, "start"), true, "left sees start ancestor");
        assert.equal(Object.hasOwn(right, "start"), true, "right sees start ancestor");
      },
    );
  }, 240_000);

  it("supports exclusive multiple ends and rejects two active ends", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-ends-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-ends-data-").dir,
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

        const exclusive = await manage(http, ws.root, "gate-multiple-ends");
        const run = await startWith(http, exclusive, { route: "ok" });
        assert.equal(run.status, 202, run.text.slice(0, 800));
        const runId = String(run.body.runId);
        assert.equal((await waitTerminal(http, runId)).status, "succeeded");
        assert.equal(await statusOf(http, runId, "end_ok"), "succeeded");
        assert.equal(await statusOf(http, runId, "end_bad"), "skipped");

        const conflict = await manage(http, ws.root, "multiple-ends-conflict");
        const bad = await startRun(http, conflict.projectId, conflict.workflowId, conflict.etag);
        assert.equal(bad.status, 202, bad.text.slice(0, 800));
        const badId = String(bad.body.runId);
        const terminal = await waitTerminal(http, badId);
        assert.equal(terminal.status, "failed");
        const page = await readEventPage(http, badId);
        assert.match(
          JSON.stringify(page.events),
          /multiple active End|E_WORKFLOW_INVALID/u,
          "active-end conflict must be explicit",
        );
        assert.notEqual(await statusOf(http, badId, "end_a"), "succeeded");
        assert.notEqual(await statusOf(http, badId, "end_b"), "succeeded");
      },
    );
  }, 240_000);

  it("fails a join-first conflict instead of choosing one active input", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-conflict-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-conflict-data-").dir,
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
        const managed = await manage(http, ws.root, "join-conflict");
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
        assert.equal(started.status, 202, started.text.slice(0, 800));
        const runId = String(started.body.runId);
        const terminal = await waitTerminal(http, runId);
        assert.equal(terminal.status, "failed");
        const page = await readEventPage(http, runId);
        assert.match(JSON.stringify(page.events), /E_JOIN_CONFLICT/u);
        assert.notEqual(await statusOf(http, runId, "merge"), "succeeded");
        assert.notEqual(await statusOf(http, runId, "done"), "succeeded");
      },
    );
  }, 240_000);

  it("fails the gate and run on a non-boolean or broken predicate without falling through", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-badgate-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-badgate-data-").dir,
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
        for (const name of ["gate-invalid-type", "gate-invalid-expr"]) {
          const managed = await manage(http, ws.root, name);
          const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag);
          assert.equal(started.status, 202, started.text.slice(0, 800));
          const runId = String(started.body.runId);
          const terminal = await waitTerminal(http, runId);
          assert.equal(terminal.status, "failed", name);
          const page = await readEventPage(http, runId);
          assert.match(JSON.stringify(page.events), /E_EXPR/u, name);
          const decision = decided(page);
          assert.equal(decision.branch, null, name);
          assert.equal(
            (decision.evaluated as Array<{ error?: string }>)[0]?.error !== undefined,
            true,
            name,
          );
          assert.equal(await statusOf(http, runId, "route_gate"), "failed", name);
          for (const path of ["agent_a", "agent_b", "merge", "done"]) {
            assert.ok(
              ["skipped", "pending", "cancelled", "missing"].includes(
                await statusOf(http, runId, path),
              ),
              `${name}:${path}`,
            );
          }
          assert.deepEqual(spawnedPaths(page), [], `${name}: no agent may spawn`);
        }
      },
    );
  }, 240_000);

  it("uses one chosen run workspace for every active branch", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-ws-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-ws-data-").dir,
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
        const managed = await manage(http, ws.root, "sibling-scope");
        const started = await startRun(http, managed.projectId, managed.workflowId, managed.etag, {
          mode: "project",
        });
        assert.equal(started.status, 202, started.text.slice(0, 800));
        const runId = String(started.body.runId);
        assert.equal((await waitTerminal(http, runId)).status, "succeeded");
        const left = await execution(http, runId, "agent_left");
        const right = await execution(http, runId, "agent_right");
        assert.ok(left.process !== null && right.process !== null);
        assert.equal(left.process.cwd, realpathSync(ws.root));
        assert.equal(right.process.cwd, realpathSync(ws.root));
        assert.deepEqual((await runDetail(http, runId)).workspace, { mode: "project" });
      },
    );
  }, 240_000);
});

function raiseCleanup(failure: unknown, failures: unknown[], label: string): void {
  if (failure !== undefined && failures.length > 0) {
    throw new AggregateError([failure, ...failures], `${label} cleanup`);
  }
  if (failure !== undefined) throw failure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup`);
}

describe("routing crash and restart", () => {
  it("retains the chosen branch and never spawns the dead branch after restart", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-crash-");
    const dataDir = tempRoot("devchestra-crash-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let runId = "";
    let managed: Managed | null = null;

    const sentinel = startSentinel();
    let first: Awaited<ReturnType<typeof startServer>> | null = null;
    let firstFailure: unknown;
    try {
      first = await startServer({
        cli: CLI,
        dataDir,
        cwd: ws.root,
        fakeScript: SLOW_SCRIPT,
        env,
      });
      const http = new DevChestraHttp(first.baseUrl);
      await http.health();
      await http.bootstrap(first.meta.token);
      managed = await manage(http, ws.root, "gate-slow");
      const started = await startWith(http, managed, { route: "slow" }, { mode: "project" });
      assert.equal(started.status, 202, started.text.slice(0, 800));
      runId = String(started.body.runId);
      await waitSpawn(http, runId, "agent_slow");
      assert.ok(
        ["pending", "skipped"].includes(
          (await execution(http, runId, "agent_fast")).execution.status,
        ),
        "inactive branch may be pending or durably skipped before the kill; it must not run",
      );
      await first.stop();
    } catch (error) {
      firstFailure = error;
    }
    const firstCleanup = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(firstFailure, firstCleanup, "first crash");
    assert.ok(managed !== null);

    const restartedSentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let failure: unknown;
    try {
      second = await startServer({
        cli: CLI,
        dataDir,
        cwd: ws.root,
        fakeScript: SLOW_SCRIPT,
        env,
      });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      const resumed = await http.api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
        body: {},
      });
      assert.equal(resumed.status, 202, resumed.text.slice(0, 800));
      const terminal = await waitTerminal(http, runId, 120_000);
      assert.equal(terminal.status, "succeeded", JSON.stringify(terminal.raw).slice(0, 1600));

      const page = await readEventPage(http, runId);
      assert.equal(decided(page).branch, "slow");
      assert.deepEqual((await execution(http, runId, "route_gate")).output?.data, {
        branch: "slow",
      });
      assert.equal(await statusOf(http, runId, "agent_slow"), "succeeded");
      assert.equal(await statusOf(http, runId, "agent_fast"), "skipped");
      assert.deepEqual(resolved(page).active, ["slow"]);
      assert.deepEqual(resolved(page).skipped, ["fast"]);
      assert.equal(spawnedPaths(page).includes("agent_fast"), false);
      assert.equal(spawnedPaths(page).includes("agent_slow"), true);
      assert.ok(
        (await execution(http, runId, "agent_slow")).output?.data !== null,
        "chosen output survives restart",
      );
    } catch (error) {
      failure = error;
    }
    const cleanup = await cleanupRestarted(second, dataDir, restartedSentinel, { keep: false });
    raiseCleanup(failure, cleanup, "resume");
    cleanupTempRoots();
  }, 300_000);
});
