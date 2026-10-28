import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "@relay/adapters";
import type { ProjectView } from "@relay/api";
import { PROD_CLIS } from "@relay/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserQueryPort, BrowserRunControllerPort } from "../src/index.js";
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

async function app() {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-clis-data-"));
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
  });
  return {
    request(input: string, init?: RequestInit) {
      const headers = new Headers(init?.headers);
      if (!headers.has("Host")) headers.set("Host", HOST);
      return raw.request(input, { ...init, headers });
    },
  };
}

describe("GET /api/clis", () => {
  it("lists the registry CLIs without live probes", async () => {
    const a = await app();
    const res = await a.request(`http://127.0.0.1:${PORT}/api/clis`, {
      headers: { Host: HOST, Cookie: `relay_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clis: { id: string; label: string; experimental: boolean }[];
    };
    // Server tests opt into RELAY_ALLOW_FAKE=1, so the test-only fake is listed last.
    expect(body.clis.map((entry) => entry.id)).toEqual([...PROD_CLIS, "fake"]);
    for (const id of PROD_CLIS) {
      const entry = body.clis.find((candidate) => candidate.id === id);
      expect(entry?.label).toBe(getProvider(id).label);
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.experimental).toBe(true);
    }
  });

  it("requires a session and rejects query data", async () => {
    const a = await app();
    const anon = await a.request(`http://127.0.0.1:${PORT}/api/clis`);
    expect(anon.status).toBe(401);
    const query = await a.request(`http://127.0.0.1:${PORT}/api/clis?x=1`, {
      headers: { Host: HOST, Cookie: `relay_session=${TOKEN}` },
    });
    expect(query.status).toBe(400);
  });
});
