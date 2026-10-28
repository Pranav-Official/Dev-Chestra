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

const FIX = join(import.meta.dirname, "fixtures/p3-5-approval/workflows");
const FAKE = join(import.meta.dirname, "fixtures/p3-5-approval/scripts/fake-approval.json");
let preserve = false;
afterEach((c) => {
  const s = (c as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (s !== "pass") preserve = true;
});
afterAll(() => {
  if (preserve) {
    process.stderr.write("p3.5 recovery retained roots\n");
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
function raiseCleanup(failure: unknown, failures: unknown[], label: string): void {
  if (failure !== undefined && failures.length > 0)
    throw new AggregateError([failure, ...failures], `${label} cleanup`);
  if (failure !== undefined) throw failure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup`);
}
function eventsOf(
  page: { events: Array<{ type: string; payload: unknown; path: string }> },
  type: string,
) {
  return page.events.filter((e) => e.type === type);
}
const RESOLVE = (runId: string, path: string) =>
  `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(path)}/resolve`;
const INBOX = "/api/approvals";
async function resolveApproval(
  http: DevChestraHttp,
  runId: string,
  path: string,
  body: Record<string, unknown>,
) {
  return http.api("POST", RESOLVE(runId, path), { body });
}
function approvalRequested(page: {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}) {
  return eventsOf(page as never, "approval.requested")[0]?.payload as
    | Record<string, unknown>
    | undefined;
}
async function getInboxRequestId(
  http: DevChestraHttp,
  runId: string,
  path: string,
): Promise<string> {
  const inbox = await http.api("GET", INBOX);
  assert.equal(inbox.status, 200, `GET ${INBOX} must be 200: ${inbox.text.slice(0, 600)}`);
  const body = inbox.body as { items: Array<{ runId: string; path: string; requestId: string }> };
  assert.ok(Array.isArray(body.items), "inbox must return items array");
  const found = body.items.find((it) => it.runId === runId && it.path === path);
  if (found) {
    const rid = found.requestId;
    assert.ok(
      typeof rid === "string" && rid.length > 0,
      `inbox entry must carry requestId: ${JSON.stringify(found).slice(0, 600)}`,
    );
    return rid as string;
  }
  const page = await readEventPage(http, runId);
  const payload = approvalRequested(page as never);
  assert.ok(payload, "approval.requested must exist");
  const rid2 = (payload as Record<string, unknown>).requestId;
  assert.ok(
    typeof rid2 === "string" && (rid2 as string).length > 0,
    `payload must carry requestId: ${JSON.stringify(payload).slice(0, 600)}`,
  );
  return rid2 as string;
}

describe("P3.5 approval recovery — durable, lost-wake, no broad scan", () => {
  it("lost-wake: close/restart while waiting then resolve", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-lost-");
    const dataDir = tempRoot("devchestra-p35-lost-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let runId = "";
    let sentinel = startSentinel();
    let first: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail: unknown;
    try {
      first = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(first.baseUrl);
      await http.health();
      await http.bootstrap(first.meta.token);
      const m = await manage(http, ws.root, "p3-5-approval-simple");
      const st = await startManaged(http, m as never);
      assert.equal(st.status, 202, st.text.slice(0, 800));
      runId = String(st.body.runId);
      for (let i = 0; i < 40; i += 1) {
        const p = await readEventPage(http, runId);
        if (eventsOf(p as never, "approval.requested").length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await first.stop();
    } catch (e) {
      fail = e;
    }
    const c1 = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(fail, c1, "cleanup1");
    sentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail2: unknown;
    try {
      second = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      const inbox = await http.api("GET", INBOX);
      assert.equal(
        inbox.status,
        200,
        `inbox after restart must be 200: ${inbox.text.slice(0, 600)}`,
      );
      assert.ok(String(inbox.text).includes(runId), "inbox still pending after restart");
      const pending = await readEventPage(http, runId);
      assert.equal(eventsOf(pending as never, "approval.requested").length, 1);
      assert.equal(eventsOf(pending as never, "approval.resolved").length, 0);
      const req = approvalRequested(pending as never) as
        | { attempt?: number; generation?: number }
        | undefined;
      assert.ok(req?.attempt !== undefined);
      const ridAfter = await getInboxRequestId(http, runId, "a");
      const r = await resolveApproval(http, runId, "a", {
        requestId: ridAfter,
        expectedAttempt: req?.attempt,
        expectedGeneration: req?.generation,
        decision: "approve",
        note: "ok",
      });
      assert.ok([200, 202].includes(r.status), r.text.slice(0, 600));
      for (let i = 0; i < 60; i += 1) {
        const d = await runDetail(http, runId);
        if (String((d as unknown as { status: string }).status) === "succeeded") break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const fin = await runDetail(http, runId);
      assert.equal(String((fin as unknown as { status: string }).status), "succeeded");
    } catch (e) {
      fail2 = e;
    }
    const c2 = await cleanupRestarted(second, dataDir, sentinel, { keep: false });
    raiseCleanup(fail2, c2, "cleanup2");
    cleanupTempRoots();
  }, 300_000);

  it("approval startup does not auto-resume unrelated crashed/uncertain-shell runs", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-unrelated-");
    const dataDir = tempRoot("devchestra-p35-unrelated-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let approvalRunId = "";
    let shellRunId = "";
    let shellProjectId = "";
    let sentinel = startSentinel();
    let first: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail: unknown;
    try {
      first = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(first.baseUrl);
      await http.health();
      await http.bootstrap(first.meta.token);
      const m1 = await manage(http, ws.root, "p3-5-approval-simple");
      const st1 = await startManaged(http, m1 as never);
      assert.equal(st1.status, 202);
      approvalRunId = String(st1.body.runId);
      shellProjectId = m1.projectId;
      for (let i = 0; i < 40; i += 1) {
        const p = await readEventPage(http, approvalRunId);
        if (eventsOf(p as never, "approval.requested").length) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const shellFile = load("p3-5-shell-only");
      await createWorkflow(http, shellProjectId, {
        name: shellFile.name,
        id: shellFile.id,
        template: "blank",
      });
      const blank2 = await getWorkflow(http, shellProjectId, shellFile.id);
      const saved2 = await saveWorkflow(http, shellProjectId, shellFile.id, shellFile, blank2.etag);
      assert.ok(
        saved2.validation.ok,
        `shell-only validate ${JSON.stringify(saved2.validation).slice(0, 800)}`,
      );
      const etag2 = saved2.etag;
      const shellStart = await http.api(
        "POST",
        `/api/projects/${encodeURIComponent(shellProjectId)}/workflows/${encodeURIComponent(shellFile.id)}/runs`,
        { body: { etag: etag2 } },
      );
      assert.equal(shellStart.status, 202, shellStart.text.slice(0, 800));
      shellRunId = String((shellStart.body as Record<string, unknown>).runId);
      let spawnedBeforeStop = false;
      for (let i = 0; i < 60; i += 1) {
        const ev = await readEventPage(http, shellRunId);
        if (eventsOf(ev as never, "node.process.spawned").some((e) => e.path === "sh")) {
          spawnedBeforeStop = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(spawnedBeforeStop, "shell process must have spawned before stop - poll failed");
      await first.stop();
    } catch (e) {
      fail = e;
    }
    const c1 = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(fail, c1, "unrelated cleanup1");
    sentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail2: unknown;
    try {
      second = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      const detA = await runDetail(http, approvalRunId);
      assert.equal(
        detA.status,
        "waiting_approval",
        `approval run must be waiting_approval, got ${detA.status} ${JSON.stringify(detA.raw).slice(0, 800)}`,
      );
      const inbox = await http.api("GET", INBOX);
      assert.equal(inbox.status, 200);
      assert.ok(
        String(inbox.text).includes(approvalRunId),
        "approval inbox still shows waiting run",
      );
      assert.equal(
        String(inbox.text).includes(shellRunId),
        false,
        "shell run must not appear in approval inbox",
      );
      const detS = await runDetail(http, shellRunId);
      const sStatus = detS.status;
      assert.equal(
        sStatus,
        "paused",
        `shell run must be paused after crash, got ${sStatus} ${JSON.stringify(detS).slice(0, 800)}`,
      );
      const sPause = (detS.raw as { view: { pauseReason?: string } }).view?.pauseReason;
      assert.equal(
        sPause,
        "uncertain_side_effect",
        `shell pauseReason must be uncertain_side_effect, got ${String(sPause)}`,
      );
      const evS = await readEventPage(http, shellRunId);
      assert.equal(
        eventsOf(evS as never, "approval.requested").length,
        0,
        "shell run must not gain approval events via broad scan",
      );
    } catch (e) {
      fail2 = e;
    }
    const c2 = await cleanupRestarted(second, dataDir, sentinel, { keep: false });
    raiseCleanup(fail2, c2, "unrelated cleanup2");
    cleanupTempRoots();
  }, 360_000);

  it("approve then shell interrupted honors uncertain pause, not auto-dispatched", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-approve-shell-");
    const dataDir = tempRoot("devchestra-p35-approve-shell-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let runId = "";
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
      const m = await manage(http, ws.root, "p3-5-approval-shell");
      const st = await startManaged(http, m as never);
      assert.equal(st.status, 202, st.text.slice(0, 800));
      runId = String(st.body.runId);
      for (let i = 0; i < 60; i += 1) {
        const p = await readEventPage(http, runId);
        if (eventsOf(p as never, "approval.requested").length) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const req = approvalRequested((await readEventPage(http, runId)) as never) as
        | { attempt?: number; generation?: number }
        | undefined;
      assert.ok(req?.attempt !== undefined);
      attempt = req?.attempt as number;
      generation = req?.generation as number;
      const ridShell = await getInboxRequestId(http, runId, "a");
      const res = await resolveApproval(http, runId, "a", {
        requestId: ridShell,
        expectedAttempt: attempt,
        expectedGeneration: generation,
        decision: "approve",
      });
      assert.ok([200, 202].includes(res.status), res.text.slice(0, 600));
      let spawnedBeforeStop2 = false;
      for (let i = 0; i < 80; i += 1) {
        const ev = await readEventPage(http, runId);
        if (eventsOf(ev as never, "node.process.spawned").some((e) => e.path === "sh")) {
          spawnedBeforeStop2 = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(spawnedBeforeStop2, "shell must have spawned before stop after approve");
      await first.stop();
    } catch (e) {
      fail = e;
    }
    const c1 = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(fail, c1, "approve-shell cleanup1");
    sentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail2: unknown;
    try {
      second = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      const det = await runDetail(http, runId);
      const stt = String(det.status ?? (det as unknown as { status: string }).status);
      assert.equal(
        stt,
        "paused",
        `expected paused uncertain after crash, got ${stt} ${JSON.stringify(det).slice(0, 800)}`,
      );
      const pauseReason2 = (det.raw as { view: { pauseReason?: string } }).view?.pauseReason;
      assert.equal(pauseReason2, "uncertain_side_effect");
      const inbox = await http.api("GET", INBOX);
      assert.equal(inbox.status, 200);
      assert.equal(
        String(inbox.text).includes(runId),
        false,
        "approved run with shell interrupted must not stay in approval inbox",
      );
      const ev = await readEventPage(http, runId);
      assert.equal(eventsOf(ev as never, "approval.resolved").length, 1);
      assert.equal(
        eventsOf(ev as never, "node.process.spawned").filter((e) => e.path === "sh").length,
        1,
        "shell must not be re-spawned automatically",
      );
    } catch (e) {
      fail2 = e;
    }
    const c2 = await cleanupRestarted(second, dataDir, sentinel, { keep: false });
    raiseCleanup(fail2, c2, "approve-shell cleanup2");
    cleanupTempRoots();
  }, 360_000);
});
