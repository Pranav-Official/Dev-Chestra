import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionService } from "@relay/decisions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
import type { BrowserQueryPort, ProjectView } from "../src/index.js";
import { type RunningBrowserServer, startBrowserServer } from "../src/index.js";

const TOKEN = "d".repeat(43);
const NOW = 1_700_000_000_000;
const FAKE_ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};
const NEEDLES = ["test-typesafe-key", "test-cf-token", "test-cf-account"];

let root: string;
let dataDir: string;
let projectPath: string;
let server: RunningBrowserServer;
let cookie: string;
let standin: StandinHandle;
const seenBodies: unknown[] = [];

function projectView(): ProjectView {
  return {
    id: "proj-1",
    name: "Project",
    path: projectPath,
    kind: "folder",
    missing: false,
    addedAt: NOW,
  };
}

function store(): BrowserQueryPort {
  const project = projectView();
  return {
    listProjects: () => [project],
    getProject: (id) => (id === project.id ? project : null),
    registerProject: () => project,
    relinkProject: () => project,
    listRuns: () => ({ items: [], nextCursor: null }),
    getRun: () => null,
    runDetail: () => null,
    eventsPage: () => ({ events: [], nextAfter: 0, hasMore: false, watermark: 0 }),
    getExecution: () => null,
    executionHistory: () => ({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      path: "" as never,
      attempts: [],
      transcripts: [],
      latestTranscript: null,
    }),
    getOutput: () => null,
    counts: () => ({ runs: 0, activeRuns: 0, inbox: 0 }),
    listApprovals: () => ({ items: [], nextCursor: null }),
    getApproval: () => null,
  } as BrowserQueryPort;
}

function decisions(env: Record<string, string> = FAKE_ENV) {
  return createDecisionService({ env, dotenvPath: null, baseUrlOverride: standin.origin });
}

async function boot(env?: Record<string, string>): Promise<void> {
  server = await startBrowserServer({
    dataDir,
    store: store(),
    controller: {
      startRun: () => ({
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        duplicate: false,
        status: "queued" as never,
      }),
      cancelRun: () => ({ runId: "x" as never, status: "cancelled" as never }),
      resumeRun: () => ({ runId: "x" as never, status: "running" as never }),
      resolveApproval: () => {
        throw new Error("unused");
      },
    },
    decisions: decisions(env),
    sessionToken: TOKEN,
    instanceId: "decision-http",
    version: "0.1.0-test",
    port: 0,
    validateResponses: true,
    now: () => NOW,
  });
  const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
  cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function url(path: string): string {
  return `${server.url}${path}`;
}

function headers(mutation = false): Record<string, string> {
  return {
    Cookie: cookie,
    ...(mutation ? { "Content-Type": "application/json", "X-Relay-Csrf": "1" } : {}),
  };
}

async function json<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(url(path), {
    method,
    headers: { ...headers(method !== "GET"), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = (text === "" ? null : JSON.parse(text)) as T;
  seenBodies.push(parsed);
  return { status: response.status, body: parsed };
}

const TEST_BODY = {
  provider: "typesafe-jev",
  state: "customer is waiting",
  instructions: "Should we escalate?",
  mode: { kind: "boolean" },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-decision-http-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  seenBodies.length = 0;
  standin = await startStandin();
  await boot();
});

afterEach(async () => {
  await server.close();
  await standin.close();
  await rm(root, { recursive: true, force: true });
  const haystack = JSON.stringify(seenBodies);
  for (const needle of NEEDLES) {
    expect(haystack).not.toContain(needle);
  }
});

describe("decision provider HTTP routes", () => {
  it("lists providers with ready state and missing secret NAMES only", async () => {
    const response = await json<{ id: string; label: string; ready: boolean; missing: string[] }[]>(
      "GET",
      "/api/decision-providers",
    );
    expect(response.status).toBe(200);
    expect(response.body.map((entry) => entry.id).sort()).toEqual([
      "cloudflare-clef",
      "cloudflare-clef-flash",
      "typesafe-jev",
    ]);
    for (const entry of response.body) {
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
    expect(response.body.find((entry) => entry.id === "typesafe-jev")).toMatchObject({
      ready: true,
      missing: [],
    });
  });

  it("reports missing secret names without values when env is empty", async () => {
    await server.close();
    await boot({ unrelated: "x" } as Record<string, string>);
    const response = await json<{ id: string; ready: boolean; missing: string[] }[]>(
      "GET",
      "/api/decision-providers",
    );
    expect(response.status).toBe(200);
    expect(response.body.find((entry) => entry.id === "typesafe-jev")).toMatchObject({
      ready: false,
      missing: ["TYPESAFE_API_KEY"],
    });
    expect(response.body.find((entry) => entry.id === "cloudflare-clef")).toMatchObject({
      ready: false,
      missing: expect.arrayContaining(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"]),
    });
  });

  it("tests a boolean question with one provider call", async () => {
    const before = standin.requests().length;
    const response = await json<{
      output: { kind: string; value: boolean; probability: number; confidence: number };
      routing: { branch: string; reason: string };
      latencyMs: number;
      usage: { inputTokens: number; outputTokens: number };
    }>("POST", "/api/projects/proj-1/decisions/test", TEST_BODY);
    expect(response.status).toBe(200);
    expect(response.body.output).toMatchObject({ kind: "boolean", value: true });
    expect(response.body.routing).toEqual({ branch: "true", reason: "matched" });
    expect(response.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.body.usage).toMatchObject({ inputTokens: expect.any(Number) });
    expect(standin.requests().length).toBe(before + 1);
    expect(standin.lastRequest()?.body).toMatchObject({
      model: "jev-latest",
      questions: { q0: { type: "noul" } },
    });
  });

  it("routes choice and score modes through the same tester", async () => {
    const choice = await json<{ routing: { branch: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      {
        provider: "typesafe-jev",
        state: "x",
        instructions: "pick",
        mode: {
          kind: "choice",
          options: [{ value: "a" }, { value: "b" }],
          branches: [
            { id: "first", values: ["a"] },
            { id: "second", values: ["b"] },
          ],
        },
      },
    );
    expect(choice.status).toBe(200);
    expect(choice.body.routing.branch).toBe("first");

    const score = await json<{ routing: { branch: string }; output: { value: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      {
        provider: "typesafe-jev",
        state: "x",
        instructions: "rate",
        mode: {
          kind: "score",
          levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
          bands: [
            { id: "top", atLeast: 2 },
            { id: "rest", atLeast: null },
          ],
        },
      },
    );
    expect(score.status).toBe(200);
    expect(score.body.routing.branch).toBe("rest");
    expect(score.body.output.value).toBe("mid");
  });

  it("rejects invalid bodies, unknown projects and oversized state", async () => {
    const badMode = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      { ...TEST_BODY, mode: { kind: "boolean", trueAt: "high" } },
    );
    expect(badMode.status).toBe(400);
    expect(badMode.body.error.code).toBe("E_VALIDATION");

    const missing = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/nope/decisions/test",
      TEST_BODY,
    );
    expect(missing.status).toBe(404);

    const huge = await json<{ error: { code: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      { ...TEST_BODY, state: "x".repeat(70 * 1024) },
    );
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe("E_VALIDATION");
  });

  it("rejects schema-invalid modes with 400 without calling the provider", async () => {
    // F10: the tester enforces the same rules as validateDecision, beyond
    // the Zod shape (counts, uniqueness, band order, model pattern, reserved
    // names). None of these reach the provider.
    const before = standin.requests().length;
    const cases: Record<string, unknown>[] = [
      // 256 options exceed the 1..255 limit.
      {
        ...TEST_BODY,
        mode: {
          kind: "choice",
          options: Array.from({ length: 256 }, (_, i) => ({ value: `v${i}` })),
          branches: [{ id: "x", values: ["v0"] }],
        },
      },
      // Duplicate option value with full branch coverage.
      {
        ...TEST_BODY,
        mode: {
          kind: "choice",
          options: [{ value: "a" }, { value: "a" }],
          branches: [{ id: "x", values: ["a"] }],
        },
      },
      // Bands are not strictly decreasing.
      {
        ...TEST_BODY,
        mode: {
          kind: "score",
          levels: [{ label: "low" }, { label: "high" }],
          bands: [
            { id: "top", atLeast: 1 },
            { id: "mid", atLeast: 1 },
            { id: "floor", atLeast: null },
          ],
        },
      },
      // Model override violates the pattern.
      { ...TEST_BODY, model: "-bad" },
      // Reserved option value.
      {
        ...TEST_BODY,
        mode: {
          kind: "choice",
          options: [{ value: "a" }, { value: "__proto__" }],
          branches: [
            { id: "x", values: ["a"] },
            { id: "y", values: ["__proto__"] },
          ],
        },
      },
    ];
    for (const body of cases) {
      const rejected = await json<{ error: { code: string; message: string } }>(
        "POST",
        "/api/projects/proj-1/decisions/test",
        body,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe("E_VALIDATION");
    }
    expect(standin.requests()).toHaveLength(before);
  });

  it("returns redacted provider errors without key material", async () => {
    standin.setNext(["error-400"]);
    const failed = await json<{ error: { code: string; message: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      TEST_BODY,
    );
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).not.toContain("test-typesafe-key");

    standin.setNext(["echo-key"]);
    const leaked = await json<{ error: { code: string; message: string } }>(
      "POST",
      "/api/projects/proj-1/decisions/test",
      TEST_BODY,
    );
    expect(leaked.status).toBe(502);
    expect(leaked.body.error.message).toContain("[redacted]");
    expect(leaked.body.error.message).not.toContain("test-typesafe-key");
  });

  it("applies auth, CSRF, content-type and payload caps like the gate tester", async () => {
    const anonymous = await fetch(url("/api/projects/proj-1/decisions/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Csrf": "1" },
      body: JSON.stringify(TEST_BODY),
    });
    expect(anonymous.status).toBe(401);

    const noCsrf = await fetch(url("/api/projects/proj-1/decisions/test"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(TEST_BODY),
    });
    expect(noCsrf.status).toBe(403);

    const badType = await fetch(url("/api/projects/proj-1/decisions/test"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "text/plain", "X-Relay-Csrf": "1" },
      body: "{}",
    });
    expect(badType.status).toBe(403);

    const huge = await fetch(url("/api/projects/proj-1/decisions/test"), {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ ...TEST_BODY, state: "x".repeat(200 * 1024) }),
    });
    expect(huge.status).toBe(413);

    const anonymousProviders = await fetch(url("/api/decision-providers"));
    expect(anonymousProviders.status).toBe(401);
  });
});
