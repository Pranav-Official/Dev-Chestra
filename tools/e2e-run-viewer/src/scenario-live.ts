import assert from "node:assert/strict";
import type { EventEnvelope, RunView } from "@devchestra/core";
import { defaultIdempotencyKey, getRun, isTerminal, registerProject, startRun } from "./api-ops.js";
import {
  assertProjectionMatches,
  assertSameIds,
  assertStrictlyIncreasingIds,
  assertViewEqual,
} from "./compare.js";
import { fetchAllEvents, fetchEventPage } from "./events.js";
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
import { readStoreSnapshot, type StoreSnapshot } from "./store-read.js";

export interface LiveEvidence {
  runId: string;
  projectId: string;
  startBeforeEnd: boolean;
  idempotentDuplicate: boolean;
  idempotencyConflict: boolean;
  firstConnectionEvents: number;
  reconnectedEvents: number;
  totalEvents: number;
  snapshotWatermark: number;
  finalEventId: number;
  finalStatus: string;
  pages: number;
  requests: number;
}

function envelopeOf(frame: { id?: string | null; data: string }): EventEnvelope {
  const parsed: unknown = JSON.parse(frame.data);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("SSE run data is not an object");
  return parsed as EventEnvelope;
}

function snapshotOf(frame: { data: string }): {
  runId: string;
  view: RunView;
  watermark: number;
} {
  const parsed = JSON.parse(frame.data) as Record<string, unknown>;
  if (typeof parsed.runId !== "string") throw new Error("snapshot has no runId");
  if (typeof parsed.watermark !== "number") throw new Error("snapshot has no watermark");
  const view = parsed.view as RunView | undefined;
  if (view === undefined || typeof view !== "object" || view === null) {
    throw new Error("snapshot has no view");
  }
  return { runId: parsed.runId, view, watermark: parsed.watermark };
}

async function snapshotWithRetry(dataDir: string, runId: string): Promise<StoreSnapshot> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return readStoreSnapshot(dataDir, runId);
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runLiveScenario(): Promise<LiveEvidence> {
  const ws = await makeWorkspace("devchestra-live-");
  const sentinel = startSentinel();
  const agents = new Map<number, { pid: number; pidStart: string; binary: string }>();
  const runIds: string[] = [];
  let server: OwnedServer | null = null;
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("slow"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    const health = await http.health();
    assert.ok(typeof health === "object" && health !== null, "health must be an object");
    const boot = await http.bootstrap(server.meta.token);
    assert.equal(boot.status, 303);
    assert.ok(boot.location !== null, "bootstrap must redirect");
    assert.ok(!boot.location.includes("t="), "bootstrap Location must not contain the token");
    assert.ok(!boot.html.includes(server.meta.token), "bootstrap HTML must not contain the token");
    assert.ok(
      !server.stdoutLines.join("\n").includes(server.meta.token),
      "structured startup output must not leak the token",
    );
    assert.ok(!server.stderr().includes(server.meta.token), "stderr must not leak the token");

    const project = await registerProject(http, ws.projectDir);
    const idempotencyKey = defaultIdempotencyKey();
    const before = Date.now();
    const started = await startRun(http, project.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "acceptance" },
      idempotencyKey,
    });
    const elapsed = Date.now() - before;
    runIds.push(started.runId);
    assert.equal(started.duplicate, false, "first run must not be a duplicate");
    assert.ok(elapsed < 10_000, "start request must return before a long run completes");
    const immediate = await getRun(http, started.runId);
    assert.ok(!isTerminal(immediate.status), "run must still be active when POST returns");
    const startBeforeEnd = !isTerminal(immediate.status);

    const duplicate = await startRun(http, project.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "acceptance" },
      idempotencyKey,
    });
    assert.equal(duplicate.runId, started.runId, "same key must return the original runId");
    assert.equal(duplicate.duplicate, true, "same key must be flagged duplicate");
    const conflict = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/runs`,
      {
        body: { workflowFile: ws.workflowFile, params: { topic: "different" } },
        idempotencyKey,
      },
    );
    assert.equal(conflict.status, 409, "same key with different body must be 409");

    const origin = server.baseUrl;
    const collect = (receiver: (event: EventEnvelope) => void) => ({
      onFrame: (frame: { event: string; data: string }) => {
        if (frame.event !== "run") return;
        const event = envelopeOf(frame);
        receiver(event);
        const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
        if (agent !== null) agents.set(agent.pid, agent);
      },
    });

    const firstEvents: EventEnvelope[] = [];
    const first = new SseConnection({
      baseUrl: server.baseUrl,
      path: `/api/runs/${encodeURIComponent(started.runId)}/stream?after=0`,
      cookie: boot.cookie,
      origin,
      ...collect((event) => firstEvents.push(event)),
    });
    await first.opened;
    await first.waitFor(
      (frames) => frames.filter((frame) => frame.event === "run").length >= 2,
      20_000,
      "two live events",
    );
    assert.equal(
      first.frames.filter((frame) => frame.event === "snapshot").length,
      0,
      "cursor mode must not send a snapshot frame",
    );

    const snapshotConnection = new SseConnection({
      baseUrl: server.baseUrl,
      path: `/api/runs/${encodeURIComponent(started.runId)}/stream`,
      cookie: boot.cookie,
      origin,
    });
    await snapshotConnection.opened;
    await snapshotConnection.waitFor(
      (frames) => frames.some((frame) => frame.event === "snapshot"),
      20_000,
      "SSE snapshot",
    );
    const snapshotFrame = snapshotConnection.frames.find((frame) => frame.event === "snapshot");
    assert.ok(snapshotFrame !== undefined, "snapshot frame is required");
    assert.equal(snapshotFrame.id, null, "snapshot frame must not carry an id line");
    const snapshot = snapshotOf(snapshotFrame);
    assert.equal(snapshot.runId, started.runId);
    const dbAtSnapshot = await snapshotWithRetry(ws.dataDir, started.runId);
    assertProjectionMatches(
      dbAtSnapshot.events.filter((event) => event.id <= snapshot.watermark),
      snapshot.view,
      "snapshot at watermark",
    );

    first.close();
    const firstIds = first.runFrames().map((item) => item.id);
    const lastApplied = Math.max(...firstIds);
    await sleep(900);
    const reconnectedEvents: EventEnvelope[] = [];
    const second = new SseConnection({
      baseUrl: server.baseUrl,
      path: `/api/runs/${encodeURIComponent(started.runId)}/stream?after=${String(lastApplied)}`,
      cookie: boot.cookie,
      origin,
      lastEventId: String(lastApplied),
      ...collect((event) => reconnectedEvents.push(event)),
    });
    await second.opened;
    await second.waitFor(
      (frames) =>
        frames.some((frame) => {
          if (frame.event !== "run") return false;
          return envelopeOf(frame).type === "run.completed";
        }),
      60_000,
      "run.completed after reconnect",
    );
    second.close();
    snapshotConnection.close();

    assert.equal(
      second.frames.filter((frame) => frame.event === "snapshot").length,
      0,
      "cursor reconnect must not send a snapshot frame",
    );
    const secondFrames = second.runFrames();
    assertStrictlyIncreasingIds(
      secondFrames.map((item) => item.id),
      "reconnected stream ids",
      true,
    );
    assert.ok(
      secondFrames.every((item) => item.id > lastApplied),
      "reconnect must not redeliver applied events",
    );

    const full = await fetchAllEvents(http, started.runId, { limit: 100 });
    const fullIds = full.events.map((event) => event.id);
    const unionIds = [
      ...first.runFrames().map((item) => item.id),
      ...secondFrames.map((item) => item.id),
    ];
    assertStrictlyIncreasingIds(unionIds, "disconnect/reconnect union", true);
    assertSameIds(unionIds, fullIds, "disconnect/reconnect must cover every committed event once");
    assert.ok(
      secondFrames.every((item) => {
        const data = envelopeOf(item.frame);
        return data.id === item.id;
      }),
      "SSE frame id must equal envelope id",
    );
    assert.ok(
      snapshotConnection.frames
        .filter((frame) => frame.event === "run")
        .every((frame) => Number(frame.id) > snapshot.watermark),
      "snapshot-to-live handoff must not replay events at/before the watermark",
    );

    const finalRun = await getRun(http, started.runId);
    assert.equal(finalRun.status, "succeeded", `run failed: ${JSON.stringify(finalRun.raw)}`);
    const dbFinal = await snapshotWithRetry(ws.dataDir, started.runId);
    assert.ok(dbFinal.view !== null, "store projection must exist");
    assertProjectionMatches(dbFinal.events, dbFinal.view, "store projection vs store events");
    assertViewEqual(finalRun.view, dbFinal.view, "API view vs store projection");
    assert.equal(
      finalRun.view.lastEventId,
      fullIds.at(-1),
      "view head must equal the last event id",
    );

    return {
      runId: started.runId,
      projectId: project.id,
      startBeforeEnd,
      idempotentDuplicate: duplicate.duplicate,
      idempotencyConflict: conflict.status === 409,
      firstConnectionEvents: firstIds.length,
      reconnectedEvents: reconnectedEvents.length,
      totalEvents: fullIds.length,
      snapshotWatermark: snapshot.watermark,
      finalEventId: finalRun.view.lastEventId,
      finalStatus: finalRun.status,
      pages: full.pages,
      requests: http.requests.length,
    };
  } finally {
    for (const runId of runIds) {
      try {
        const snapshot = readStoreSnapshot(ws.dataDir, runId);
        for (const event of snapshot.events) {
          const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
          if (agent !== null) agents.set(agent.pid, agent);
        }
      } catch {
        // The collected SSE evidence remains the cleanup source.
      }
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
  }
}

export async function assertInvalidCursor(http: DevChestraHttp, runId: string): Promise<void> {
  const result = await http.api(
    "GET",
    `/api/runs/${encodeURIComponent(runId)}/stream?after=999999999`,
    { headers: { Accept: "text/event-stream" } },
  );
  assert.equal(result.status, 400, "future cursor must be rejected before streaming");
}

export async function assertEventPagingContract(
  http: DevChestraHttp,
  runId: string,
): Promise<number> {
  const page = await fetchEventPage(http, runId, { after: 0, limit: 5 });
  assert.ok(page.items.length <= 5, "limit must be respected");
  assert.ok(page.watermark >= (page.items.at(-1)?.id ?? 0), "watermark must cover items");
  return page.items.length;
}
