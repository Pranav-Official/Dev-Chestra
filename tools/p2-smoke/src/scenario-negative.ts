import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultIdempotencyKey, registerProject, startRun } from "./api-ops.js";
import { CLI, makeWorkspace, scriptPath } from "./fixtures.js";
import { errorCode, type HttpResult, RelayHttp } from "./http.js";
import {
  collectAgent,
  type OwnedServer,
  shutdownOwned,
  startSentinel,
  startServer,
} from "./owned.js";
import { readStoreSnapshot } from "./store-read.js";

export interface NegativeEvidence {
  cases: Array<{ name: string; status: number }>;
  crossNamespaceCookieRejected: boolean;
  crossNamespaceTokenRejected: boolean;
  crossNamespaceRunRejected: boolean;
}

function expectStatus(result: HttpResult, allowed: readonly number[], label: string): void {
  if (!allowed.includes(result.status)) {
    throw new Error(
      `${label}: expected ${allowed.join("/")} got ${String(result.status)} body=${JSON.stringify(
        result.body,
      ).slice(0, 500)}`,
    );
  }
}

function expectError(result: HttpResult, allowedStatus: readonly number[], label: string): void {
  expectStatus(result, allowedStatus, label);
  assert.ok(errorCode(result) !== null, `${label}: missing {error:{code}}`);
}

async function agentsFromDb(
  dataDir: string,
  runIds: readonly string[],
): Promise<Array<{ pid: number; pidStart: string; binary: string }>> {
  const agents = new Map<number, { pid: number; pidStart: string; binary: string }>();
  for (const runId of runIds) {
    try {
      const snapshot = readStoreSnapshot(dataDir, runId);
      for (const event of snapshot.events) {
        const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
        if (agent !== null) agents.set(agent.pid, agent);
      }
    } catch {
      // Best-effort cleanup source.
    }
  }
  return [...agents.values()];
}

export async function runNegativeScenario(): Promise<NegativeEvidence> {
  const ws = await makeWorkspace("relay-p2-negative-");
  const other = await makeWorkspace("relay-p2-negative-other-");
  const sentinel = startSentinel();
  const otherSentinel = startSentinel();
  const agents = new Map<number, { pid: number; pidStart: string; binary: string }>();
  const runIds: string[] = [];
  let server: OwnedServer | null = null;
  let otherServer: OwnedServer | null = null;
  const cases: NegativeEvidence["cases"] = [];
  const record = (name: string, result: HttpResult): void => {
    cases.push({ name, status: result.status });
  };
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("hold"),
    });
    const http = new RelayHttp(server.baseUrl);
    await http.health();
    const boot = await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);

    const noCookie = await http.api("GET", "/api/bootstrap", { cookie: null });
    expectError(noCookie, [401], "missing cookie");
    record("missing-cookie", noCookie);

    const invalidToken = await http.api("GET", "/?t=not-the-token", { cookie: null });
    expectStatus(invalidToken, [401], "invalid bootstrap token");
    record("invalid-bootstrap-token", invalidToken);

    const bare = await http.api("GET", "/", { cookie: null });
    expectStatus(bare, [200], "bare root");
    assert.ok(!bare.text.includes(project.id), "bare root must not expose project data");
    assert.ok(!bare.text.includes(server.meta.token), "bare root must not expose the token");
    record("bare-root-no-data", bare);

    const wrongHost = await http.api("GET", "/api/health", {
      cookie: null,
      host: `evil.example:${String(server.meta.port)}`,
    });
    expectStatus(wrongHost, [421], "wrong Host");
    record("wrong-host", wrongHost);

    const foreignOrigin = await http.api("POST", "/api/projects", {
      body: { path: other.projectDir },
      origin: "http://evil.example",
    });
    expectError(foreignOrigin, [403], "foreign Origin");
    record("foreign-origin", foreignOrigin);

    const missingCsrf = await http.api("POST", "/api/projects", {
      body: { path: other.projectDir },
      csrf: false,
    });
    expectError(missingCsrf, [403], "missing CSRF");
    record("missing-csrf", missingCsrf);

    const missingContentType = await http.api("POST", "/api/projects", {
      body: { path: other.projectDir },
      omitContentType: true,
    });
    expectError(missingContentType, [403], "missing content type");
    record("missing-content-type", missingContentType);

    const execTokenOnApi = await http.api("GET", "/api/bootstrap", {
      cookie: null,
      headers: { Authorization: "Bearer not-an-exec-token" },
    });
    expectError(execTokenOnApi, [401], "bearer token on /api");
    record("bearer-on-api", execTokenOnApi);

    const randomApiToken = await http.api("GET", "/api/bootstrap", {
      cookie: null,
      headers: { "X-Relay-Token": "not-the-server-token" },
    });
    expectError(randomApiToken, [401], "wrong X-Relay-Token");
    record("wrong-api-token", randomApiToken);

    const cookieOnInternal = await http.api("POST", "/internal/agent/tools", {
      body: {},
    });
    expectStatus(cookieOnInternal, [401, 403, 404], "browser cookie on /internal");
    assert.ok(cookieOnInternal.status >= 400, "browser cookie must not authenticate /internal");
    record("cookie-on-internal", cookieOnInternal);

    const unknownApi = await http.api("GET", "/api/definitely-not-a-route");
    expectError(unknownApi, [404], "unknown API route");
    record("unknown-api", unknownApi);

    const insideData = await http.api("POST", "/api/projects", { body: { path: ws.dataDir } });
    expectError(insideData, [403], "project inside data dir");
    record("project-inside-data", insideData);

    const ancestorData = await http.api("POST", "/api/projects", { body: { path: ws.root } });
    expectError(ancestorData, [403], "project ancestor of data dir");
    record("project-ancestor-data", ancestorData);

    const duplicate = await http.api("POST", "/api/projects", { body: { path: ws.projectDir } });
    expectStatus(duplicate, [200], "duplicate project");
    const duplicateId = (duplicate.body as { id?: unknown }).id;
    assert.equal(duplicateId, project.id, "duplicate registration must keep the same project id");
    record("duplicate-project-idempotent", duplicate);

    for (const workflowFile of ["../p2-basic.json", "/etc/passwd", "sub/../../p2-basic.json"]) {
      const result = await http.api(
        "POST",
        `/api/projects/${encodeURIComponent(project.id)}/runs`,
        { body: { workflowFile, params: { topic: "t" } }, idempotencyKey: defaultIdempotencyKey() },
      );
      expectError(result, [400, 403], `workflow traversal ${workflowFile}`);
      record(`workflow-traversal-${workflowFile}`, result);
    }

    const strictBody = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/runs`,
      {
        body: {
          workflowFile: ws.workflowFile,
          script: [{ type: "submit", output: { summary: "injected" } }],
        },
        idempotencyKey: defaultIdempotencyKey(),
      },
    );
    expectError(strictBody, [400], "unknown start-run field");
    record("strict-start-body", strictBody);

    const outside = join(ws.root, "outside.json");
    await writeFile(
      outside,
      JSON.stringify({
        schemaVersion: 1,
        id: "outside",
        name: "x",
        graph: { nodes: [], edges: [] },
      }),
    );
    await symlink(outside, join(ws.projectDir, "link.json"));
    const symlinkRun = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/runs`,
      {
        body: { workflowFile: "link.json", params: {} },
        idempotencyKey: defaultIdempotencyKey(),
      },
    );
    expectError(symlinkRun, [400, 403], "symlink workflow");
    record("symlink-workflow", symlinkRun);

    const started = await startRun(http, project.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "negative" },
      idempotencyKey: defaultIdempotencyKey(),
    });
    runIds.push(started.runId);

    const execTraversal = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(started.runId)}/executions/${encodeURIComponent("../../etc/passwd")}`,
    );
    expectStatus(execTraversal, [400, 403, 404], "execution path traversal");
    record("execution-path-traversal", execTraversal);

    const artifactUnsupported = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(started.runId)}/artifacts/${encodeURIComponent("../x")}`,
    );
    expectStatus(artifactUnsupported, [400, 403, 404, 501], "artifact traversal/unsupported");
    record("artifact-traversal", artifactUnsupported);

    const overrideBody = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/runs`,
      {
        body: { workflowFile: ws.workflowFile, params: { topic: "t" }, provider: "codex" },
        idempotencyKey: defaultIdempotencyKey(),
      },
    );
    expectError(overrideBody, [400], "provider override rejected");
    record("provider-override", overrideBody);

    const oversizeBody = `{"path":"${other.projectDir}","padding":"${"a".repeat(2_200_000)}"}`;
    const oversize = await http.api("POST", "/api/projects", {
      rawBody: oversizeBody,
      headers: { "Content-Type": "application/json" },
    });
    expectStatus(oversize, [413], "oversize body");
    record("oversize-body", oversize);

    const foreignSse = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(started.runId)}/stream?after=0`,
      {
        origin: "http://evil.example",
        headers: { Accept: "text/event-stream" },
      },
    );
    expectError(foreignSse, [403], "foreign Origin SSE");
    record("foreign-origin-sse", foreignSse);

    const eventBody = (
      await http.api("GET", `/api/runs/${encodeURIComponent(started.runId)}/events?after=0`)
    ).body as { items?: Array<{ type?: string; payload?: unknown }> };
    for (const event of eventBody.items ?? []) {
      const agent = collectAgent(event);
      if (agent !== null) agents.set(agent.pid, agent);
    }

    const cancelled = await http.api(
      "POST",
      `/api/runs/${encodeURIComponent(started.runId)}/cancel`,
      { body: {} },
    );
    expectStatus(cancelled, [202], "cancel");
    record("cancel-supported", cancelled);

    otherServer = await startServer({
      cli: CLI,
      dataDir: other.dataDir,
      cwd: other.projectDir,
      fakeScript: scriptPath("basic"),
    });
    const second = new RelayHttp(otherServer.baseUrl);
    await second.health();
    second.cookie = boot.cookie;
    const crossCookie = await second.api("GET", "/api/bootstrap");
    expectError(crossCookie, [401], "cookie from another instance");
    const crossToken = await second.api("GET", "/api/bootstrap", {
      cookie: null,
      headers: { "X-Relay-Token": server.meta.token },
    });
    expectError(crossToken, [401], "token from another instance");
    await second.bootstrap(otherServer.meta.token);
    const crossRun = await second.api("GET", `/api/runs/${encodeURIComponent(started.runId)}`);
    expectError(crossRun, [404], "run id from another instance");

    return {
      cases,
      crossNamespaceCookieRejected: crossCookie.status === 401,
      crossNamespaceTokenRejected: crossToken.status === 401,
      crossNamespaceRunRejected: crossRun.status === 404,
    };
  } finally {
    for (const runId of runIds) {
      const fromDb = await agentsFromDb(ws.dataDir, [runId]);
      for (const agent of fromDb) agents.set(agent.pid, agent);
    }
    if (otherServer !== null) {
      await shutdownOwned({
        server: otherServer,
        agents: [],
        sentinel: otherSentinel,
        keep: false,
        dataDir: other.root,
      });
    }
    if (server !== null) {
      await shutdownOwned({
        server,
        agents: [...agents.values()],
        sentinel,
        keep: false,
        dataDir: ws.root,
      });
    } else {
      sentinel.kill("SIGKILL");
    }
    if (otherServer === null) otherSentinel.kill("SIGKILL");
  }
}
