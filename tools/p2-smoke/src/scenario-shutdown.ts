import assert from "node:assert/strict";
import { Agent, request as httpRequest } from "node:http";
import { matchesProcess } from "@devchestra/adapters";
import { defaultIdempotencyKey, registerProject, startRun } from "./api-ops.js";
import { CLI, makeWorkspace, scriptPath, sleep } from "./fixtures.js";
import { DevChestraHttp } from "./http.js";
import {
  collectAgent,
  type OwnedServer,
  shutdownOwned,
  startSentinel,
  startServer,
} from "./owned.js";
import { SseConnection } from "./sse.js";
import { readStoreSnapshot } from "./store-read.js";

export interface ShutdownEvidence {
  exitMs: number;
  exitCode: number | null;
  sseClosedMs: number;
  portClosed: boolean;
  keepAliveSocketsClosed: boolean;
  agentsDead: boolean;
  sentinelAlive: boolean;
}

async function healthWithKeepAlive(port: number): Promise<Agent> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        method: "GET",
        agent,
        headers: { Host: `127.0.0.1:${String(port)}`, Accept: "application/json" },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve());
      },
    );
    req.once("error", reject);
    req.end();
  });
  const pooled = Object.values(agent.freeSockets).flat();
  assert.ok(pooled.length > 0, "keep-alive health request did not leave a pooled socket");
  return agent;
}

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/health", method: "GET", timeout: 1_000 },
      (res) => {
        res.resume();
        resolve(false);
      },
    );
    req.once("error", () => resolve(true));
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function runShutdownScenario(): Promise<ShutdownEvidence> {
  const ws = await makeWorkspace("devchestra-p2-shutdown-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  const agents = new Map<number, { pid: number; pidStart: string; binary: string }>();
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("hold"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    const boot = await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);
    const run = await startRun(http, project.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "shutdown" },
      idempotencyKey: defaultIdempotencyKey(),
    });

    const sse = new SseConnection({
      baseUrl: server.baseUrl,
      path: `/api/runs/${encodeURIComponent(run.runId)}/stream?after=0`,
      cookie: boot.cookie,
      origin: server.baseUrl,
    });
    await sse.opened;
    await sse.waitFor(
      (frames) => frames.some((frame) => frame.event === "run"),
      20_000,
      "live run event before shutdown",
    );
    const agent = collectAgent(
      JSON.parse(sse.frames.find((frame) => frame.event === "run")?.data ?? "{}") as {
        type?: string;
        payload?: unknown;
      },
    );
    if (agent !== null) agents.set(agent.pid, agent);
    const db = readStoreSnapshot(ws.dataDir, run.runId);
    for (const event of db.events) {
      const found = collectAgent(event as unknown as { type?: string; payload?: unknown });
      if (found !== null) agents.set(found.pid, found);
    }

    const keepAlive = await healthWithKeepAlive(server.meta.port);
    let sseClosed = false;
    void sse.ended.then(() => {
      sseClosed = true;
    });

    const start = Date.now();
    await server.stop();
    const exitMs = Date.now() - start;
    const exitCode = server.child.exitCode;
    for (let attempt = 0; attempt < 100 && !sseClosed; attempt += 1) await sleep(20);
    const sseClosedMs = Date.now() - start;

    assert.equal(exitCode, 0, "SIGTERM shutdown must exit 0");
    assert.ok(exitMs < 8_000, `graceful shutdown exceeded 8s: ${String(exitMs)}ms`);
    assert.ok(sseClosed, "open SSE did not close during shutdown");
    const portClosed = await portRefused(server.meta.port);
    assert.ok(portClosed, "browser listener still accepts connections after shutdown");
    const keepAliveSocketsClosed = Object.values(keepAlive.freeSockets).flat().length === 0;
    keepAlive.destroy();
    assert.ok(keepAliveSocketsClosed, "keep-alive socket survived shutdown");
    let agentsDead = true;
    for (const item of agents.values()) {
      if (await matchesProcess(item)) agentsDead = false;
    }
    assert.ok(agentsDead, "agent process survived shutdown");
    assert.equal(sentinel.exitCode, null, "unrelated sentinel died during shutdown");

    const sentinelAlive = sentinel.exitCode === null && sentinel.signalCode === null;
    await shutdownOwned({
      server,
      agents: [...agents.values()],
      sentinel,
      keep: false,
      dataDir: ws.root,
    });
    return {
      exitMs,
      exitCode,
      sseClosedMs,
      portClosed,
      keepAliveSocketsClosed,
      agentsDead,
      sentinelAlive,
    };
  } finally {
    if (server !== null && server.child.exitCode === null) {
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
  }
}
