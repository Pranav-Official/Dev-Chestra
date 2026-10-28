import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, makeWorkspace, REPO_ROOT } from "./fixtures.js";
import { type HttpResult, objectBody, RelayHttp } from "./http.js";
import { installModelStandins, type ModelStandin, type StandinLogEntry } from "./model-standin.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";
import { registerProject } from "./workflow-api.js";

export interface ModelHttpEvidence {
  projectId: string;
  coldGetNoSpawn: boolean;
  cachedGetNoSpawn: boolean;
  claudeColdUnavailable: boolean;
  fakeRejected: number;
  opencodeReady: boolean;
  piReady: boolean;
  queryRejected: number;
  bodyRejected: number;
  readyStatus: string;
  itemIds: string[];
  rawModelDiffIncluded: boolean;
  rawIdExcluded: boolean;
  paginationMerged: boolean;
  rpcMethods: string[];
  onlyMetadataRpc: boolean;
  noClaudeSpawn: boolean;
  noModelTurn: boolean;
  neutralCwd: boolean;
  testHomePreserved: boolean;
  sentinelsUnchanged: boolean;
  truncated: boolean;
  staleKeptItems: boolean;
  cooldownNoStampede: boolean;
  apiClientReady: boolean;
  safeMessages: boolean;
  spawns: number;
}

function catalogOf(result: HttpResult, label: string): Record<string, unknown> {
  return objectBody(result, label);
}

function itemIds(body: Record<string, unknown>): string[] {
  const items = body.items;
  assert.ok(Array.isArray(items), "catalog items must be an array");
  return items.map((item) => {
    assert.equal(typeof item, "object");
    const id = (item as Record<string, unknown>).id;
    assert.equal(typeof id, "string");
    return id as string;
  });
}

function assertBase(body: Record<string, unknown>, cli: string, projectId: string): void {
  assert.equal(body.cli, cli);
  assert.equal(body.projectId, projectId);
  assert.equal(body.scope, "relay-runtime");
  assert.equal(body.customSupported, true);
  assert.equal(typeof body.truncated, "boolean");
  assert.ok(body.fetchedAt === null || typeof body.fetchedAt === "number");
  assert.ok(body.expiresAt === null || typeof body.expiresAt === "number");
  assert.ok(body.cliVersion === null || typeof body.cliVersion === "string");
  assert.ok(Array.isArray(body.items));
}

function forbidden(entry: StandinLogEntry): boolean {
  const method = entry.method ?? "";
  return /^(thread|turn|account|config|session)\//u.test(method);
}

export async function runModelHttpScenario(): Promise<ModelHttpEvidence> {
  const ws = await makeWorkspace("relay-p3-models-http-");
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
      extraArgs: ["--allow-experimental-adapters"],
    });
    const http = new RelayHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);

    const base = `/api/projects/${encodeURIComponent(project.id)}/clis`;

    const cold = await http.api("GET", `${base}/codex/models`);
    assert.equal(cold.status, 200, cold.text.slice(0, 400));
    const coldBody = catalogOf(cold, "cold codex");
    assertBase(coldBody, "codex", project.id);
    assert.equal(coldBody.status, "unavailable");
    assert.equal(coldBody.source, "none");
    assert.deepEqual(coldBody.items, []);
    assert.equal(coldBody.fetchedAt, null);
    assert.equal(coldBody.expiresAt, null);
    assert.equal(coldBody.truncated, false);
    assert.equal(coldBody.cliVersion, null);
    const coldGetNoSpawn = (await standin.spawns()).length === 0;

    const claude = await http.api("GET", `${base}/claude-code/models`);
    assert.equal(claude.status, 200);
    const claudeBody = catalogOf(claude, "claude");
    assertBase(claudeBody, "claude-code", project.id);
    assert.equal(claudeBody.status, "unavailable");
    assert.equal(claudeBody.source, "none");
    assert.equal(claudeBody.cliVersion, null);
    assert.equal(claudeBody.fetchedAt, null);
    assert.equal(claudeBody.expiresAt, null);
    assert.deepEqual(claudeBody.items, []);
    assert.equal(
      claudeBody.message,
      "No model catalog is cached yet. Refresh models to load it.",
      "Claude cold GET must be lazy-unavailable, not permanent unsupported",
    );
    const claudeColdUnavailable = true;

    const fakeGet = await http.api("GET", `${base}/fake/models`);
    assert.equal(fakeGet.status, 400, "retired fake GET must be rejected");
    const fakePost = await http.api("POST", `${base}/fake/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(fakePost.status, 400, "retired fake refresh must be rejected");
    const fakeRejected = fakeGet.status;
    assert.equal((await standin.spawns()).length, 0, "retired fake must not spawn any CLI");

    // Ready/stale flow per real CLI with stand-ins: cold GET is lazy and
    // spawn-free; explicit refresh discovers; cached GET reuses the cache.
    async function readyFlow(
      cli: "opencode" | "pi",
      source: string,
      expectedIds: string[],
    ): Promise<boolean> {
      assert.ok(standin !== null, "stand-ins must be installed");
      const before = (await standin.spawns()).length;
      const coldCli = await http.api("GET", `${base}/${cli}/models`);
      assert.equal(coldCli.status, 200, coldCli.text.slice(0, 400));
      const coldCliBody = catalogOf(coldCli, `cold ${cli}`);
      assertBase(coldCliBody, cli, project.id);
      assert.equal(coldCliBody.status, "unavailable");
      assert.equal(coldCliBody.source, "none");
      assert.deepEqual(coldCliBody.items, []);
      assert.equal((await standin.spawns()).length, before, "cold GET must not spawn");
      const refreshCli = await http.api("POST", `${base}/${cli}/models/refresh`, {
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(refreshCli.status, 200, refreshCli.text.slice(0, 600));
      const readyCli = catalogOf(refreshCli, `refresh ${cli}`);
      assertBase(readyCli, cli, project.id);
      assert.equal(readyCli.status, "ready");
      assert.equal(readyCli.source, source);
      assert.deepEqual(itemIds(readyCli), expectedIds);
      const afterRefresh = (await standin.spawns()).length;
      assert.ok(afterRefresh > before, `${cli} refresh must have spawned`);
      const cachedCli = await http.api("GET", `${base}/${cli}/models`);
      assert.equal(cachedCli.status, 200);
      assert.deepEqual(itemIds(catalogOf(cachedCli, `cached ${cli}`)), expectedIds);
      assert.equal((await standin.spawns()).length, afterRefresh, "cached GET must not spawn");
      return true;
    }

    const opencodeReady = await readyFlow("opencode", "opencode-models", [
      "testprovider/opencode-exact-a",
      "testprovider/opencode-exact-b",
    ]);
    const piReady = await readyFlow("pi", "pi-list-models", [
      "testprovider/pi-exact-a",
      "testprovider/pi-exact-b",
    ]);

    const preRejectSpawns = (await standin.spawns()).length;
    const query = await http.api("GET", `${base}/codex/models?limit=1`);
    const bodyPost = await http.api("POST", `${base}/codex/models/refresh`, { body: { x: 1 } });
    assert.equal(query.status, 400, "query strings must be rejected");
    assert.equal(bodyPost.status, 400, "POST bodies must be rejected");
    assert.equal(
      (await standin.spawns()).length,
      preRejectSpawns,
      "rejected requests must not spawn",
    );

    const refresh = await http.api("POST", `${base}/codex/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(refresh.status, 200, refresh.text.slice(0, 600));
    const ready = catalogOf(refresh, "refresh codex");
    assertBase(ready, "codex", project.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.source, "codex-app-server");
    assert.equal(typeof ready.fetchedAt, "number");
    assert.equal(typeof ready.expiresAt, "number");
    assert.ok((ready.expiresAt as number) > (ready.fetchedAt as number));
    assert.equal(ready.truncated, false);
    const ids = itemIds(ready);
    assert.equal(ids.length, 6, `expected 6 merged items, got ${ids.join(",")}`);
    assert.ok(ids.includes("exact-alpha"));
    assert.ok(ids.includes("exact-raw-model"), "item id must be the raw model value");
    assert.ok(!ids.includes("raw-id-vs-model"), "raw id must not replace the exact model");
    const items = ready.items as Array<Record<string, unknown>>;
    const alpha = items.find((item) => item.id === "exact-alpha");
    assert.equal(alpha?.isDefault, true);
    assert.equal(alpha?.source, "codex-app-server");
    const rawDiff = items.find((item) => item.id === "exact-raw-model");
    assert.equal(rawDiff?.label, "Raw Model Diff");

    const spawnsAfterRefresh = await standin.spawns();
    const appServers = spawnsAfterRefresh.filter((entry) => entry.mode === "app-server");
    assert.equal(appServers.length, 1, "explicit refresh must launch one app-server");
    const rpc = await standin.rpcs("codex");
    const methods = rpc.map((entry) => entry.method ?? "");
    assert.deepEqual(
      methods,
      ["initialize", "initialized", "model/list", "model/list", "model/list"],
      `unexpected RPC sequence: ${methods.join(",")}`,
    );
    const onlyMetadataRpc = rpc.every((entry) => !forbidden(entry));
    const noClaudeSpawn = (await standin.spawns("claude")).length === 0;
    const execTurns = (await standin.execSpawns("codex")).filter(
      (entry) => entry.mode !== "version",
    );
    const noModelTurn = execTurns.length === 0;

    const appServer = appServers[0];
    assert.ok(appServer !== undefined);
    const cwd = appServer.cwd ?? "";
    const neutralCwd = cwd.startsWith(`${ws.dataDir}/`) && cwd !== ws.projectDir;
    const testHomePreserved =
      appServer.home === standin.env.HOME && appServer.codexHome === standin.env.CODEX_HOME;
    await standin.assertSentinelsUnchanged();

    const cached = await http.api("GET", `${base}/codex/models`);
    assert.equal(cached.status, 200);
    const cachedBody = catalogOf(cached, "cached codex");
    assert.equal(cachedBody.status, "ready");
    assert.deepEqual(itemIds(cachedBody), ids);
    const cachedGetNoSpawn = (await standin.spawns()).length === spawnsAfterRefresh.length;

    const apiModule = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/api/dist/index.js")).href
    )) as {
      ApiClient: new (options: {
        baseUrl: string;
        token: string;
      }) => {
        getCliModels(projectId: string, cli: "codex"): Promise<Record<string, unknown>>;
        refreshCliModels(projectId: string, cli: "codex"): Promise<Record<string, unknown>>;
      };
    };
    const client = new apiModule.ApiClient({ baseUrl: server.baseUrl, token: server.meta.token });
    const clientGet = await client.getCliModels(project.id, "codex");
    assert.equal(clientGet.status, "ready");
    assert.deepEqual(itemIds(clientGet), ids);
    const clientRefresh = await client.refreshCliModels(project.id, "codex");
    assert.equal(clientRefresh.status, "ready");
    const apiClientReady = true;

    await standin.setControl({ pageCount: 11 });
    const truncatedResult = await http.api("POST", `${base}/codex/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(truncatedResult.status, 200);
    const truncatedBody = catalogOf(truncatedResult, "truncated");
    assert.equal(truncatedBody.status, "ready");
    assert.equal(truncatedBody.truncated, true);
    const truncatedIds = itemIds(truncatedBody);
    assert.ok(
      truncatedIds.length >= 20,
      `expected capped pages, got ${String(truncatedIds.length)}`,
    );
    const truncated = true;

    await standin.setControl({ fail: "methodNotFound" });
    const beforeFailureSpawns = (await standin.spawns()).length;
    const failedResult = await http.api("POST", `${base}/codex/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(failedResult.status, 200);
    const failedBody = catalogOf(failedResult, "failed refresh");
    assert.equal(failedBody.status, "stale");
    assert.deepEqual(itemIds(failedBody), truncatedIds);
    const staleKeptItems = true;
    assert.equal(failedBody.source, "codex-app-server");
    const afterFailureSpawns = (await standin.spawns()).length;
    assert.ok(afterFailureSpawns > beforeFailureSpawns, "failure refresh should have spawned");

    const cooldown = await http.api("POST", `${base}/codex/models/refresh`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(cooldown.status, 200);
    const cooldownBody = catalogOf(cooldown, "cooldown refresh");
    assert.ok(["stale", "unavailable"].includes(String(cooldownBody.status)));
    assert.deepEqual(itemIds(cooldownBody), truncatedIds);
    const cooldownNoStampede = (await standin.spawns()).length === afterFailureSpawns;

    const afterFailure = await http.api("GET", `${base}/codex/models`);
    assert.equal(afterFailure.status, 200);
    const afterFailureBody = catalogOf(afterFailure, "after failure");
    assert.deepEqual(itemIds(afterFailureBody), truncatedIds);

    const serialized = JSON.stringify([coldBody, claudeBody, ready, failedBody]);
    const secrets = [
      ...Object.values(standin.env),
      "dummy-anthropic-test-key",
      "dummy-openai-test-key",
      "dummy-codex-test-key",
      "dummy-test-token",
      server.meta.token,
    ];
    const safeMessages = secrets.every((secret) => !serialized.includes(secret));

    return {
      projectId: project.id,
      coldGetNoSpawn,
      cachedGetNoSpawn,
      claudeColdUnavailable,
      fakeRejected,
      opencodeReady,
      piReady,
      queryRejected: query.status,
      bodyRejected: bodyPost.status,
      readyStatus: String(ready.status),
      itemIds: ids,
      rawModelDiffIncluded: ids.includes("exact-raw-model"),
      rawIdExcluded: !ids.includes("raw-id-vs-model"),
      paginationMerged: ids.length === 6,
      rpcMethods: methods,
      onlyMetadataRpc,
      noClaudeSpawn,
      noModelTurn,
      neutralCwd,
      testHomePreserved,
      sentinelsUnchanged: true,
      truncated,
      staleKeptItems,
      cooldownNoStampede,
      apiClientReady,
      safeMessages,
      spawns: afterFailureSpawns,
    };
  } finally {
    if (server !== null) {
      const agents = collectSpawnedAgents(ws.dataDir);
      await shutdownOwned({ server, agents, sentinel, keep: true, dataDir: ws.root });
      try {
        if (standin !== null) {
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
