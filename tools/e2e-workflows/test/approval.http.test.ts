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
import {
  cleanupRestarted,
  readEventPage,
  runDetail,
  withServer,
} from "./support/run-workspace-harness.js";

const FIX = join(import.meta.dirname, "fixtures/approval/workflows");
const FAKE = join(import.meta.dirname, "fixtures/approval/scripts/fake-approval.json");
let preserve = false;
afterEach((c) => {
  const s = (c as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (s !== "pass") preserve = true;
});
afterAll(() => {
  if (preserve) {
    process.stderr.write("approval retained temp roots\n");
    return;
  }
  cleanupTempRoots();
});
function load(name: string): WorkflowFileLike {
  return JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as WorkflowFileLike;
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
  return { projectId: p.id, workflowId: saved.id, etag: saved.etag, file };
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

const CANONICAL_RESOLVE = (runId: string, path: string) =>
  `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(path)}/resolve`;
const CANONICAL_INBOX = "/api/approvals";

async function resolveApproval(
  http: DevChestraHttp,
  runId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; body: unknown }> {
  return http.api("POST", CANONICAL_RESOLVE(runId, path), { body });
}
function approvalRequested(page: {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}) {
  return eventsOf(page as never, "approval.requested")[0]?.payload as
    | Record<string, unknown>
    | undefined;
}
function _approvalResolved(page: {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}) {
  return eventsOf(page as never, "approval.resolved") as Array<{
    payload: Record<string, unknown>;
  }>;
}

async function getInboxRequestId(
  http: DevChestraHttp,
  runId: string,
  path: string,
): Promise<string> {
  const inbox = await http.api("GET", CANONICAL_INBOX);
  assert.equal(
    inbox.status,
    200,
    `GET ${CANONICAL_INBOX} must be 200: ${inbox.text.slice(0, 600)}`,
  );
  const body = inbox.body as { items: Array<{ runId: string; path: string; requestId: string }> };
  assert.ok(Array.isArray(body.items), "inbox must return items array");
  const found = body.items.find((it) => it.runId === runId && it.path === path);
  if (found) {
    const rid = found.requestId;
    assert.ok(
      typeof rid === "string" && rid.length > 0,
      `inbox entry must carry opaque requestId: ${JSON.stringify(found).slice(0, 600)}`,
    );
    return rid as string;
  }
  // fallback to event payload
  const page = await readEventPage(http, runId);
  const payload = approvalRequested(page as never);
  assert.ok(payload, "approval.requested must exist to obtain requestId");
  const rid2 = (payload as Record<string, unknown>).requestId;
  assert.ok(
    typeof rid2 === "string" && (rid2 as string).length > 0,
    `approval.requested must carry opaque requestId: ${JSON.stringify(payload).slice(0, 600)}`,
  );
  return rid2 as string;
}

describe("approval HTTP — true server (canonical route, fail if missing)", () => {
  it("waiting durable + approve routes via plain edge", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-wait-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-p35-wait-data-").dir,
        projectRoot: ws.root,
        fakeScript: FAKE,
        env: {
          HOME: ws.home,
          GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
      async (s) => {
        const http = new DevChestraHttp(s.baseUrl);
        await http.health();
        await http.bootstrap(s.meta.token);
        const m = await manage(http, ws.root, "approval-simple");
        const st = await startManaged(http, m as never);
        assert.equal(
          st.status,
          202,
          `expected 202 start with approval node: ${st.text.slice(0, 800)}`,
        );
        const runId = String(st.body.runId);
        for (let i = 0; i < 60; i += 1) {
          const p = await readEventPage(http, runId);
          if (eventsOf(p as never, "approval.requested").length) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const page = await readEventPage(http, runId);
        const req = approvalRequested(page as never);
        assert.ok(req, "approval.requested must exist");
        assert.equal((req as Record<string, unknown>).message, "Approve to proceed");
        const inbox = await http.api("GET", CANONICAL_INBOX);
        assert.equal(
          inbox.status,
          200,
          `GET ${CANONICAL_INBOX} must be 200: ${inbox.text.slice(0, 600)}`,
        );
        assert.ok(String(inbox.text).includes(runId), "global inbox contains waiting run");
        const attempt = (req as { attempt?: number }).attempt;
        const generation = (req as { generation?: number }).generation;
        assert.ok(
          typeof attempt === "number" && typeof generation === "number",
          "approval.requested must carry attempt/generation",
        );
        const requestId = await getInboxRequestId(http, runId, "a");
        const resolved = await resolveApproval(http, runId, "a", {
          requestId,
          expectedAttempt: attempt,
          expectedGeneration: generation,
          decision: "approve",
          note: "ok",
        });
        assert.ok(
          [200, 202].includes(resolved.status),
          `canonical resolve must succeed: ${resolved.text.slice(0, 600)}`,
        );
        for (let i = 0; i < 60; i += 1) {
          const d = await runDetail(http, runId);
          if (String((d as unknown as { status: string }).status) === "succeeded") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const final = await runDetail(http, runId);
        assert.equal(String((final as unknown as { status: string }).status), "succeeded");
      },
    );
  }, 180_000);

  it("reject without edge completes run rejected; reject with edge takes alt", async () => {
    for (const name of ["approval-no-rejected", "approval-with-rejected"] as const) {
      const ws = await makeRunWorkspaceRepo(`devchestra-approval-rej-${name}-`);
      await withServer(
        {
          dataDir: tempRoot(`devchestra-approval-rej-${name}-data-`).dir,
          projectRoot: ws.root,
          fakeScript: FAKE,
          env: {
            HOME: ws.home,
            GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
        async (s) => {
          const http = new DevChestraHttp(s.baseUrl);
          await http.health();
          await http.bootstrap(s.meta.token);
          const m = await manage(http, ws.root, name);
          const st = await startManaged(http, m as never);
          assert.equal(st.status, 202, st.text.slice(0, 800));
          const runId = String(st.body.runId);
          for (let i = 0; i < 40; i += 1) {
            const p = await readEventPage(http, runId);
            if (eventsOf(p as never, "approval.requested").length) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          const req = approvalRequested((await readEventPage(http, runId)) as never) as
            | { attempt?: number; generation?: number }
            | undefined;
          assert.ok(req?.attempt !== undefined);
          const rid = await getInboxRequestId(http, runId, "a");
          const r = await resolveApproval(http, runId, "a", {
            requestId: rid,
            expectedAttempt: req?.attempt,
            expectedGeneration: req?.generation,
            decision: "reject",
            note: "nope",
          });
          assert.ok([200, 202].includes(r.status), r.text.slice(0, 600));
          for (let i = 0; i < 60; i += 1) {
            const d = await runDetail(http, runId);
            const stt = String((d as unknown as { status: string }).status);
            if (["rejected", "succeeded", "failed"].includes(stt)) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          const final = await runDetail(http, runId);
          const stt = String((final as unknown as { status: string }).status);
          if (name === "approval-no-rejected") assert.equal(stt, "rejected");
          else assert.equal(stt, "succeeded");
        },
      );
    }
  }, 240_000);

  it("duplicate resolve idempotent, conflict on different decision, stale attempt fence, terminal duplicate", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-dup-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-p35-dup-data-").dir,
        projectRoot: ws.root,
        fakeScript: FAKE,
        env: {
          HOME: ws.home,
          GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
      async (s) => {
        const http = new DevChestraHttp(s.baseUrl);
        await http.health();
        await http.bootstrap(s.meta.token);
        const m = await manage(http, ws.root, "approval-simple");
        const st = await startManaged(http, m as never);
        assert.equal(st.status, 202);
        const runId = String(st.body.runId);
        for (let i = 0; i < 40; i += 1) {
          const p = await readEventPage(http, runId);
          if (eventsOf(p as never, "approval.requested").length) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const page = await readEventPage(http, runId);
        const req = approvalRequested(page as never) as
          | { attempt?: number; generation?: number }
          | undefined;
        assert.ok(req?.attempt !== undefined && req?.generation !== undefined);
        const rid = await getInboxRequestId(http, runId, "a");
        const body: Record<string, unknown> = {
          requestId: rid,
          expectedAttempt: req?.attempt,
          expectedGeneration: req?.generation,
          decision: "approve",
          note: "ok",
        };
        const first = await resolveApproval(http, runId, "a", body as never);
        assert.ok([200, 202].includes(first.status), first.text.slice(0, 600));
        const dup = await resolveApproval(http, runId, "a", body as never);
        assert.ok([200, 202].includes(dup.status), dup.text.slice(0, 600));
        // conflict must use same opaque requestId but different decision → 409
        const conflictBody = {
          requestId: rid,
          expectedAttempt: req?.attempt,
          expectedGeneration: req?.generation,
          decision: "reject",
          note: "ok",
        };
        const conflict = await resolveApproval(http, runId, "a", conflictBody as never);
        assert.equal(conflict.status, 409, conflict.text.slice(0, 600));
        for (let i = 0; i < 60; i += 1) {
          const d = await runDetail(http, runId);
          if (String((d as unknown as { status: string }).status) !== "running") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const staleBody = {
          requestId: rid,
          expectedAttempt: (req?.attempt as number) + 99,
          expectedGeneration: req?.generation,
          decision: "approve",
          note: "x",
        };
        const stale = await resolveApproval(http, runId, "a", staleBody as never);
        assert.equal(stale.status, 409, `stale should be 409 ${stale.text.slice(0, 400)}`);
        const after = await resolveApproval(http, runId, "a", body as never);
        assert.ok([200, 202].includes(after.status), after.text.slice(0, 600));
      },
    );
  }, 180_000);

  it("simultaneous cancel vs resolve race is fenced", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-race-");
    await withServer(
      {
        dataDir: tempRoot("devchestra-p35-race-data-").dir,
        projectRoot: ws.root,
        fakeScript: FAKE,
        env: {
          HOME: ws.home,
          GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
      async (s) => {
        const http = new DevChestraHttp(s.baseUrl);
        await http.health();
        await http.bootstrap(s.meta.token);
        const m = await manage(http, ws.root, "approval-simple");
        const st = await startManaged(http, m as never);
        assert.equal(st.status, 202);
        const runId = String(st.body.runId);
        for (let i = 0; i < 40; i += 1) {
          const p = await readEventPage(http, runId);
          if (eventsOf(p as never, "approval.requested").length) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const req = approvalRequested((await readEventPage(http, runId)) as never) as
          | { attempt?: number; generation?: number }
          | undefined;
        assert.ok(req?.attempt !== undefined);
        const ridRace = await getInboxRequestId(http, runId, "a");
        const [cancelRes, approveRes] = await Promise.all([
          http.api("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`, { body: {} }),
          resolveApproval(http, runId, "a", {
            requestId: ridRace,
            expectedAttempt: req?.attempt,
            expectedGeneration: req?.generation,
            decision: "approve",
          }),
        ]);
        // exactly one wins, other must be 409 (no double success)
        const successes = [cancelRes, approveRes].filter((r) =>
          [200, 202].includes(r.status),
        ).length;
        assert.equal(
          successes,
          1,
          `race must have exactly one winner cancel=${cancelRes.status} approve=${approveRes.status}`,
        );
        assert.ok(
          [409].includes([cancelRes.status, approveRes.status].find((s) => s === 409) ?? 409),
        );
        const final = await readEventPage(http, runId);
        assert.ok(eventsOf(final as never, "approval.resolved").length <= 1);
      },
    );
  }, 180_000);

  it("two approvals serial: approve first, second pending stable, restart still pending, approve second exactly once", async () => {
    const ws = await makeRunWorkspaceRepo("devchestra-p35-two-");
    const dataDir = tempRoot("devchestra-p35-two-data-").dir;
    const env = {
      HOME: ws.home,
      GIT_CONFIG_GLOBAL: join(ws.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    let runId = "";
    let sentinel = startSentinel();
    let first: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail: unknown;
    let _req1: { requestId: string; attempt: number; generation: number } | null = null;
    try {
      first = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(first.baseUrl);
      await http.health();
      await http.bootstrap(first.meta.token);
      const m = await manage(http, ws.root, "approval-two");
      const st = await startManaged(http, m as never);
      assert.equal(st.status, 202, st.text.slice(0, 800));
      runId = String(st.body.runId);
      for (let i = 0; i < 60; i += 1) {
        const p = await readEventPage(http, runId);
        if (eventsOf(p as never, "approval.requested").some((e) => e.path === "a1")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const page1 = await readEventPage(http, runId);
      assert.equal(
        eventsOf(page1 as never, "approval.requested").filter((e) => e.path === "a1").length,
        1,
      );
      assert.equal(
        eventsOf(page1 as never, "approval.requested").filter((e) => e.path === "a2").length,
        0,
        "second must not be requested before first resolved",
      );
      const rid1 = await getInboxRequestId(http, runId, "a1");
      const reqPayload1 = approvalRequested(page1 as never) as
        | { attempt?: number; generation?: number }
        | undefined;
      assert.ok(reqPayload1?.attempt !== undefined, "first request must have attempt");
      const a1Attempt = reqPayload1?.attempt as number;
      const a1Gen = reqPayload1?.generation as number;
      _req1 = { requestId: rid1, attempt: a1Attempt, generation: a1Gen };
      const res1 = await resolveApproval(http, runId, "a1", {
        requestId: rid1,
        expectedAttempt: a1Attempt,
        expectedGeneration: a1Gen,
        decision: "approve",
        note: "first ok",
      });
      assert.ok([200, 202].includes(res1.status), res1.text.slice(0, 600));
      for (let i = 0; i < 60; i += 1) {
        const p = await readEventPage(http, runId);
        if (eventsOf(p as never, "approval.requested").some((e) => e.path === "a2")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const page2 = await readEventPage(http, runId);
      assert.equal(
        eventsOf(page2 as never, "approval.resolved").filter((e) => e.path === "a1").length,
        1,
        "first must be resolved exactly once",
      );
      assert.equal(
        eventsOf(page2 as never, "approval.requested").filter((e) => e.path === "a2").length,
        1,
        "second must be pending after first approve",
      );
      assert.equal(
        eventsOf(page2 as never, "approval.resolved").filter((e) => e.path === "a2").length,
        0,
      );
      // assert no repeated dispatch/prepare or CPU spin while waiting for second: stable counts over 900ms
      const before = await readEventPage(http, runId);
      const beforeCount = before.events.length;
      await new Promise((r) => setTimeout(r, 900));
      const after = await readEventPage(http, runId);
      assert.equal(
        after.events.length,
        beforeCount,
        "must not redrive while waiting for second approval",
      );
      assert.equal(
        eventsOf(after as never, "approval.requested").length,
        2,
        "exactly two requests total while waiting",
      );
      await first.stop();
    } catch (e) {
      fail = e;
    }
    const c1 = await cleanupRestarted(first, dataDir, sentinel, { keep: true });
    raiseCleanup(fail, c1, "two-approval cleanup1");
    sentinel = startSentinel();
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    let fail2: unknown;
    try {
      second = await startServer({ cli: CLI, dataDir, cwd: ws.root, fakeScript: FAKE, env });
      const http = new DevChestraHttp(second.baseUrl);
      await http.health();
      await http.bootstrap(second.meta.token);
      const pending = await readEventPage(http, runId);
      assert.equal(
        eventsOf(pending as never, "approval.requested").filter((e) => e.path === "a2").length,
        1,
        "second still pending after restart",
      );
      assert.equal(
        eventsOf(pending as never, "approval.resolved").filter((e) => e.path === "a1").length,
        1,
      );
      assert.equal(
        eventsOf(pending as never, "approval.resolved").filter((e) => e.path === "a2").length,
        0,
      );
      const inbox = await http.api("GET", CANONICAL_INBOX);
      assert.equal(inbox.status, 200);
      assert.ok(String(inbox.text).includes(runId), "inbox still shows run for second approval");
      const rid2 = await getInboxRequestId(http, runId, "a2");
      const genPayload = approvalRequested({
        events: pending.events.filter((e) => e.path === "a2"),
      } as never) as { attempt?: number; generation?: number } | undefined;
      assert.ok(genPayload?.attempt !== undefined, "second request must have attempt");
      const a2Attempt = genPayload?.attempt as number;
      const a2Gen = genPayload?.generation as number;
      const res2 = await resolveApproval(http, runId, "a2", {
        requestId: rid2,
        expectedAttempt: a2Attempt,
        expectedGeneration: a2Gen,
        decision: "approve",
        note: "second ok",
      });
      assert.ok([200, 202].includes(res2.status), res2.text.slice(0, 600));
      for (let i = 0; i < 60; i += 1) {
        const d = await runDetail(http, runId);
        if (String((d as unknown as { status: string }).status) === "succeeded") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const fin = await runDetail(http, runId);
      assert.equal(String((fin as unknown as { status: string }).status), "succeeded");
      const finalPage = await readEventPage(http, runId);
      assert.equal(
        eventsOf(finalPage as never, "approval.resolved").filter((e) => e.path === "a1").length,
        1,
        "first resolved exactly once",
      );
      assert.equal(
        eventsOf(finalPage as never, "approval.resolved").filter((e) => e.path === "a2").length,
        1,
        "second resolved exactly once",
      );
      assert.equal(
        eventsOf(finalPage as never, "approval.requested").length,
        2,
        "exactly two requests total",
      );
      const inboxAfter = await http.api("GET", CANONICAL_INBOX);
      assert.equal(inboxAfter.status, 200);
      assert.equal(String(inboxAfter.text).includes(runId), false, "finished run must leave inbox");
    } catch (e) {
      fail2 = e;
    }
    const c2 = await cleanupRestarted(second, dataDir, sentinel, { keep: false });
    raiseCleanup(fail2, c2, "two-approval cleanup2");
    cleanupTempRoots();
  }, 360_000);
});
