import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { cleanupRestarted, readEventPage, runDetail } from "./support/run-workspace-harness.js";

const FIX = join(import.meta.dirname, "fixtures/approval/workflows");
const FAKE = join(import.meta.dirname, "fixtures/approval/scripts/fake-approval.json");
let preserve = false;
afterEach((c) => {
  const s = (c as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (s !== "pass") preserve = true;
});
afterAll(() => {
  if (preserve) {
    process.stderr.write("deterministic retained roots\n");
    return;
  }
  cleanupTempRoots();
});
function load(n: string): WorkflowFileLike {
  return JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8")) as WorkflowFileLike;
}
async function manage(http: DevChestraHttp, root: string, name: string) {
  const file = load(name);
  const p = await registerProject(http, root);
  await createWorkflow(http, p.id, { name: file.name, id: file.id, template: "blank" });
  const blank = await getWorkflow(http, p.id, file.id);
  const saved = await saveWorkflow(http, p.id, file.id, file, blank.etag);
  assert.ok(
    saved.validation.ok,
    `${name} validate ${JSON.stringify(saved.validation).slice(0, 800)}`,
  );
  return { projectId: p.id, workflowId: saved.id, etag: saved.etag };
}
async function startManaged(
  http: DevChestraHttp,
  m: { projectId: string; workflowId: string; etag: string },
) {
  const r = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(m.projectId)}/workflows/${encodeURIComponent(m.workflowId)}/runs`,
    { body: { etag: m.etag } },
  );
  return { status: r.status, text: r.text, body: r.body as Record<string, unknown> };
}
function eventsOf(
  page: { events: Array<{ type: string; payload: unknown; path: string }> },
  type: string,
) {
  return page.events.filter((e) => e.type === type);
}
function raiseCleanup(failure: unknown, failures: unknown[], label: string): void {
  if (failure !== undefined && failures.length > 0)
    throw new AggregateError([failure, ...failures], `${label} cleanup`);
  if (failure !== undefined) throw failure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup`);
}

describe("deterministic crash-window — no-subscriber store resolve", () => {
  it("stops while waiting, resolves via direct store with no engine, restarts and auto-continues without resume", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-deterministic-");
    const dataDir = tempRoot("devchestra-p35-deterministic-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let runId = "";
    let requestId = "";
    let attempt = 0;
    let generation = 0;
    let sentinel = startSentinel();
    let first: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail: unknown;
    try {
      first = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(first.baseUrl);
      await http.health();
      await http.bootstrap(first.meta.token);
      const m = await manage(http, ws.root, "approval-simple");
      const st = await startManaged(http, m as never);
      assert.equal(st.status, 202, st.text.slice(0, 800));
      runId = String(st.body.runId);
      for (let i = 0; i < 60; i += 1) {
        const p = await readEventPage(http, runId);
        if (eventsOf(p as never, "approval.requested").length) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const page = await readEventPage(http, runId);
      assert.equal(eventsOf(page as never, "approval.requested").length, 1, "must be waiting");
      // Capture opaque identity from store view is more reliable, but HTTP inbox also proves string; capture via HTTP first then stop
      const inbox = await http.api("GET", "/api/approvals");
      assert.equal(inbox.status, 200);
      const inboxBody = inbox.body as {
        items: Array<{ runId: string; path: string; requestId: string }>;
      };
      assert.ok(Array.isArray(inboxBody.items), "inbox must return items array");
      const entry = inboxBody.items.find((it) => it.runId === runId && it.path === "a");
      assert.ok(entry, "inbox must contain pending approval");
      assert.ok(
        typeof entry.requestId === "string" && entry.requestId.length > 0,
        `inbox requestId must be non-empty string: ${JSON.stringify(entry).slice(0, 600)}`,
      );
      requestId = entry.requestId;
      // Also capture attempt/generation from event payload for cross-check
      const detail = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      void detail;
      // Stop test-owned server while still waiting — deterministic crash window, no resolve yet
      await first.stop();
      // Re-derive attempt/generation from persisted store view while server is stopped
      const dbFile = join(dataDir, "devchestra.db");
      const { openStore: openStoreTmp } = (await import(
        "../../../packages/store/dist/index.js" as string
      )) as unknown as {
        openStore: (opts: {
          file: string;
        }) => import("../../../packages/store/dist/index.js").Store;
      };
      const tmpStore = openStoreTmp({ file: dbFile });
      try {
        const view = tmpStore.view.get(runId as never);
        const exec = view.executions.a;
        assert.ok(exec, "execution a must exist");
        assert.equal(exec.status, "waiting_approval", "must still be waiting after stop");
        assert.ok(exec.approvalRequest, "approvalRequest must be durable");
        assert.equal(exec.approvalRequest.requestId, requestId, "requestId must match inbox");
        const req = exec.approvalRequest;
        assert.ok(typeof req.attempt === "number" && typeof req.generation === "number");
        attempt = req.attempt;
        generation = req.generation;
        assert.ok(typeof attempt === "number" && typeof generation === "number");
        // No engine subscriber is running — perform canonical store resolve directly
        const result = tmpStore.approvals.resolve({
          identity: { runId: runId as never, path: "a" as never, attempt, generation },
          requestId,
          decision: "approve",
          by: "deterministic-fixture",
        });
        assert.equal(result.duplicate, false, "first direct resolve must not be duplicate");
        assert.ok(result.resolvedEventId !== null, "resolvedEventId must exist");
        // Verify durable event and outstanding wake, and zero downstream spawn while no engine
        const after = tmpStore.view.get(runId as never);
        assert.equal(
          after.executions.a?.status,
          "succeeded",
          "approval must be succeeded after direct resolve even with no engine",
        );
        const wakes = tmpStore.approvals.listOutstandingWakes(runId as never);
        assert.equal(wakes.length, 1, "outstanding wake must be present");
        assert.equal(wakes[0]?.requestId, requestId);
        const page2 = tmpStore.events.page(runId as never, {});
        const spawned = page2.items.filter(
          (e: { type: string; path: string }) =>
            e.type === "node.process.spawned" && e.path === "agent_a",
        );
        assert.equal(spawned.length, 0, "no downstream agent spawn while no engine subscriber");
        const resolvedEvents = page2.items.filter(
          (e: { type: string }) => e.type === "approval.resolved",
        );
        assert.equal(resolvedEvents.length, 1, "exactly one approval.resolved durable");
      } finally {
        tmpStore.close();
      }
    } catch (e) {
      fail = e;
    }
    const c1 = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(fail, c1, "deterministic");
    sentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail2: unknown;
    try {
      second = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      // Restart must auto-continue via outstanding wake without calling POST /resume or second resolve
      for (let i = 0; i < 80; i += 1) {
        const d = await runDetail(http, runId);
        const stt = String((d as unknown as { status: string }).status);
        if (stt === "succeeded") break;
        if (stt === "failed" || stt === "rejected")
          throw new Error(`unexpected terminal ${stt}: ${JSON.stringify(d).slice(0, 800)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      const fin = await runDetail(http, runId);
      assert.equal(
        String((fin as unknown as { status: string }).status),
        "succeeded",
        "must auto-continue after deterministic direct resolve",
      );
      const finalPage = await readEventPage(http, runId);
      assert.equal(
        eventsOf(finalPage as never, "approval.resolved").length,
        1,
        "no duplicate resolved after restart",
      );
      assert.equal(
        eventsOf(finalPage as never, "approval.requested").length,
        1,
        "exactly one request",
      );
      const inboxAfter = await http.api("GET", "/api/approvals");
      assert.equal(inboxAfter.status, 200);
      assert.equal(
        String(inboxAfter.text).includes(runId),
        false,
        "must leave inbox after success",
      );
      // Verify wake was consumed
      const dbFile2 = join(dataDir, "devchestra.db");
      const { openStore: openStoreCheck } = (await import(
        "../../../packages/store/dist/index.js" as string
      )) as unknown as {
        openStore: (opts: {
          file: string;
        }) => import("../../../packages/store/dist/index.js").Store;
      };
      const checkStore = openStoreCheck({ file: dbFile2 });
      try {
        const wakesAfter = checkStore.approvals.listOutstandingWakes(runId as never);
        assert.equal(wakesAfter.length, 0, "wake must be consumed after engine dispatch");
      } finally {
        checkStore.close();
      }
    } catch (e) {
      fail2 = e;
    }
    const c2 = await cleanupRestarted(second, dataDir, sentinel, { keep: false });
    raiseCleanup(fail2, c2, "deterministic");
    cleanupTempRoots();
  }, 360_000);
});
