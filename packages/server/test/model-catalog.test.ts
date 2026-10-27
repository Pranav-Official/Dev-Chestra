import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliModelCatalog } from "@relay/api";
import type { RunId } from "@relay/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserModelCatalogPort,
  type BrowserQueryPort,
  type BrowserRunControllerPort,
  type CatalogCli,
  createBrowserApp,
  type ProjectView,
  startBrowserServer,
} from "../src/index.js";

const PORT = 51_235;
const TOKEN = "b".repeat(43);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NOW = 1_700_000_000_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ModelStore implements BrowserQueryPort {
  projects: ProjectView[] = [];

  listProjects(): ProjectView[] {
    return this.projects;
  }

  getProject(projectId: string): ProjectView | null {
    return this.projects.find((project) => project.id === projectId) ?? null;
  }

  registerProject(): never {
    throw new Error("unused");
  }
  relinkProject(): never {
    throw new Error("unused");
  }
  listRuns(): never {
    throw new Error("unused");
  }
  getRun(): never {
    throw new Error("unused");
  }
  runDetail(): never {
    throw new Error("unused");
  }
  eventsPage(): never {
    throw new Error("unused");
  }
  getExecution(): never {
    throw new Error("unused");
  }
  executionHistory(): never {
    throw new Error("unused");
  }
  getOutput(): never {
    throw new Error("unused");
  }
  counts(): { runs: number; activeRuns: number; inbox: number } {
    return { runs: 0, activeRuns: 0, inbox: 0 };
  }
  listApprovals(): never {
    throw new Error("unused");
  }
  getApproval(): never {
    throw new Error("unused");
  }
}

function controller(): BrowserRunControllerPort {
  return {
    startRun() {
      throw new Error("unused");
    },
    cancelRun(runId) {
      return { runId: runId as RunId, status: "cancelled" };
    },
    resumeRun(runId) {
      return { runId: runId as RunId, status: "queued" };
    },
    resolveApproval(): never {
      throw new Error("unused");
    },
  };
}

function catalog(overrides: Partial<CliModelCatalog> = {}): CliModelCatalog {
  return {
    cli: "codex",
    projectId: "proj-1",
    status: "ready",
    scope: "relay-runtime",
    source: "codex-app-server",
    cliVersion: "0.164.0",
    items: [
      {
        id: "gpt-5-codex",
        label: "GPT-5 Codex",
        isDefault: true,
        source: "codex-app-server",
      },
    ],
    fetchedAt: NOW,
    expiresAt: NOW + 300_000,
    truncated: false,
    customSupported: true,
    ...overrides,
  };
}

function claudeCatalog(overrides: Partial<CliModelCatalog> = {}): CliModelCatalog {
  return catalog({
    cli: "claude-code",
    source: "claude-sdk",
    items: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        isDefault: true,
        source: "claude-sdk",
      },
    ],
    cliVersion: "2.1.310",
    ...overrides,
  });
}

interface PortCalls {
  get: number;
  refresh: number;
  clis: CatalogCli[];
}

function fakePort(
  result: (cli: CatalogCli) => CliModelCatalog,
  calls: PortCalls,
): BrowserModelCatalogPort {
  return {
    get(_projectId, cli) {
      calls.get += 1;
      calls.clis.push(cli);
      return Promise.resolve(result(cli));
    },
    refresh(_projectId, cli) {
      calls.refresh += 1;
      calls.clis.push(cli);
      return Promise.resolve(result(cli));
    },
  };
}

interface Harness {
  app: ReturnType<typeof createBrowserApp>;
  store: ModelStore;
  calls: PortCalls;
  logs: string[];
  projectDir: string;
}

async function harness(options: { port?: boolean; throwPort?: boolean } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-models-data-"));
  const projectDir = await mkdtemp(join(tmpdir(), "relay-models-project-"));
  cleanups.push(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });
  const store = new ModelStore();
  store.projects.push({
    id: "proj-1",
    name: "Project",
    path: projectDir,
    kind: "folder",
    missing: false,
    addedAt: NOW,
  });
  const calls: PortCalls = { get: 0, refresh: 0, clis: [] };
  const logs: string[] = [];
  const port =
    options.port === true
      ? fakePort(
          (cli) =>
            options.throwPort === true
              ? (() => {
                  throw new Error("failed at /home/person/.codex/auth.json token=sk-live-SECRET");
                })()
              : cli === "claude-code"
                ? claudeCatalog()
                : catalog({ cli }),
          calls,
        )
      : undefined;
  const raw = createBrowserApp({
    dataDir,
    store,
    controller: controller(),
    sessionToken: TOKEN,
    instanceId: "instance-models",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => NOW,
    logger: (line) => logs.push(line),
    ...(port === undefined ? {} : { modelCatalog: port }),
  });
  const app = {
    request(input: Request | string | URL, init?: RequestInit) {
      if (input instanceof Request) {
        const headers = new Headers(input.headers);
        if (!headers.has("Host")) headers.set("Host", HOST);
        return raw.request(new Request(input, { headers }), init);
      }
      const headers = new Headers(init?.headers);
      if (!headers.has("Host")) headers.set("Host", HOST);
      return raw.request(input, { ...init, headers });
    },
  } as unknown as ReturnType<typeof createBrowserApp>;
  return { app, store, calls, logs, projectDir };
}

function url(path: string): string {
  return `http://127.0.0.1:${PORT}${path}`;
}

function cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Host: HOST, Cookie: `relay_session=${TOKEN}`, ...extra };
}

function mutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Host: HOST,
    Cookie: `relay_session=${TOKEN}`,
    Origin: ORIGIN,
    "X-Relay-Csrf": "1",
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("model catalog routes", () => {
  it("cold GET returns an unsupported catalog without a port and never refreshes", async () => {
    const h = await harness();
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/models"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cli: "codex",
      projectId: "proj-1",
      status: "unsupported",
      scope: "relay-runtime",
      source: "none",
      cliVersion: null,
      items: [],
      fetchedAt: null,
      expiresAt: null,
      truncated: false,
      customSupported: true,
      message: "Model discovery is not available for this CLI.",
    });
    expect(h.calls.get).toBe(0);
    expect(h.calls.refresh).toBe(0);
  });

  it("GET uses port.get only and returns its catalog", async () => {
    const h = await harness({ port: true });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/models"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(catalog());
    expect(h.calls).toEqual({ get: 1, refresh: 0, clis: ["codex"] });
  });

  it("POST refresh uses port.refresh only and accepts a bodyless request", async () => {
    const h = await harness({ port: true });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/models/refresh"), {
      method: "POST",
      headers: mutationHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(catalog());
    expect(h.calls).toEqual({ get: 0, refresh: 1, clis: ["codex"] });
  });

  it("fake is always unsupported and never calls the port", async () => {
    const h = await harness({ port: true });
    for (const method of ["GET", "POST"] as const) {
      const path =
        method === "POST"
          ? "/api/projects/proj-1/clis/fake/models/refresh"
          : "/api/projects/proj-1/clis/fake/models";
      const res = await h.app.request(url(path), {
        method,
        ...(method === "POST" ? { headers: mutationHeaders() } : { headers: cookieHeaders() }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "unsupported",
        source: "none",
        items: [],
        customSupported: true,
      });
    }
    expect(h.calls.get).toBe(0);
    expect(h.calls.refresh).toBe(0);
  });

  it("Claude GET and POST go through the port like Codex", async () => {
    const h = await harness({ port: true });
    const get = await h.app.request(url("/api/projects/proj-1/clis/claude-code/models"), {
      headers: cookieHeaders(),
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      cli: "claude-code",
      status: "ready",
      source: "claude-sdk",
      items: [{ id: "claude-sonnet-5-5", source: "claude-sdk" }],
      customSupported: true,
    });
    const post = await h.app.request(url("/api/projects/proj-1/clis/claude-code/models/refresh"), {
      method: "POST",
      headers: mutationHeaders(),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({
      cli: "claude-code",
      status: "ready",
      source: "claude-sdk",
    });
    expect(h.calls).toEqual({
      get: 1,
      refresh: 1,
      clis: ["claude-code", "claude-code"],
    });
  });

  it("Claude without a port stays empty and unsupported on GET and POST", async () => {
    const h = await harness();
    for (const method of ["GET", "POST"] as const) {
      const path =
        method === "POST"
          ? "/api/projects/proj-1/clis/claude-code/models/refresh"
          : "/api/projects/proj-1/clis/claude-code/models";
      const res = await h.app.request(url(path), {
        method,
        ...(method === "POST" ? { headers: mutationHeaders() } : { headers: cookieHeaders() }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        cli: "claude-code",
        status: "unsupported",
        source: "none",
        items: [],
        customSupported: true,
      });
    }
    expect(h.calls.get).toBe(0);
    expect(h.calls.refresh).toBe(0);
  });

  it("rejects unknown projects, missing projects and unknown CLIs", async () => {
    const h = await harness({ port: true });
    expect(
      (
        await h.app.request(url("/api/projects/nope/clis/codex/models"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/pi/models"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(400);
    const project = h.store.projects[0];
    if (project === undefined) throw new Error("fixture missing");
    project.missing = true;
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/models"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(409);
    expect(h.calls.get).toBe(0);
    expect(h.calls.refresh).toBe(0);
  });

  it("rejects query injection on both routes", async () => {
    const h = await harness({ port: true });
    for (const query of ["?bin=/bin/echo", "?env=HOME", "?flags=--dangerous"]) {
      expect(
        (
          await h.app.request(url(`/api/projects/proj-1/clis/codex/models${query}`), {
            headers: cookieHeaders(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await h.app.request(url(`/api/projects/proj-1/clis/codex/models/refresh${query}`), {
            method: "POST",
            headers: mutationHeaders(),
          })
        ).status,
      ).toBe(400);
    }
    expect(h.calls.get).toBe(0);
    expect(h.calls.refresh).toBe(0);
  });

  it("rejects any POST body, including chunked bodies without Content-Length", async () => {
    const h = await harness({ port: true });
    const declared = await h.app.request(url("/api/projects/proj-1/clis/codex/models/refresh"), {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ binary: "/tmp/evil" }),
    });
    expect(declared.status).toBe(400);

    const chunk = new TextEncoder().encode("x");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const chunked = await h.app.request(
      new Request(url("/api/projects/proj-1/clis/codex/models/refresh"), {
        method: "POST",
        headers: mutationHeaders(),
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(chunked.status).toBe(400);
    expect(h.calls.refresh).toBe(0);
  });

  it("keeps normal auth, origin and CSRF protections", async () => {
    const h = await harness({ port: true });
    expect((await h.app.request(url("/api/projects/proj-1/clis/codex/models"))).status).toBe(401);
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/models"), {
          headers: cookieHeaders({ Origin: "http://evil.test" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/models/refresh"), {
          method: "POST",
          headers: {
            Host: HOST,
            Cookie: `relay_session=${TOKEN}`,
            "Content-Type": "application/json",
          },
        })
      ).status,
    ).toBe(403);
  });

  it("sanitizes a thrown port failure into an unavailable catalog", async () => {
    const h = await harness({ port: true, throwPort: true });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/models"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      status: "unavailable",
      source: "none",
      items: [],
      customSupported: true,
    });
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("/home/person");
    expect(text).not.toContain("token=");
    expect(h.logs.join("\n")).not.toContain("SECRET");
    expect(h.logs.join("\n")).not.toContain("/home/person");
  });

  it("rejects an outbound catalog for another project or CLI without leaking it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-models-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "relay-models-project-"));
    cleanups.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    const store = new ModelStore();
    store.projects.push({
      id: "proj-1",
      name: "Project",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW,
    });
    for (const bad of [catalog({ projectId: "other-project" }), catalog({ cli: "claude-code" })]) {
      const app = createBrowserApp({
        dataDir,
        store,
        controller: controller(),
        sessionToken: TOKEN,
        instanceId: "instance-models",
        version: "0.1.0-test",
        port: PORT,
        validateResponses: true,
        now: () => NOW,
        modelCatalog: fakePort(() => bad, { get: 0, refresh: 0, clis: [] }),
      });
      const res = await app.request(url("/api/projects/proj-1/clis/codex/models"), {
        headers: cookieHeaders(),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("other-project");
      expect(text).not.toContain("gpt-5-codex");
      expect(JSON.parse(text)).toMatchObject({
        error: { code: "E_INTERNAL", message: "Model catalog response did not match the request." },
      });
    }
  });

  it("rejects a malformed outbound catalog before it reaches the wire", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-models-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "relay-models-project-"));
    cleanups.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    const store = new ModelStore();
    store.projects.push({
      id: "proj-1",
      name: "Project",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW,
    });
    const secret = "/home/person/.codex/auth.json";
    const app = createBrowserApp({
      dataDir,
      store,
      controller: controller(),
      sessionToken: TOKEN,
      instanceId: "instance-models",
      version: "0.1.0-test",
      port: PORT,
      validateResponses: true,
      now: () => NOW,
      modelCatalog: fakePort(() => ({ ...catalog(), message: secret.repeat(40) }), {
        get: 0,
        refresh: 0,
        clis: [],
      }),
    });
    const res = await app.request(url("/api/projects/proj-1/clis/codex/models"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "E_INTERNAL", message: "Model catalog response was invalid." },
    });
  });
});

describe("model catalog over real HTTP", () => {
  it("serves cold GET and explicit POST refresh with cookie auth", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-models-live-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "relay-models-live-project-"));
    const store = new ModelStore();
    store.projects.push({
      id: "proj-1",
      name: "Project",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW,
    });
    const calls: PortCalls = { get: 0, refresh: 0, clis: [] };
    const server = await startBrowserServer({
      dataDir,
      store,
      controller: controller(),
      sessionToken: TOKEN,
      instanceId: "instance-live-models",
      version: "0.1.0-test",
      port: 0,
      validateResponses: true,
      now: () => NOW,
      modelCatalog: fakePort((cli) => (cli === "claude-code" ? claudeCatalog() : catalog()), calls),
    });
    cleanups.push(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });

    const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const cold = await fetch(`${server.url}/api/projects/proj-1/clis/codex/models`, {
      headers: { Cookie: cookie },
    });
    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({ status: "ready", cli: "codex" });
    expect(calls.get).toBe(1);
    expect(calls.refresh).toBe(0);

    const refresh = await fetch(`${server.url}/api/projects/proj-1/clis/codex/models/refresh`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: server.url,
        "X-Relay-Csrf": "1",
        "Content-Type": "application/json",
      },
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ status: "ready", cli: "codex" });
    expect(calls.refresh).toBe(1);

    const claudeGet = await fetch(`${server.url}/api/projects/proj-1/clis/claude-code/models`, {
      headers: { Cookie: cookie },
    });
    expect(claudeGet.status).toBe(200);
    expect(await claudeGet.json()).toMatchObject({
      status: "ready",
      cli: "claude-code",
      source: "claude-sdk",
      items: [{ id: "claude-sonnet-5-5", source: "claude-sdk" }],
    });
    expect(calls.get).toBe(2);

    const claudeRefresh = await fetch(
      `${server.url}/api/projects/proj-1/clis/claude-code/models/refresh`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: server.url,
          "X-Relay-Csrf": "1",
          "Content-Type": "application/json",
        },
      },
    );
    expect(claudeRefresh.status).toBe(200);
    expect(await claudeRefresh.json()).toMatchObject({
      status: "ready",
      cli: "claude-code",
      source: "claude-sdk",
    });
    expect(calls.refresh).toBe(2);
    expect(calls.clis).toEqual(["codex", "codex", "claude-code", "claude-code"]);
  });
});
