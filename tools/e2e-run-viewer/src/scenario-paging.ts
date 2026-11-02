import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventEnvelope } from "@devchestra/core";
import {
  defaultIdempotencyKey,
  getRun,
  isTerminal,
  registerProject,
  startRun,
  waitTerminal,
} from "./api-ops.js";
import { assertSameIds, assertStrictlyIncreasingIds } from "./compare.js";
import { fetchAllEvents, fetchEventPage } from "./events.js";
import { CLI, makeWorkspace, scriptPath, sleep, writeManyWorkflow } from "./fixtures.js";
import { DevChestraHttp } from "./http.js";
import {
  collectAgent,
  type OwnedServer,
  shutdownOwned,
  startSentinel,
  startServer,
} from "./owned.js";
import { readStoreSnapshot } from "./store-read.js";

export interface PagingEvidence {
  manyRunId: string;
  otherRunId: string;
  totalEvents: number;
  pages: number;
  sawGlobalGaps: boolean;
  maxPageItems: number;
  filteredCompleted: number;
  filteredPath: number;
  futureCursorRejected: number;
  upToRespected: boolean;
  projectPages: number;
  projectPagingOk: boolean;
}

function idsOf(events: readonly EventEnvelope[]): number[] {
  return events.map((event) => event.id);
}

export async function runPagingScenario(): Promise<PagingEvidence> {
  const shellNodes = 75;
  const ws = await makeWorkspace("devchestra-paging-");
  const many = await writeManyWorkflow(ws.projectDir, shellNodes);
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
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);

    const manyStarted = await startRun(http, project.id, {
      workflowFile: many.file,
      params: {},
      idempotencyKey: defaultIdempotencyKey(),
    });
    runIds.push(manyStarted.runId);
    const otherStarted = await startRun(http, project.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "interleave" },
      idempotencyKey: defaultIdempotencyKey(),
    });
    runIds.push(otherStarted.runId);
    assert.notEqual(manyStarted.runId, otherStarted.runId);

    await waitTerminal(http, manyStarted.runId, 120_000);
    await waitTerminal(http, otherStarted.runId, 120_000);

    const firstPage = await fetchEventPage(http, manyStarted.runId, { after: 0, limit: 100 });
    assert.ok(firstPage.items.length <= 100, "limit must cap the page");
    const all = await fetchAllEvents(http, manyStarted.runId, { limit: 100 });
    assert.ok(
      all.events.length > 500,
      `backlog must exceed 500 events, got ${String(all.events.length)}`,
    );
    const ids = idsOf(all.events);
    assertStrictlyIncreasingIds(ids, "paged backlog", true);
    const span = (ids.at(-1) ?? 0) - (ids[0] ?? 0) + 1;
    const sawGlobalGaps = span > ids.length;

    const db = readStoreSnapshot(ws.dataDir, manyStarted.runId);
    assertSameIds(ids, idsOf(db.events), "paged backlog equals the committed SQLite log");

    let pages = 0;
    let maxPageItems = 0;
    let after = 0;
    for (;;) {
      const page = await fetchEventPage(http, manyStarted.runId, { after, limit: 100 });
      pages += 1;
      maxPageItems = Math.max(maxPageItems, page.items.length);
      const pageIds = idsOf(page.items);
      if (pageIds.length > 0) {
        assertStrictlyIncreasingIds(pageIds, `page ${String(pages)}`, true);
        assert.ok((pageIds[0] ?? 0) > after, "page must start strictly after the cursor");
      }
      if (!page.hasMore) break;
      assert.ok(page.nextAfter !== null, "hasMore requires nextAfter");
      if (page.nextAfter !== null && page.nextAfter <= after) {
        throw new Error("pagination cursor did not advance");
      }
      if (page.nextAfter !== null) after = page.nextAfter;
      if (pages > 100) throw new Error("pagination did not terminate");
    }

    const completedPage = await fetchEventPage(http, manyStarted.runId, {
      after: 0,
      limit: 100,
      types: "run.completed",
    });
    assert.equal(completedPage.items.length, 1, "types filter must select run.completed");
    assert.equal(completedPage.items[0]?.type, "run.completed");

    const researchPage = await fetchEventPage(http, otherStarted.runId, {
      after: 0,
      limit: 100,
      pathPrefix: "research",
    });
    assert.ok(researchPage.items.length > 0, "pathPrefix must match research events");
    assert.ok(
      researchPage.items.every((event) => String(event.path).startsWith("research")),
      "pathPrefix must filter by execution path",
    );

    const future = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(manyStarted.runId)}/events?after=999999999`,
    );
    assert.ok([400, 409].includes(future.status), "future cursor must be rejected");

    const upTo = (ids[0] ?? 0) + 20;
    const bounded = await fetchEventPage(http, manyStarted.runId, { after: 0, limit: 10, upTo });
    assert.ok(
      bounded.items.every((event) => event.id <= upTo),
      "upTo must be an inclusive upper bound",
    );

    for (const runId of runIds) {
      const snapshot = readStoreSnapshot(ws.dataDir, runId);
      for (const event of snapshot.events) {
        const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
        if (agent !== null) agents.set(agent.pid, agent);
      }
    }

    for (const name of ["proj-b", "proj-c"]) {
      const path = join(ws.root, name);
      await mkdir(path, { recursive: true });
      await registerProject(http, path);
    }
    const projectsFirst = await http.api("GET", "/api/projects?limit=2");
    assert.equal(projectsFirst.status, 200, "project list must page");
    const firstName = projectsFirst.body as {
      items?: Array<{ id?: string }>;
      nextCursor?: string | null;
    };
    assert.equal(firstName.items?.length, 2);
    assert.ok(firstName.nextCursor !== null && firstName.nextCursor !== undefined);
    const projectsSecond = await http.api(
      "GET",
      `/api/projects?limit=2&cursor=${encodeURIComponent(firstName.nextCursor as string)}`,
    );
    assert.equal(projectsSecond.status, 200);
    const secondName = projectsSecond.body as { items?: Array<{ id?: string }> };
    const firstIds = (firstName.items ?? []).map((item) => item.id);
    const secondIds = (secondName.items ?? []).map((item) => item.id);
    assert.ok(secondIds.length > 0, "project page 2 must not be empty");
    assert.ok(
      secondIds.every((id) => !firstIds.includes(id)),
      "project cursor must not duplicate rows",
    );
    const malformedCursor = await http.api("GET", "/api/projects?cursor=not-a-cursor");
    assert.equal(malformedCursor.status, 400, "malformed project cursor must be rejected");
    for (const limit of ["0", "501"]) {
      const badLimit = await http.api("GET", `/api/projects?limit=${limit}`);
      assert.equal(badLimit.status, 400, `project limit ${limit} must be rejected`);
    }

    const final = await getRun(http, manyStarted.runId);
    assert.ok(isTerminal(final.status), "many run must be terminal");
    return {
      manyRunId: manyStarted.runId,
      otherRunId: otherStarted.runId,
      totalEvents: ids.length,
      pages,
      sawGlobalGaps,
      maxPageItems,
      filteredCompleted: completedPage.items.length,
      filteredPath: researchPage.items.length,
      futureCursorRejected: future.status,
      upToRespected: bounded.items.every((event) => event.id <= upTo),
      projectPages: 2,
      projectPagingOk: true,
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
        // Best-effort.
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

export async function waitForTerminalOrFail(
  http: DevChestraHttp,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(http, runId);
    if (isTerminal(run.status)) return;
    if (Date.now() >= deadline) throw new Error(`run ${runId} stayed ${run.status}`);
    await sleep(50);
  }
}
