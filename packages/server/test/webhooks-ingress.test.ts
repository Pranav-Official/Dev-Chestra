import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  armHook,
  closeAllHarnesses,
  createHarness,
  deliver,
  errorCode,
  errorReason,
  type Harness,
  hookWorkflow,
  PROJECT_ID,
  WORKFLOW_ID,
} from "./webhooks-harness.js";

const VALID = JSON.stringify({ issue: { title: "Crash on start" } });
/** Well formed, but never issued by any trigger. */
const WRONG_SECRET = "f".repeat(40);

let h: Harness;

function fresh(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const harness = createHarness(options);
  harness.writeWorkflow(WORKFLOW_ID, hookWorkflow());
  return harness;
}

beforeEach(() => {
  h = fresh();
});

afterEach(() => {
  closeAllHarnesses();
});

describe("public webhook ingress: authentication", () => {
  it("accepts a valid HMAC signature, queues a new-worktree run and never echoes the secret", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      secret: armed.secret,
      headers: { "x-github-delivery": "gh-1" },
    });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ duplicate: false, status: "queued" });
    const runId = (res.json as { runId: string }).runId;
    expect(h.store.runs.get(runId as never)?.status).toBe("queued");
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.workspace).toEqual({ mode: "new-worktree" });
    expect(h.launches[0]?.params).toEqual({ title: "Crash on start" });
    expect(res.text).not.toContain(armed.secret ?? "");
  });

  it("accepts a valid HMAC over the raw body", async () => {
    const armed = await armHook(h);
    const signature = createHmac("sha256", armed.secret ?? "")
      .update(VALID)
      .digest("hex");
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      headers: { "x-hub-signature-256": `sha256=${signature}`, "x-webhook-id": "hmac-1" },
    });
    expect(res.status).toBe(202);
  });

  it("accepts the DevChestra signature header as well", async () => {
    const armed = await armHook(h);
    const signature = createHmac("sha256", armed.secret ?? "")
      .update(VALID)
      .digest("hex");
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      headers: { "x-devchestra-signature": `sha256=${signature}` },
    });
    expect(res.status).toBe(202);
  });

  it("does not accept the secret as a bearer token, since only the HMAC authenticates", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      headers: { authorization: `Bearer ${armed.secret ?? ""}` },
    });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("E_AUTH");
    expect(h.launches).toHaveLength(0);
  });

  it("refuses a wrong secret with a generic 401 that does not echo it", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, { body: VALID, secret: WRONG_SECRET });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("E_AUTH");
    expect(res.text).not.toContain(WRONG_SECRET);
    expect(h.launches).toHaveLength(0);
  });

  it("refuses a bad signature with 401", async () => {
    const armed = await armHook(h);
    const wrong = await deliver(h, armed.hookId, {
      body: VALID,
      headers: { "x-hub-signature-256": "sha256=00" },
    });
    expect(wrong.status).toBe(401);
    const otherBody = createHmac("sha256", armed.secret ?? "")
      .update("{}")
      .digest("hex");
    const mismatch = await deliver(h, armed.hookId, {
      body: VALID,
      headers: { "x-hub-signature-256": `sha256=${otherBody}` },
    });
    expect(mismatch.status).toBe(401);
    expect(h.launches).toHaveLength(0);
  });

  it("refuses a request with no credentials", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, { body: VALID });
    expect(res.status).toBe(401);
  });

  it("answers 404 for an unknown hook and for a malformed hook id", async () => {
    await armHook(h);
    const unknown = await deliver(h, "whk_AAAAAAAAAAAAAAAAAAAAAA", {
      body: VALID,
      secret: WRONG_SECRET,
    });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("E_NOT_FOUND");
    const malformed = await deliver(h, "not-a-hook", { body: VALID });
    expect(malformed.status).toBe(404);
  });

  it("refuses a disarmed hook with 409 before the body is parsed", async () => {
    const armed = await armHook(h);
    await api(h, "POST", `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/webhook/disarm`);
    const res = await deliver(h, armed.hookId, {
      body: "{this is not json",
      secret: armed.secret,
    });
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("disarmed");
    expect(h.launches).toHaveLength(0);
  });

  it("checks credentials before the armed state", async () => {
    const armed = await armHook(h);
    await api(h, "POST", `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/webhook/disarm`);
    const res = await deliver(h, armed.hookId, { body: VALID, secret: WRONG_SECRET });
    expect(res.status).toBe(401);
  });
});

describe("public webhook ingress: body and parameters", () => {
  it("refuses a body over 1 MiB with 413 and launches nothing", async () => {
    const armed = await armHook(h);
    const big = new Uint8Array(1024 * 1024 + 1).fill(0x20);
    const res = await deliver(h, armed.hookId, { body: big, secret: armed.secret });
    expect(res.status).toBe(413);
    expect(errorCode(res)).toBe("E_PAYLOAD_TOO_LARGE");
    expect(h.launches).toHaveLength(0);
  });

  it("answers 400 for invalid JSON and for a non-object JSON body", async () => {
    const armed = await armHook(h);
    const invalid = await deliver(h, armed.hookId, { body: "{nope", secret: armed.secret });
    expect(invalid.status).toBe(400);
    expect(errorCode(invalid)).toBe("E_VALIDATION");
    const array = await deliver(h, armed.hookId, { body: "[1, 2]", secret: armed.secret });
    expect(array.status).toBe(400);
  });

  it("answers 400 with issues when the mapped required value is missing", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, {
      body: JSON.stringify({ issue: "no title here" }),
      secret: armed.secret,
    });
    expect(res.status).toBe(400);
    const details = (res.json as { error: { details?: { issues?: unknown[] } } }).error.details;
    expect(details?.issues?.length ?? 0).toBeGreaterThan(0);
    expect(h.launches).toHaveLength(0);
  });

  it("answers 400 for a delivery ID that does not match the allowed shape", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      secret: armed.secret,
      headers: { "x-github-delivery": "has spaces and /slashes" },
    });
    expect(res.status).toBe(400);
  });

  it("does not dedupe deliveries that carry no delivery ID", async () => {
    const armed = await armHook(h);
    const first = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    const second = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((first.json as { runId: string }).runId).not.toBe(
      (second.json as { runId: string }).runId,
    );
  });
});

describe("public webhook ingress: deduplication and capacity", () => {
  it("returns the original run for a repeated delivery and 409 for a different payload", async () => {
    const armed = await armHook(h);
    const headers = { "x-github-delivery": "gh-1" };
    const first = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret, headers });
    expect(first.status).toBe(202);
    const runId = (first.json as { runId: string }).runId;

    const duplicate = await deliver(h, armed.hookId, {
      body: VALID,
      secret: armed.secret,
      headers,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.json).toMatchObject({ runId, duplicate: true });
    expect(h.store.runs.listQueued()).toHaveLength(1);

    const conflict = await deliver(h, armed.hookId, {
      body: JSON.stringify({ issue: { title: "Different" } }),
      secret: armed.secret,
      headers,
    });
    expect(conflict.status).toBe(409);
    expect(errorReason(conflict)).toBe("delivery_conflict");
  });

  it("answers 503 with Retry-After when the queue is full", async () => {
    h = fresh({ maxQueueDepth: 10 });
    const armed = await armHook(h);
    for (let index = 0; index < 10; index += 1) {
      const accepted = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
      expect(accepted.status).toBe(202);
    }
    const full = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(full.status).toBe(503);
    expect(errorCode(full)).toBe("E_QUEUE_FULL");
    expect(full.headers.get("retry-after")).toBe("30");
    expect(h.store.runs.listQueued()).toHaveLength(10);
  });

  it("refuses delivery when the project is not a Git repository", async () => {
    const armed = await armHook(h);
    h.git = false;
    const res = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(res.status).toBe(409);
    expect(errorReason(res)).toBe("project_not_git");
    expect(h.launches).toHaveLength(0);
  });

  it("maps other engine refusals through the API error table", async () => {
    const armed = await armHook(h);
    h.failLaunchWith("E_BUDGET");
    const budget = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(budget.status).toBe(409);
    expect(errorCode(budget)).toBe("E_BUDGET");
    h.failLaunchWith("E_NOT_FOUND");
    const missing = await deliver(h, armed.hookId, { body: VALID, secret: armed.secret });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("E_NOT_FOUND");
    h.failLaunchWith(null);
    expect(h.store.runs.listQueued()).toHaveLength(0);
  });
});

describe("public webhook ingress: transport", () => {
  it("is reachable without the session, CSRF or Host and Origin guards", async () => {
    const armed = await armHook(h);
    const res = await deliver(h, armed.hookId, {
      body: VALID,
      secret: armed.secret,
      host: "evil.example:1",
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
