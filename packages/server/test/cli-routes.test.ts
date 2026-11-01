import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "@devchestra/adapters";
import type { CatalogCli, ProjectView } from "@devchestra/api";
import { PROD_CLIS } from "@devchestra/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProviderStatusService,
  type ProviderStatusService,
} from "../src/browser/provider-status.js";
import type {
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
} from "../src/index.js";
import { createBrowserApp } from "../src/index.js";

const PORT = 51_236;
const TOKEN = "c".repeat(43);
const HOST = `127.0.0.1:${PORT}`;
const NOW = 1_700_000_000_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class CliStore implements BrowserQueryPort {
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
    startRun(): never {
      throw new Error("unused");
    },
    cancelRun(): never {
      throw new Error("unused");
    },
    resumeRun(): never {
      throw new Error("unused");
    },
    resolveApproval(): never {
      throw new Error("unused");
    },
  };
}

class MemorySettings implements BrowserProviderSettingsPort {
  #disabled = new Set<string>();
  list(): { cli: string; enabled: boolean }[] {
    return PROD_CLIS.map((cli) => ({ cli, enabled: !this.#disabled.has(cli) }));
  }
  setEnabled(cli: string, enabled: boolean): void {
    if (enabled) this.#disabled.delete(cli);
    else this.#disabled.add(cli);
  }
  disabled(): ReadonlySet<string> {
    return new Set(this.#disabled);
  }
}

interface AppOptions {
  providerSettings?: BrowserProviderSettingsPort;
  providerStatus?: ProviderStatusService;
}

async function app(options: AppOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "devchestra-clis-data-"));
  cleanups.push(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const raw = createBrowserApp({
    dataDir,
    store: new CliStore(),
    controller: controller(),
    sessionToken: TOKEN,
    instanceId: "instance-clis",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => NOW,
    logger: () => undefined,
    ...(options.providerSettings === undefined
      ? {}
      : { providerSettings: options.providerSettings }),
    ...(options.providerStatus === undefined ? {} : { providerStatus: options.providerStatus }),
  });
  return {
    request(input: string, init?: RequestInit) {
      const headers = new Headers(init?.headers);
      if (!headers.has("Host")) headers.set("Host", HOST);
      return raw.request(input, { ...init, headers });
    },
  };
}

type TestApp = Awaited<ReturnType<typeof app>>;

const URL_BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = `devchestra_session=${TOKEN}`;
const CSRF = { Cookie: COOKIE, "X-DevChestra-Csrf": "1", "Content-Type": "application/json" };

function list(a: TestApp, query = "") {
  return a.request(`${URL_BASE}/api/clis${query}`, { headers: { Cookie: COOKIE } });
}

function patch(a: TestApp, id: string, body: unknown, query = "") {
  return a.request(`${URL_BASE}/api/clis/${id}${query}`, {
    method: "PATCH",
    headers: CSRF,
    body: JSON.stringify(body),
  });
}

function probeRequest(a: TestApp, id: string, query = "") {
  return a.request(`${URL_BASE}/api/clis/${id}/probe${query}`, { method: "POST", headers: CSRF });
}

function statusRequest(a: TestApp, query = "") {
  return a.request(`${URL_BASE}/api/clis/status${query}`, { headers: { Cookie: COOKIE } });
}

function okProbe(counter: { calls: number }) {
  return async (cli: CatalogCli): Promise<{ ok: boolean; version: string | null }> => {
    counter.calls += 1;
    return { ok: true, version: `1.0.${cli.length}` };
  };
}

describe("GET /api/clis", () => {
  it("lists the registry CLIs without live probes", async () => {
    const a = await app();
    const res = await a.request(`http://127.0.0.1:${PORT}/api/clis`, {
      headers: { Host: HOST, Cookie: `devchestra_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clis: { id: string; label: string; experimental: boolean }[];
    };
    // Server tests opt into DEVCHESTRA_ALLOW_FAKE=1, so the test-only fake is listed last.
    expect(body.clis.map((entry) => entry.id)).toEqual([...PROD_CLIS, "fake"]);
    for (const id of PROD_CLIS) {
      const entry = body.clis.find((candidate) => candidate.id === id);
      expect(entry?.label).toBe(getProvider(id).label);
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.experimental).toBe(false);
    }
  });

  it("requires a session and rejects query data", async () => {
    const a = await app();
    const anon = await a.request(`http://127.0.0.1:${PORT}/api/clis`);
    expect(anon.status).toBe(401);
    const query = await a.request(`http://127.0.0.1:${PORT}/api/clis?x=1`, {
      headers: { Host: HOST, Cookie: `devchestra_session=${TOKEN}` },
    });
    expect(query.status).toBe(400);
  });
});

describe("provider enabled flag", () => {
  it("reports every CLI enabled by default", async () => {
    const a = await app({ providerSettings: new MemorySettings() });
    const body = (await (await list(a)).json()) as { clis: { id: string; enabled: boolean }[] };
    for (const id of PROD_CLIS) {
      expect(body.clis.find((entry) => entry.id === id)?.enabled).toBe(true);
    }
    expect(body.clis.find((entry) => entry.id === "fake")?.enabled).toBe(true);
  });

  it("reports every CLI enabled when no settings port is wired", async () => {
    const a = await app();
    const body = (await (await list(a)).json()) as { clis: { enabled: boolean }[] };
    expect(body.clis.every((entry) => entry.enabled)).toBe(true);
  });

  it("turns a provider off with PATCH and shows it in the list", async () => {
    const a = await app({ providerSettings: new MemorySettings() });
    const res = await patch(a, "codex", { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "codex", enabled: false });

    const body = (await (await list(a)).json()) as { clis: { id: string; enabled: boolean }[] };
    expect(body.clis.find((entry) => entry.id === "codex")?.enabled).toBe(false);
    expect(body.clis.find((entry) => entry.id === "pi")?.enabled).toBe(true);
  });

  it("treats setting the current value as a no-op success", async () => {
    const a = await app({ providerSettings: new MemorySettings() });
    const res = await patch(a, "codex", { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "codex", enabled: true });
  });

  it("refuses to turn off the last enabled provider and changes nothing", async () => {
    const settings = new MemorySettings();
    const a = await app({ providerSettings: settings });
    for (const id of ["claude-code", "codex", "opencode"]) {
      expect((await patch(a, id, { enabled: false })).status).toBe(200);
    }
    const res = await patch(a, "pi", { enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "E_CONFLICT", message: "At least one provider must stay on." },
    });
    expect([...settings.disabled()].sort()).toEqual(["claude-code", "codex", "opencode"]);
  });

  it("rejects unknown ids and the fake provider", async () => {
    const a = await app({ providerSettings: new MemorySettings() });
    expect((await patch(a, "nope", { enabled: false })).status).toBe(400);
    expect((await patch(a, "fake", { enabled: false })).status).toBe(400);
    expect((await probeRequest(a, "fake")).status).toBe(400);
  });

  it("rejects an invalid body", async () => {
    const a = await app({ providerSettings: new MemorySettings() });
    expect((await patch(a, "codex", { enabled: "no" })).status).toBe(400);
    expect((await patch(a, "codex", { enabled: true, extra: 1 })).status).toBe(400);
  });

  it("returns 501 when no settings port is wired", async () => {
    const a = await app();
    const res = await patch(a, "codex", { enabled: false });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: "E_NOT_SUPPORTED" } });
  });

  it("rejects query data on every CLI route", async () => {
    const a = await app({
      providerSettings: new MemorySettings(),
      providerStatus: createProviderStatusService({
        probe: async () => ({ ok: true, version: "1.0.0" }),
      }),
    });
    expect((await list(a, "?x=1")).status).toBe(400);
    expect((await statusRequest(a, "?x=1")).status).toBe(400);
    expect((await patch(a, "codex", { enabled: false }, "?x=1")).status).toBe(400);
    expect((await probeRequest(a, "codex", "?x=1")).status).toBe(400);
  });
});

describe("provider status routes", () => {
  it("returns a status for every provider CLI from the injected probe", async () => {
    const counter = { calls: 0 };
    const providerStatus = createProviderStatusService({
      probe: okProbe(counter),
      now: () => NOW,
    });
    const a = await app({ providerStatus });
    const res = await statusRequest(a);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      statuses: { id: string; state: string; version: string }[];
    };
    expect(body.statuses.map((entry) => entry.id)).toEqual([...PROD_CLIS]);
    expect(body.statuses.every((entry) => entry.state === "ready")).toBe(true);
    expect(body.statuses.every((entry) => entry.version.startsWith("1.0."))).toBe(true);
  });

  it("returns 501 when no status service is wired", async () => {
    const a = await app();
    expect((await statusRequest(a)).status).toBe(501);
    expect((await probeRequest(a, "codex")).status).toBe(501);
  });

  it("serves a second status call within the TTL from cache", async () => {
    const counter = { calls: 0 };
    let clock = NOW;
    const providerStatus = createProviderStatusService({
      probe: okProbe(counter),
      now: () => clock,
      ttlMs: 1_000,
    });
    const a = await app({ providerStatus });
    await statusRequest(a);
    clock += 500;
    await statusRequest(a);
    expect(counter.calls).toBe(PROD_CLIS.length);

    clock += 600;
    await statusRequest(a);
    expect(counter.calls).toBe(PROD_CLIS.length * 2);
  });

  it("bypasses the cache on POST probe", async () => {
    const counter = { calls: 0 };
    const providerStatus = createProviderStatusService({
      probe: okProbe(counter),
      now: () => NOW,
    });
    const a = await app({ providerStatus });
    await statusRequest(a);
    expect(counter.calls).toBe(PROD_CLIS.length);

    const res = await probeRequest(a, "codex");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "codex", state: "ready" });
    expect(counter.calls).toBe(PROD_CLIS.length + 1);
  });

  it("rejects a body on POST probe", async () => {
    const a = await app({
      providerStatus: createProviderStatusService({
        probe: async () => ({ ok: true, version: null }),
      }),
    });
    const res = await a.request(`${URL_BASE}/api/clis/codex/probe`, {
      method: "POST",
      headers: CSRF,
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("provider status service", () => {
  it("maps a probe timeout to error", async () => {
    const service = createProviderStatusService({
      probe: () => new Promise<never>(() => undefined),
      timeoutMs: 5,
      now: () => NOW,
    });
    const status = await service.probe("codex");
    expect(status).toMatchObject({
      id: "codex",
      state: "error",
      version: null,
      detail: "Version check timed out.",
    });
  });

  it("maps a not-found detail to notInstalled", async () => {
    const service = createProviderStatusService({
      probe: async () => ({ ok: false, version: null, detail: "spawn codex ENOENT" }),
      now: () => NOW,
    });
    expect(await service.probe("codex")).toEqual({
      id: "codex",
      state: "notInstalled",
      version: null,
      checkedAt: NOW,
    });
  });

  it("clips and strips control characters from error detail", async () => {
    const service = createProviderStatusService({
      probe: async () => ({ ok: false, version: null, detail: `boom\u0007${"x".repeat(300)}` }),
      now: () => NOW,
    });
    const status = await service.probe("pi");
    expect(status.state).toBe("error");
    expect(status.detail).toBe(`boom${"x".repeat(196)}`);
  });

  it("turns a thrown probe into an error status", async () => {
    const service = createProviderStatusService({
      probe: async () => {
        throw new Error("exploded");
      },
      now: () => NOW,
    });
    expect(await service.probe("opencode")).toMatchObject({ state: "error", detail: "exploded" });
  });

  it("shares one in-flight probe between concurrent calls", async () => {
    const counter = { calls: 0 };
    const service = createProviderStatusService({
      probe: async (cli) => {
        counter.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, version: cli };
      },
      now: () => NOW,
    });
    await Promise.all([service.probe("claude-code"), service.probe("claude-code")]);
    expect(counter.calls).toBe(1);
  });
});
