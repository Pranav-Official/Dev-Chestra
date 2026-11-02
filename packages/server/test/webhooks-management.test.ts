import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  armHook,
  CHILD_ID,
  COOKIE,
  closeAllHarnesses,
  createHarness,
  deliver,
  errorCode,
  errorReason,
  type Harness,
  HOST,
  hookWorkflow,
  ORIGIN,
  PROJECT_ID,
  WORKFLOW_ID,
} from "./webhooks-harness.js";

const BASE = `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/webhook`;
const WORKFLOW_API = `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`;
const VALID = JSON.stringify({ issue: { title: "Crash on start" } });

let h: Harness;
const tempDirs: string[] = [];

beforeEach(() => {
  h = createHarness();
  h.writeWorkflow(WORKFLOW_ID, hookWorkflow());
});

afterEach(() => {
  closeAllHarnesses();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StatusBody {
  supported: boolean;
  armed: boolean;
  state: string;
  hookId: string | null;
  url: string | null;
  armedRevision: string | null;
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

describe("webhook status", () => {
  it("reports off before arming, with supported taken from the saved start node", async () => {
    expect(await status()).toMatchObject({
      supported: true,
      armed: false,
      state: "off",
      hookId: null,
      url: null,
      issues: [],
    });
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ webhook: false }));
    expect(await status()).toMatchObject({ supported: false, state: "off" });
  });

  it("answers 404 for a workflow that has no file and no trigger", async () => {
    const res = await api(h, "GET", `/api/projects/${PROJECT_ID}/workflows/nothing-here/webhook`);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a workflow id that is not a valid file stem on every webhook route", async () => {
    const bad = `/api/projects/${PROJECT_ID}/workflows/Bad_Id/webhook`;
    expect((await api(h, "GET", bad)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/arm`)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/disarm`)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/rotate`)).status).toBe(400);
    expect((await api(h, "POST", `${bad}/refresh`)).status).toBe(400);
  });

  it("reports current after arming and stale once a saved change is not yet refreshed", async () => {
    await armHook(h);
    expect((await status()).state).toBe("current");
    h.writeWorkflow(CHILD_ID, hookWorkflow({ id: CHILD_ID }));
    expect((await status()).state).toBe("stale");
    const refreshed = await api(h, "POST", `${BASE}/refresh`);
    expect(refreshed.status).toBe(200);
    expect((refreshed.json as StatusBody).state).toBe("current");
  });

  it("reports invalid when the saved file is broken and keeps the last armed revision running", async () => {
    const armed = await armHook(h);
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ edgeTo: "missing" }));
    const body = await status();
    expect(body.state).toBe("invalid");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.hookId).toBe(armed.hookId);
    const delivered = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(delivered.status).toBe(202);
  });

  it("reports invalid with E_NOT_FOUND when the armed file is removed", async () => {
    await armHook(h);
    h.removeWorkflow(WORKFLOW_ID);
    const body = await status();
    expect(body.state).toBe("invalid");
    expect(body.issues[0]?.code).toBe("E_NOT_FOUND");
  });

  it("reports invalid when the saved start node no longer enables webhooks", async () => {
    await armHook(h);
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ webhook: false }));
    const body = await status();
    expect(body.state).toBe("invalid");
    expect(body.supported).toBe(false);
    expect(body.issues[0]?.code).toBe("E_WEBHOOK_NOT_ENABLED");
  });
});

describe("arming", () => {
  it("rejects an invalid saved workflow with 400 E_WORKFLOW_INVALID and issues", async () => {
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ edgeTo: "missing" }));
    const res = await api(h, "POST", `${BASE}/arm`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("E_WORKFLOW_INVALID");
    const details = (res.json as { error: { details?: { issues?: unknown[] } } }).error.details;
    expect(details?.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it("rejects an unsupported mapping at arm time", async () => {
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ mapping: { title: "headers.authorization" } }));
    const res = await api(h, "POST", `${BASE}/arm`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("E_WORKFLOW_INVALID");
  });

  it("rejects a workflow that does not enable webhooks with 409 not_supported", async () => {
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow({ webhook: false }));
    const res = await api(h, "POST", `${BASE}/arm`);
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("not_supported");
  });

  it("rejects a project that is not a Git repository with 409 project_not_git", async () => {
    h.git = false;
    const res = await api(h, "POST", `${BASE}/arm`);
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("project_not_git");
    expect((await status()).armed).toBe(false);
  });

  it("returns the secret once, keeps the hook id on re-arm, and reports current", async () => {
    const first = await api(h, "POST", `${BASE}/arm`);
    expect(first.status).toBe(200);
    const body = first.json as { status: StatusBody; secret: string | null };
    // GitHub's documented shape: 40 hex characters (SecureRandom.hex(20)).
    expect(body.secret).toMatch(/^[0-9a-f]{40}$/);
    expect(body.status).toMatchObject({ armed: true, state: "current" });
    expect(body.status.hookId).toMatch(/^whk_/);
    expect(body.status.url).toBe(`${ORIGIN}/webhooks/${body.status.hookId}`);
    expect(body.status.armedRevision).toMatch(/^[0-9a-f]{64}$/);

    const again = await api(h, "POST", `${BASE}/arm`);
    expect(again.status).toBe(200);
    const second = again.json as { status: StatusBody; secret: unknown };
    expect(second.secret).toBeNull();
    expect(second.status.hookId).toBe(body.status.hookId);
    expect(second.status.state).toBe("current");

    // The secret is never part of later status reads.
    const read = await api(h, "GET", BASE);
    expect(read.text).not.toContain(body.secret ?? "");
  });

  it("uses the configured public base URL in copyable URLs", async () => {
    const saved = await api(h, "PUT", "/api/settings/webhooks", {
      publicBaseUrl: "https://hooks.example.test/devchestra/",
    });
    expect(saved.status).toBe(200);
    expect((saved.json as { publicBaseUrl: string }).publicBaseUrl).toBe(
      "https://hooks.example.test/devchestra",
    );
    const armed = await armHook(h);
    expect(armed.status.url).toBe(`https://hooks.example.test/devchestra/webhooks/${armed.hookId}`);
  });

  it("refuses to arm when a child workflow does not freeze", async () => {
    h.writeWorkflow(CHILD_ID, { not: "a workflow" });
    const res = await api(h, "POST", `${BASE}/arm`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("E_WORKFLOW_INVALID");
    expect((await status()).armed).toBe(false);
  });

  it("disarm keeps the hook and its credentials and is idempotent", async () => {
    const armed = await armHook(h);
    const off = await api(h, "POST", `${BASE}/disarm`);
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ armed: false, state: "off", hookId: armed.hookId });
    const again = await api(h, "POST", `${BASE}/disarm`);
    expect(again.status).toBe(200);
    const rearmed = await armHook(h);
    expect(rearmed.hookId).toBe(armed.hookId);
    expect(rearmed.secret).toBeNull();
  });
});

describe("credentials", () => {
  it("rotation invalidates the old secret at once", async () => {
    const armed = await armHook(h);
    const rotated = await api(h, "POST", `${BASE}/rotate`);
    expect(rotated.status).toBe(200);
    const secret = (rotated.json as { secret: string }).secret;
    expect(secret).toMatch(/^[0-9a-f]{40}$/);
    expect(secret).not.toBe(armed.secret);

    const old = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(old.status).toBe(401);

    const fresh = await deliver(h, armed.hookId, { body: VALID, secret });
    expect(fresh.status).toBe(202);
  });

  it("rotation requires an existing trigger", async () => {
    const res = await api(h, "POST", `${BASE}/rotate`);
    expect(res.status).toBe(404);
  });

  it("refresh requires an armed trigger", async () => {
    const res = await api(h, "POST", `${BASE}/refresh`);
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("not_armed");
  });
});

describe("saves and deletes", () => {
  it("a saved child alone does not change the armed parent until the parent is refreshed", async () => {
    const armed = await armHook(h);
    const child = hookWorkflow({ id: CHILD_ID });
    h.writeWorkflow(CHILD_ID, child);
    const saved = await saveWorkflow(CHILD_ID, child);
    expect(saved.status).toBe(200);
    const body = await status();
    expect(body.state).toBe("stale");
    expect(body.armedRevision).toBe(armed.status.armedRevision);
  });

  it("a valid save of the root refreshes the armed revision", async () => {
    const armed = await armHook(h);
    const saved = await saveWorkflow(WORKFLOW_ID, { ...hookWorkflow(), name: "Renamed hook" });
    expect(saved.status).toBe(200);
    const body = await status();
    expect(body.state).toBe("current");
    expect(body.armedRevision).not.toBe(armed.status.armedRevision);
    expect(body.refreshError).toBeNull();
  });

  it("an invalid root save still succeeds, records refreshError, and clears it on the next valid save", async () => {
    await armHook(h);
    const broken = hookWorkflow({ edgeTo: "missing" });
    const saved = await saveWorkflow(WORKFLOW_ID, broken);
    expect(saved.status).toBe(200);
    const failed = await status();
    expect(failed.state).toBe("invalid");
    expect(failed.refreshError).toMatch(/invalid|missing/i);

    const fixed = await saveWorkflow(WORKFLOW_ID, hookWorkflow());
    expect(fixed.status).toBe(200);
    const recovered = await status();
    expect(recovered.state).toBe("current");
    expect(recovered.refreshError).toBeNull();
  });

  it("deleting an armed workflow removes its trigger, and the old hook and secret stop working", async () => {
    const armed = await armHook(h);
    const etag = await etagOf(WORKFLOW_API);
    const removed = await api(h, "DELETE", WORKFLOW_API, undefined, { "If-Match": etag });
    expect(removed.status).toBe(204);
    expect((await api(h, "GET", BASE)).status).toBe(404);
    const old = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(old.status).toBe(404);
  });

  it("a workflow recreated after deletion arms with a new hook and a new secret", async () => {
    const armed = await armHook(h);
    const etag = await etagOf(WORKFLOW_API);
    await api(h, "DELETE", WORKFLOW_API, undefined, { "If-Match": etag });
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow());
    const again = await armHook(h);
    expect(again.hookId).not.toBe(armed.hookId);
    expect(again.secret).toMatch(/^[0-9a-f]{40}$/);
    expect(again.secret).not.toBe(armed.secret);
    const old = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(old.status).toBe(404);
    const fresh = await deliver(h, again.hookId, { body: VALID, secret: again.secret ?? "" });
    expect(fresh.status).toBe(202);
  });
});

describe("settings", () => {
  it("reads and saves execution settings, validates ranges and asks the engine to pump the queue", async () => {
    const read = await api(h, "GET", "/api/settings/execution");
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      settings: { maxConcurrentRuns: 2, maxQueueDepth: 100 },
      limits: {
        maxConcurrentRuns: { min: 1, max: 32, default: 2 },
        maxQueueDepth: { min: 10, max: 1000, default: 100 },
      },
    });

    const low = await api(h, "PUT", "/api/settings/execution", {
      maxConcurrentRuns: 0,
      maxQueueDepth: 100,
    });
    expect(low.status).toBe(400);
    const high = await api(h, "PUT", "/api/settings/execution", {
      maxConcurrentRuns: 2,
      maxQueueDepth: 5000,
    });
    expect(high.status).toBe(400);
    const extra = await api(h, "PUT", "/api/settings/execution", {
      maxConcurrentRuns: 2,
      maxQueueDepth: 100,
      other: 1,
    });
    expect(extra.status).toBe(400);
    expect(h.pumps.count).toBe(0);

    const saved = await api(h, "PUT", "/api/settings/execution", {
      maxConcurrentRuns: 3,
      maxQueueDepth: 50,
    });
    expect(saved.status).toBe(200);
    expect((saved.json as { settings: unknown }).settings).toEqual({
      maxConcurrentRuns: 3,
      maxQueueDepth: 50,
    });
    expect(h.pumps.count).toBe(1);
    expect(h.store.executionSettings.get()).toEqual({ maxConcurrentRuns: 3, maxQueueDepth: 50 });
  });

  it("reads and saves webhook settings and refuses unsafe public base URLs", async () => {
    expect(await api(h, "GET", "/api/settings/webhooks")).toMatchObject({
      status: 200,
      json: { publicBaseUrl: null },
    });
    for (const bad of [
      "ftp://hooks.example.test",
      "https://user:pass@hooks.example.test",
      "https://hooks.example.test/?token=1",
      "https://hooks.example.test/#frag",
      "not a url",
    ]) {
      const res = await api(h, "PUT", "/api/settings/webhooks", { publicBaseUrl: bad });
      expect(res.status, bad).toBe(400);
    }
    const ok = await api(h, "PUT", "/api/settings/webhooks", { publicBaseUrl: null });
    expect(ok.status).toBe(200);
  });

  it("requires the browser session and the CSRF header for management routes", async () => {
    const noCookie = await h.app.request(`${ORIGIN}${BASE}`, { headers: { Host: HOST } });
    expect(noCookie.status).toBe(401);
    const noCsrf = await h.app.request(`${ORIGIN}${BASE}/arm`, {
      method: "POST",
      headers: { Host: HOST, Cookie: COOKIE, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("static allowlist", () => {
  function withWebRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "devchestra-webhooks-web-"));
    tempDirs.push(root);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>app-shell</title>");
    return root;
  }

  it("serves /settings/execution and /p/:pid/settings/execution as application routes", async () => {
    h = createHarness({ webRoot: withWebRoot() });
    h.writeWorkflow(WORKFLOW_ID, hookWorkflow());
    for (const path of ["/settings/execution", `/p/${PROJECT_ID}/settings/execution`]) {
      const res = await api(h, "GET", path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain("app-shell");
      expect(res.headers.get("content-type"), path).toContain("text/html");
    }
  });

  it("does not serve unrelated settings paths as application routes", async () => {
    h = createHarness({ webRoot: withWebRoot() });
    const res = await h.app.request(`${ORIGIN}/settings/unknown`, {
      headers: { Host: HOST, Cookie: COOKIE },
    });
    expect(res.status).toBe(404);
  });
});
