import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredMcpServer as AdapterDiscovered } from "@devchestra/adapters";
import type {
  DiscoveredMcpServer as ApiDiscovered,
  CliMcpServers,
  ProjectView,
} from "@devchestra/api";
import type { RunId } from "@devchestra/core";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  type BrowserMcpServersPort,
  type BrowserQueryPort,
  type BrowserRunControllerPort,
  type CatalogCli,
  createBrowserApp,
  createMcpServersPort,
} from "../src/index.js";

const PORT = 51_237;
const TOKEN = "d".repeat(43);
const HOST = `127.0.0.1:${PORT}`;
const NOW = 1_700_000_000_000;
const SECRET = "sk-live-PLANTED-SERVER-SECRET";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class McpStore implements BrowserQueryPort {
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

function payload(overrides: Partial<CliMcpServers> = {}): CliMcpServers {
  return {
    cli: "codex",
    projectId: "proj-1",
    servers: [
      {
        id: "global:github",
        name: "github",
        scope: "global",
        transport: "stdio",
        summary: "npx -y",
        source: "~/.codex/config.toml",
        status: "ready",
        hasSecrets: true,
      },
    ],
    scanned: ["~/.codex/config.toml"],
    warnings: [],
    ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createBrowserApp>;
  store: McpStore;
  calls: { list: number; clis: CatalogCli[] };
}

async function harness(options: { port?: BrowserMcpServersPort | null } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "devchestra-mcp-data-"));
  const projectDir = await mkdtemp(join(tmpdir(), "devchestra-mcp-project-"));
  cleanups.push(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });
  const store = new McpStore();
  store.projects.push({
    id: "proj-1",
    name: "Project",
    path: projectDir,
    kind: "folder",
    missing: false,
    addedAt: NOW,
  });
  const calls = { list: 0, clis: [] as CatalogCli[] };
  const port =
    options.port === undefined
      ? ({
          list(_projectId: string, cli: CatalogCli) {
            calls.list += 1;
            calls.clis.push(cli);
            return Promise.resolve(payload({ cli }));
          },
        } satisfies BrowserMcpServersPort)
      : options.port;
  const raw = createBrowserApp({
    dataDir,
    store,
    controller: controller(),
    sessionToken: TOKEN,
    instanceId: "instance-mcp",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => NOW,
    ...(port === null ? {} : { mcpServers: port }),
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
  return { app, store, calls };
}

function url(path: string): string {
  return `http://127.0.0.1:${PORT}${path}`;
}

function cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Host: HOST, Cookie: `devchestra_session=${TOKEN}`, ...extra };
}

describe("mcp server routes", () => {
  it("adapter discovery shape stays assignable to the api contract", () => {
    expectTypeOf<AdapterDiscovered>().toMatchTypeOf<ApiDiscovered>();
  });

  it("returns an empty list with a warning when no port is wired", async () => {
    const h = await harness({ port: null });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cli: "codex",
      projectId: "proj-1",
      servers: [],
      scanned: [],
      warnings: ["MCP discovery is not available for this CLI."],
    });
  });

  it("returns the port payload for a known project and CLI", async () => {
    const h = await harness();
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload());
    expect(h.calls).toEqual({ list: 1, clis: ["codex"] });
  });

  it("rejects unknown projects, missing projects, unknown and fake CLIs", async () => {
    const h = await harness();
    expect(
      (
        await h.app.request(url("/api/projects/nope/clis/codex/mcp-servers"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/bogus-cli/mcp-servers"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/fake/mcp-servers"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(400);
    const project = h.store.projects[0];
    if (project === undefined) throw new Error("fixture missing");
    project.missing = true;
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(409);
    expect(h.calls.list).toBe(0);
  });

  it("rejects query injection", async () => {
    const h = await harness();
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers?bin=/bin/echo"), {
          headers: cookieHeaders(),
        })
      ).status,
    ).toBe(400);
    expect(h.calls.list).toBe(0);
  });

  it("keeps normal auth and origin protections", async () => {
    const h = await harness();
    expect((await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"))).status).toBe(
      401,
    );
    expect(
      (
        await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
          headers: cookieHeaders({ Origin: "http://evil.test" }),
        })
      ).status,
    ).toBe(403);
  });

  it("sanitizes a thrown port failure without leaking secrets", async () => {
    const h = await harness({
      port: {
        list() {
          throw new Error(`failed at /home/person/.codex/auth.json token=${SECRET}`);
        },
      },
    });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      cli: "codex",
      projectId: "proj-1",
      servers: [],
      scanned: [],
      warnings: ["MCP discovery is temporarily unavailable."],
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("/home/person");
  });

  it("rejects an outbound payload for another project or CLI without leaking it", async () => {
    const h = await harness({
      port: {
        list: () => Promise.resolve(payload({ projectId: "other-project" })),
      },
    });
    const res = await h.app.request(url("/api/projects/proj-1/clis/codex/mcp-servers"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("other-project");
    expect(text).not.toContain("npx -y");
  });

  it("serves real discovery with ~ paths and no secret values", async () => {
    const home = await mkdtemp(join(tmpdir(), "devchestra-mcp-real-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "devchestra-mcp-real-proj-"));
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: `https://user:${SECRET}@mcp.example.com:8443/deep?token=${SECRET}`,
            headers: { Authorization: `Bearer ${SECRET}` },
          },
        },
      }),
    );
    const dataDir = await mkdtemp(join(tmpdir(), "devchestra-mcp-real-data-"));
    cleanups.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });
    const store = new McpStore();
    store.projects.push({
      id: "proj-1",
      name: "Project",
      path: projectDir,
      kind: "folder",
      missing: false,
      addedAt: NOW,
    });
    const raw = createBrowserApp({
      dataDir,
      store,
      controller: controller(),
      sessionToken: TOKEN,
      instanceId: "instance-mcp-real",
      version: "0.1.0-test",
      port: PORT,
      validateResponses: true,
      now: () => NOW,
      mcpServers: createMcpServersPort({
        getProjectDir: (id) => (id === "proj-1" ? projectDir : null),
        home,
        env: { ...process.env, HOME: home },
      }),
    });
    const res = await raw.request(url("/api/projects/proj-1/clis/opencode/mcp-servers"), {
      headers: cookieHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = JSON.parse(text) as CliMcpServers;
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      id: "global:remote",
      summary: "mcp.example.com",
      status: "ready",
      hasSecrets: true,
    });
    expect(parsed.scanned).toEqual(["~/.config/opencode/opencode.json"]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("user@");
    expect(text).not.toContain("/deep");
    expect(text).not.toContain("token=");
    expect(text).not.toContain(home);
  });
});
