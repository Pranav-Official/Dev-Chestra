import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPolling,
  api,
  armPoll,
  closeAllPollHarnesses,
  createPollHarness,
  errorCode,
  errorReason,
  type PollHarness,
  PROJECT_ID,
  pollWorkflow,
  WORKFLOW_ID,
  withoutPolling,
} from "./polling-harness.js";

const BASE = `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/polling`;
const WORKFLOW_API = `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`;

let h: PollHarness;

beforeEach(() => {
  h = createPollHarness();
  h.writeWorkflow(WORKFLOW_ID, pollWorkflow());
});

afterEach(() => {
  closeAllPollHarnesses();
});

interface StatusBody {
  supported: boolean;
  armed: boolean;
  state: string;
  intervalSeconds: number | null;
  armedRevision: string | null;
  nextDueAt: number | null;
  lastTickAt: number | null;
  lastOutcome: string | null;
  lastRunId: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  refreshError: string | null;
  issues: { code: string; message: string }[];
}

async function status(): Promise<StatusBody> {
  const res = await api(h, "GET", BASE);
  expect(res.status).toBe(200);
  return res.json as StatusBody;
}

async function etagOf(path: string): Promise<string> {
  const res = await api(h, "GET", path);
  const etag = res.headers.get("etag");
  if (etag === null) throw new Error(`no ETag for ${path}`);
  return etag;
}

async function saveWorkflow(id: string, file: unknown): Promise<{ status: number; text: string }> {
  const etag = await etagOf(`/api/projects/${PROJECT_ID}/workflows/${id}`);
  const res = await api(
    h,
    "PUT",
    `/api/projects/${PROJECT_ID}/workflows/${id}`,
    { workflow: file },
    { "If-Match": etag },
  );
  return { status: res.status, text: res.text };
}

describe("polling status", () => {
  it("reports off before arming, with supported taken from the saved start node", async () => {
    expect(await status()).toMatchObject({
      supported: true,
      armed: false,
      state: "off",
      intervalSeconds: null,
      issues: [],
    });
    h.writeWorkflow(
      WORKFLOW_ID,
      pollWorkflow({ polling: { enabled: false, probe: { type: "shell", command: "x" } } }),
    );
    expect(await status()).toMatchObject({ supported: false, state: "off" });
  });

  it("answers 404 for a workflow that has no file and no trigger", async () => {
    const res = await api(h, "GET", `/api/projects/${PROJECT_ID}/workflows/nothing-here/polling`);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a workflow id that is not a valid file stem on every polling route", async () => {
    const bad = `/api/projects/${PROJECT_ID}/workflows/Bad_Id/polling`;
    expect((await api(h, "GET", bad)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/arm`, { intervalSeconds: 60 })).status).toBe(400);
    expect((await api(h, "POST", `${bad}/disarm`)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/refresh`)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/probe-now`)).status).toBe(400);
  });

  it("reports current after arming and stale once a saved change is not yet refreshed", async () => {
    await armPoll(h);
    expect((await status()).state).toBe("current");
    h.writeWorkflow(WORKFLOW_ID, pollWorkflow());
    // Rewriting the same file keeps the revision; renaming the workflow does not.
    const renamed = { ...pollWorkflow(), name: "Renamed" };
    h.writeWorkflow(WORKFLOW_ID, renamed);
    expect((await status()).state).toBe("stale");
    const refreshed = await api(h, "POST", `${BASE}/refresh`);
    expect(refreshed.status).toBe(200);
    expect((refreshed.json as StatusBody).state).toBe("current");
  });

  it("reports invalid when the saved file is broken and keeps the last armed revision running", async () => {
    await armPoll(h);
    h.writeWorkflow(WORKFLOW_ID, { ...pollWorkflow(), graph: { nodes: [], edges: [] } });
    const body = await status();
    expect(body.state).toBe("invalid");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("reports invalid when the saved start node no longer enables polling", async () => {
    await armPoll(h);
    h.writeWorkflow(
      WORKFLOW_ID,
      pollWorkflow({ polling: { enabled: false, probe: { type: "shell", command: "x" } } }),
    );
    const body = await status();
    expect(body.state).toBe("invalid");
    expect(body.supported).toBe(false);
    expect(body.issues[0]?.code).toBe("E_POLL_NOT_ENABLED");
  });

  it("reports failing after a failed tick and recovers on the next success", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ fail: "E_POLL_PROBE" });
    await h.scheduler.tick(h.clock.now() + 10_000);
    expect(await status()).toMatchObject({ state: "failing", consecutiveFailures: 1 });
    h.probeScript.push({ kind: "shell", stdout: "", exitCode: 0 });
    await h.scheduler.tick(h.clock.now() + 20_000);
    expect(await status()).toMatchObject({ state: "current", consecutiveFailures: 0 });
  });
});

describe("arming", () => {
  it("rejects an invalid saved workflow with 400 E_WORKFLOW_INVALID and issues", async () => {
    h.writeWorkflow(WORKFLOW_ID, { ...pollWorkflow(), graph: { nodes: [], edges: [] } });
    const res = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 60 });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("E_WORKFLOW_INVALID");
  });

  it("rejects a workflow that does not enable polling with 409 not_supported", async () => {
    h.writeWorkflow(WORKFLOW_ID, withoutPolling(pollWorkflow()));
    const res = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 60 });
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("not_supported");
  });

  it("rejects a project that is not a Git repository with 409 project_not_git", async () => {
    h.git = false;
    const res = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 60 });
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("project_not_git");
    expect((await status()).armed).toBe(false);
  });

  it("rejects intervals outside the probe-type bounds with 400 E_VALIDATION", async () => {
    for (const intervalSeconds of [9, 86_401, 1.5, "sixty"]) {
      const res = await api(h, "POST", `${BASE}/arm`, { intervalSeconds });
      expect(res.status, String(intervalSeconds)).toBe(400);
      expect(errorCode(res)).toBe("E_VALIDATION");
    }
    h.writeWorkflow(WORKFLOW_ID, pollWorkflow({ polling: agentPolling() }));
    const agentShort = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 30 });
    expect(agentShort.status).toBe(400);
    expect(errorCode(agentShort)).toBe("E_VALIDATION");
    const agentOk = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 60 });
    expect(agentOk.status).toBe(200);
  });

  it("arms with the interval, keeps the poller on re-arm, and reports current", async () => {
    const first = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 120 });
    expect(first.status).toBe(200);
    const body = first.json as StatusBody;
    expect(body).toMatchObject({ armed: true, state: "current", intervalSeconds: 120 });
    expect(body.armedRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.nextDueAt).toBe("number");

    const again = await api(h, "POST", `${BASE}/arm`, { intervalSeconds: 30 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ armed: true, state: "current", intervalSeconds: 30 });
  });

  it("disarm is idempotent and keeps the interval for the next arm", async () => {
    await armPoll(h, 45);
    const off = await api(h, "POST", `${BASE}/disarm`);
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ armed: false, state: "off", intervalSeconds: 45 });
    const again = await api(h, "POST", `${BASE}/disarm`);
    expect(again.status).toBe(200);
    await armPoll(h, 45);
    expect((await status()).armed).toBe(true);
  });

  it("refresh requires an armed trigger", async () => {
    const res = await api(h, "POST", `${BASE}/refresh`);
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("not_armed");
  });
});

describe("saves and deletes", () => {
  it("a valid save of the root refreshes the armed revision", async () => {
    const armed = (await armPoll(h)) as unknown as StatusBody;
    const saved = await saveWorkflow(WORKFLOW_ID, { ...pollWorkflow(), name: "Renamed poll" });
    expect(saved.status).toBe(200);
    const body = await status();
    expect(body.state).toBe("current");
    expect(body.armedRevision).not.toBe(armed.armedRevision);
    expect(body.refreshError).toBeNull();
  });

  it("an invalid root save still succeeds, records refreshError, and clears it on the next valid save", async () => {
    await armPoll(h);
    const saved = await saveWorkflow(WORKFLOW_ID, {
      ...pollWorkflow(),
      graph: { nodes: [], edges: [] },
    });
    expect(saved.status).toBe(200);
    const failed = await status();
    expect(failed.state).toBe("invalid");
    expect(failed.refreshError).toMatch(/invalid|missing|start/i);

    const fixed = await saveWorkflow(WORKFLOW_ID, pollWorkflow());
    expect(fixed.status).toBe(200);
    const recovered = await status();
    expect(recovered.state).toBe("current");
    expect(recovered.refreshError).toBeNull();
  });

  it("deleting an armed workflow removes its poller", async () => {
    await armPoll(h);
    const etag = await etagOf(WORKFLOW_API);
    const removed = await api(h, "DELETE", WORKFLOW_API, undefined, { "If-Match": etag });
    expect(removed.status).toBe(204);
    expect((await api(h, "GET", BASE)).status).toBe(404);
  });
});

describe("probe-now", () => {
  interface ProbeBody {
    outcome: string;
    params: Record<string, unknown> | null;
    dedupeKey: string | null;
    wouldSkipAsDuplicate: boolean;
    error: string | null;
    durationMs: number;
  }

  async function probeNow(): Promise<{ status: number; body: ProbeBody }> {
    const res = await api(h, "POST", `${BASE}/probe-now`);
    return { status: res.status, body: res.json as ProbeBody };
  }

  it("answers 409 not_supported when the saved workflow does not declare polling", async () => {
    h.writeWorkflow(WORKFLOW_ID, withoutPolling(pollWorkflow()));
    const res = await api(h, "POST", `${BASE}/probe-now`);
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("not_supported");
  });

  it("runs one probe without arming, launching, or recording a tick", async () => {
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 3}', exitCode: 0 });
    const { status: code, body } = await probeNow();
    expect(code).toBe(200);
    expect(body.outcome).toBe("found");
    expect(body.params).toEqual({ pr: 3, title: "none" });
    expect(typeof body.dedupeKey).toBe("string");
    expect(body.wouldSkipAsDuplicate).toBe(false);
    expect(body.error).toBeNull();
    expect(h.launches).toHaveLength(0);
    expect(await status()).toMatchObject({
      armed: false,
      lastTickAt: null,
      consecutiveFailures: 0,
    });
  });

  it("reports nothing for an empty probe and never writes a dedupe claim", async () => {
    h.probeScript.push({ kind: "shell", stdout: "   ", exitCode: 0 });
    const { body } = await probeNow();
    expect(body.outcome).toBe("nothing");
    expect(body.params).toBeNull();
    // A real tick afterwards still triggers: nothing was claimed.
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 1}', exitCode: 0 });
    await h.scheduler.tick(h.clock.now() + 10_000);
    expect(h.launches).toHaveLength(1);
  });

  it("reports failed for a bad exit or bad params without touching the streak", async () => {
    h.probeScript.push({ kind: "shell", stdout: "", exitCode: 2 });
    expect((await probeNow()).body).toMatchObject({ outcome: "failed" });
    h.probeScript.push({ kind: "shell", stdout: '{"pr": "three"}', exitCode: 0 });
    const { body } = await probeNow();
    expect(body.outcome).toBe("failed");
    expect(typeof body.error).toBe("string");
    expect(await status()).toMatchObject({ consecutiveFailures: 0, lastOutcome: null });
  });

  it("reports wouldSkipAsDuplicate once a tick has claimed the key", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 8, "dedupeKey": "sha:8"}', exitCode: 0 });
    await h.scheduler.tick(h.clock.now() + 10_000);
    expect(h.launches).toHaveLength(1);

    h.probeScript.push({ kind: "shell", stdout: '{"pr": 8, "dedupeKey": "sha:8"}', exitCode: 0 });
    const { body } = await probeNow();
    expect(body.outcome).toBe("found");
    expect(body.dedupeKey).toBe("sha:8");
    expect(body.wouldSkipAsDuplicate).toBe(true);
    // probe-now still launches nothing and records nothing.
    expect(h.launches).toHaveLength(1);
    expect(await status()).toMatchObject({ lastOutcome: "triggered", consecutiveFailures: 0 });
  });

  it("passes an armed agent probe with mcpServers and permissions to the engine unchanged", async () => {
    const permissions = { network: false, write: ["workspace"], shell: true };
    const mcpServers = [{ name: "gh", scope: "global" }];
    h.writeWorkflow(
      WORKFLOW_ID,
      pollWorkflow({
        polling: {
          enabled: true,
          probe: {
            id: "probe",
            type: "agent",
            name: "Poll probe",
            cli: "codex",
            prompt: "Check for work.",
            permissions,
            mcpServers,
            limits: { timeoutMin: 5 },
          },
        },
      }),
    );
    h.probeScript.push({ kind: "agent", output: { found: true, params: { pr: 4 } } });
    const { status: code, body } = await probeNow();
    expect(code).toBe(200);
    expect(body.outcome).toBe("found");
    expect(body.params).toEqual({ pr: 4, title: "none" });
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.probe).toMatchObject({ type: "agent", permissions, mcpServers });
  });
});
