import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, makeWorkspace, REPO_ROOT } from "./fixtures.js";
import { DevChestraHttp, type HttpResult, objectBody } from "./http.js";
import { installModelStandins, type ModelStandin } from "./model-standin.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";
import { registerProject } from "./workflow-api.js";

export interface ClaudeHttpEvidence {
  projectId: string;
  coldUnavailable: boolean;
  coldNoSpawn: boolean;
  queryRejected: number;
  bodyRejected: number;
  missingCsrfRejected: number;
  oneChildPerRefresh: boolean;
  readyStatus: string;
  source: string;
  cliVersion: string | null;
  dynamicIds: string[];
  changedOnSecondRefresh: boolean;
  exactValueNotResolved: boolean;
  framesInitializeOnly: boolean;
  noUserFrame: boolean;
  neutralCwd: boolean;
  dataDirScope: boolean;
  contextPreserved: boolean;
  cacheHitNoSpawn: boolean;
  contextInvalidated: boolean;
  singleFlightOneChild: boolean;
  staleKeepsItems: boolean;
  cooldownNoStampede: boolean;
  timeoutBoundedMs: number;
  timeoutStatus: string;
  truncated: boolean;
  apiClientReady: boolean;
  safeMessages: boolean;
  sentinelsUnchanged: boolean;
}

const COLD_MESSAGE = "No model catalog is cached yet. Refresh models to load it.";
const CLAUDE_SOURCE = "claude-sdk";

function catalogOf(result: HttpResult, label: string): Record<string, unknown> {
  return objectBody(result, label);
}

function idsOf(body: Record<string, unknown>): string[] {
  const items = body.items;
  assert.ok(Array.isArray(items), "catalog items must be an array");
  return items.map((item) => {
    assert.equal(typeof item, "object");
    const id = (item as Record<string, unknown>).id;
    assert.equal(typeof id, "string");
    return id as string;
  });
}

function assertBase(body: Record<string, unknown>, projectId: string): void {
  assert.equal(body.cli, "claude-code");
  assert.equal(body.projectId, projectId);
  assert.equal(body.scope, "devchestra-runtime");
  assert.equal(body.customSupported, true);
  assert.equal(typeof body.truncated, "boolean");
  assert.ok(body.cliVersion === null || typeof body.cliVersion === "string");
  assert.ok(Array.isArray(body.items));
}

function forbiddenFrame(frame: Record<string, unknown>): boolean {
  const type = frame.type;
  const subtype = (frame.request as Record<string, unknown> | undefined)?.subtype;
  return type !== "control_request" || subtype !== "initialize";
}

async function liveDiscoveryPids(standin: ModelStandin): Promise<number[]> {
  const spawns = await standin.discoverySpawns("claude");
  const alive: number[] = [];
  for (const spawn of spawns) {
    try {
      process.kill(spawn.pid, 0);
      alive.push(spawn.pid);
    } catch {
      // Already gone.
    }
  }
  return alive;
}

export async function runClaudeHttpScenario(): Promise<ClaudeHttpEvidence> {
  const ws = await makeWorkspace("devchestra-claude-http-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let standin: ModelStandin | null = null;
  try {
    standin = await installModelStandins(ws.root);
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      env: standin.env,
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);
    // Bootstrap readiness probes precede the model API actions measured here.
    await standin.resetLog();
    const base = `/api/projects/${encodeURIComponent(project.id)}/clis`;

    const cold = await http.api("GET", `${base}/claude-code/models`);
    assert.equal(cold.status, 200, cold.text.slice(0, 400));
    const coldBody = catalogOf(cold, "cold claude");
    assertBase(coldBody, project.id);
    assert.equal(coldBody.status, "unavailable");
    assert.equal(coldBody.source, "none");
    assert.deepEqual(coldBody.items, []);
    assert.equal(coldBody.fetchedAt, null);
    assert.equal(coldBody.expiresAt, null);
    assert.equal(coldBody.truncated, false);
    assert.equal(coldBody.cliVersion, null);
    assert.equal(coldBody.message, COLD_MESSAGE);
    const coldNoSpawn = (await standin.spawns("claude")).length === 0;

    const query = await http.api("GET", `${base}/claude-code/models?limit=1`);
    const bodyPost = await http.api("POST", `${base}/claude-code/models/refresh`, {
      body: { x: 1 },
    });
    const missingCsrf = await http.api("POST", `${base}/claude-code/models/refresh`, {
      csrf: false,
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(query.status, 400, "query strings must be rejected");
    assert.equal(bodyPost.status, 400, "POST bodies must be rejected");
    assert.equal(missingCsrf.status, 403, "refresh requires CSRF");
    assert.equal((await standin.spawns("claude")).length, 0, "guards must not spawn");

    await standin.setControl({ claude: { nonce: "n1" } });
    const before = (await standin.discoverySpawns("claude")).length;
    const first = await http.api("POST", `${base}/claude-code/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(first.status, 200, first.text.slice(0, 600));
    const ready = catalogOf(first, "refresh claude");
    assertBase(ready, project.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.source, CLAUDE_SOURCE);
    assert.equal(ready.cliVersion, "2.1.310");
    assert.equal(ready.truncated, false);
    assert.equal(typeof ready.fetchedAt, "number");
    assert.equal(typeof ready.expiresAt, "number");
    assert.ok((ready.expiresAt as number) > (ready.fetchedAt as number));
    const ids = idsOf(ready);
    assert.deepEqual(ids, [
      "claude-qa-n1",
      "claude-qa-n1-punctuation.v2",
      "claude-qa-n1-unicode-é",
    ]);
    const items = ready.items as Array<Record<string, unknown>>;
    assert.equal(items[0]?.source, CLAUDE_SOURCE);
    assert.equal(items[0]?.label, "QA Claude n1");
    assert.equal(items[0]?.description, "Dynamic metadata row n1");
    const exactValueNotResolved = !ids.includes("resolved-n1");
    assert.ok(exactValueNotResolved, "resolvedModel must not replace the exact ModelInfo.value");

    const afterFirst = (await standin.discoverySpawns("claude")).length;
    const oneChildPerRefresh = afterFirst - before === 1;
    assert.ok(oneChildPerRefresh, "explicit refresh must launch exactly one child");

    const discovery = await standin.discoverySpawns("claude");
    const spawn = discovery[discovery.length - 1];
    assert.ok(spawn !== undefined);
    assert.equal(spawn.cwd?.startsWith(`${ws.dataDir}/`), true);
    assert.notEqual(spawn.cwd, ws.projectDir);
    const neutralCwd = spawn.cwd?.startsWith(`${ws.dataDir}/`) === true;
    const dataDirScope = spawn.cwd === undefined ? false : spawn.cwd.startsWith(ws.dataDir);
    const contextPreserved =
      spawn.home === standin.env.HOME && spawn.claudeHome === standin.env.CLAUDE_CONFIG_DIR;
    assert.equal(contextPreserved, true);

    const frames = await standin.frames("claude");
    assert.ok(frames.length >= 1, "stand-in must receive the SDK initialize frame");
    const framesInitializeOnly = frames.every((frame) => !forbiddenFrame(frame));
    const noUserFrame = !frames.some((frame) => frame.type === "user");
    assert.ok(framesInitializeOnly && noUserFrame, "only initialize control frames are allowed");
    assert.deepEqual(await standin.violations("claude"), []);
    assert.equal(
      frames.some((frame) => JSON.stringify(frame).includes('"type":"user"')),
      false,
    );
    const noPagination =
      frames.every((frame) => !JSON.stringify(frame).includes("model/list")) &&
      !JSON.stringify(ready).includes("nextCursor");
    assert.ok(noPagination, "Claude metadata must not paginate");

    const cached = await http.api("GET", `${base}/claude-code/models`);
    assert.equal(cached.status, 200);
    const cachedBody = catalogOf(cached, "cached claude");
    assert.equal(cachedBody.status, "ready");
    assert.deepEqual(idsOf(cachedBody), ids);
    const cacheHitNoSpawn = (await standin.discoverySpawns("claude")).length === afterFirst;

    await standin.setControl({ claude: { nonce: "n2" } });
    const second = await http.api("POST", `${base}/claude-code/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(second.status, 200);
    const secondBody = catalogOf(second, "second claude");
    assert.equal(secondBody.status, "ready");
    const secondIds = idsOf(secondBody);
    assert.ok(secondIds.includes("claude-qa-n2"));
    assert.ok(!secondIds.includes("claude-qa-n1"));
    const changedOnSecondRefresh = true;

    await standin.touchClaudeSettings();
    const beforeInvalidated = (await standin.discoverySpawns("claude")).length;
    const invalidated = await http.api("GET", `${base}/claude-code/models`);
    assert.equal(invalidated.status, 200);
    const invalidatedBody = catalogOf(invalidated, "invalidated claude");
    assert.equal(invalidatedBody.status, "unavailable");
    assert.equal(invalidatedBody.source, "none");
    assert.deepEqual(invalidatedBody.items, []);
    assert.equal(invalidatedBody.message, COLD_MESSAGE);
    const contextInvalidated =
      (await standin.discoverySpawns("claude")).length === beforeInvalidated;
    assert.equal(contextInvalidated, true);

    await standin.setControl({ claude: { nonce: "n3", delayMs: 400 } });
    const beforeSingle = (await standin.discoverySpawns("claude")).length;
    const [a, b] = await Promise.all([
      http.api("POST", `${base}/claude-code/models/refresh`, {
        headers: { "Content-Type": "application/json" },
      }),
      http.api("POST", `${base}/claude-code/models/refresh`, {
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const singleA = catalogOf(a, "singleflight a");
    const singleB = catalogOf(b, "singleflight b");
    assert.equal(singleA.status, "ready");
    assert.equal(singleB.status, "ready");
    assert.deepEqual(idsOf(singleA), idsOf(singleB));
    assert.ok(idsOf(singleA).includes("claude-qa-n3"));
    const singleFlightOneChild =
      (await standin.discoverySpawns("claude")).length - beforeSingle === 1;
    assert.ok(singleFlightOneChild, "concurrent refresh must share one child");

    await standin.setControl({ claude: { nonce: "n3", fail: "error" } });
    const beforeFailure = (await standin.discoverySpawns("claude")).length;
    const failed = await http.api("POST", `${base}/claude-code/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(failed.status, 200);
    const failedBody = catalogOf(failed, "failed claude");
    assert.equal(failedBody.status, "stale");
    assert.equal(failedBody.source, CLAUDE_SOURCE);
    assert.deepEqual(idsOf(failedBody), idsOf(singleA));
    const staleKeepsItems = true;
    assert.ok((await standin.discoverySpawns("claude")).length > beforeFailure);
    const afterFailure = (await standin.discoverySpawns("claude")).length;

    const cooldown = await http.api("POST", `${base}/claude-code/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(cooldown.status, 200);
    const cooldownBody = catalogOf(cooldown, "cooldown claude");
    assert.ok(["stale", "unavailable"].includes(String(cooldownBody.status)));
    assert.deepEqual(idsOf(cooldownBody), idsOf(singleA));
    const cooldownNoStampede = (await standin.discoverySpawns("claude")).length === afterFailure;
    assert.equal(cooldownNoStampede, true);

    const apiModule = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/api/dist/index.js")).href
    )) as {
      ApiClient: new (options: {
        baseUrl: string;
        token: string;
      }) => {
        getCliModels(projectId: string, cli: "claude-code"): Promise<Record<string, unknown>>;
        refreshCliModels(projectId: string, cli: "claude-code"): Promise<Record<string, unknown>>;
      };
    };
    const client = new apiModule.ApiClient({ baseUrl: server.baseUrl, token: server.meta.token });
    const clientGet = await client.getCliModels(project.id, "claude-code");
    assert.ok(["ready", "stale"].includes(String(clientGet.status)));
    assert.deepEqual(idsOf(clientGet), idsOf(singleA));
    const apiClientReady = true;

    const timeoutDir = join(ws.root, "project-timeout");
    await mkdir(timeoutDir, { recursive: true });
    const timeoutProject = await registerProject(http, timeoutDir);
    const timeoutBase = `/api/projects/${encodeURIComponent(timeoutProject.id)}/clis`;
    await standin.setControl({ claude: { nonce: "late", fail: "hang" } });
    const timeoutStarted = Date.now();
    const timeoutResult = await http.api("POST", `${timeoutBase}/claude-code/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    const timeoutBoundedMs = Date.now() - timeoutStarted;
    assert.equal(timeoutResult.status, 200);
    const timeoutBody = catalogOf(timeoutResult, "timeout claude");
    assert.ok(["unavailable", "unsupported"].includes(String(timeoutBody.status)));
    assert.deepEqual(timeoutBody.items, []);
    assert.ok(timeoutBoundedMs < 20_000, `timeout took ${String(timeoutBoundedMs)}ms`);
    await standin.setControl({ claude: { nonce: "n3" } });

    const serialized = JSON.stringify([
      coldBody,
      ready,
      cachedBody,
      secondBody,
      invalidatedBody,
      singleA,
      failedBody,
      cooldownBody,
      timeoutBody,
    ]);
    const secrets = [
      ...Object.values(standin.env),
      "dummy-anthropic-test-key",
      "dummy-anthropic-test-token",
      "dummy-openai-test-key",
      "dummy-codex-test-key",
      "dummy-test-token",
      server.meta.token,
      ws.root,
      ws.dataDir,
      ws.projectDir,
    ];
    const safeMessages = secrets.every((secret) => !serialized.includes(secret));
    assert.equal(safeMessages, true, "catalog responses must not leak paths, env or tokens");

    await standin.assertSentinelsUnchanged();
    return {
      projectId: project.id,
      coldUnavailable: true,
      coldNoSpawn,
      queryRejected: query.status,
      bodyRejected: bodyPost.status,
      missingCsrfRejected: missingCsrf.status,
      oneChildPerRefresh,
      readyStatus: String(ready.status),
      source: String(ready.source),
      cliVersion: ready.cliVersion as string | null,
      dynamicIds: ids,
      changedOnSecondRefresh,
      exactValueNotResolved,
      framesInitializeOnly,
      noUserFrame,
      neutralCwd,
      dataDirScope,
      contextPreserved,
      cacheHitNoSpawn,
      contextInvalidated,
      singleFlightOneChild,
      staleKeepsItems,
      cooldownNoStampede,
      timeoutBoundedMs,
      timeoutStatus: String(timeoutBody.status),
      truncated: false,
      apiClientReady,
      safeMessages,
      sentinelsUnchanged: true,
    };
  } finally {
    if (server !== null) {
      const agents = collectSpawnedAgents(ws.dataDir);
      await shutdownOwned({ server, agents, sentinel, keep: true, dataDir: ws.root });
      try {
        if (standin !== null) {
          const alive = await liveDiscoveryPids(standin);
          assert.deepEqual(alive, [], "Claude discovery children must not survive cleanup");
          await standin.assertNoLiveProcesses();
          await standin.assertSentinelsUnchanged();
        }
      } finally {
        await rm(ws.root, { recursive: true, force: true });
      }
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}
