import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkflow } from "@devchestra/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserQueryPort, ProjectView } from "../src/index.js";
import { type RunningBrowserServer, startBrowserServer } from "../src/index.js";
import { ManagedWorkflowService } from "../src/workflows/service.js";
import {
  detectTestCommand,
  pickStarterCli,
  seedStarterWorkflows,
  starterWorkflows,
} from "../src/workflows/starters.js";

const TOKEN = "c".repeat(43);

let root: string;
let dataDir: string;
let projectPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "devchestra-starters-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seeded(): Promise<string[]> {
  try {
    return (await readdir(join(projectPath, ".devchestra", "workflows"))).sort();
  } catch {
    return [];
  }
}

describe("starter templates", () => {
  for (const kind of ["git", "folder"] as const) {
    it(`validate cleanly for a ${kind} project`, () => {
      for (const workflow of starterWorkflows({ cli: "claude-code", testCommand: "npm test" })) {
        const report = validateWorkflow(workflow, { projectKind: kind });
        expect(report.errors, workflow.id).toEqual([]);
      }
    });
  }

  it("picks the first ready, enabled CLI and falls back to claude-code", () => {
    expect(pickStarterCli(new Set(["pi", "codex"]))).toBe("codex");
    expect(pickStarterCli(new Set(["codex", "pi"]), new Set(["codex"]))).toBe("pi");
    expect(pickStarterCli(new Set())).toBe("claude-code");
  });

  it("detects the test command from the manifest", async () => {
    expect(detectTestCommand(projectPath)).toBe("npm test");
    await writeFile(join(projectPath, "Cargo.toml"), "");
    expect(detectTestCommand(projectPath)).toBe("cargo test");
  });

  it("seeds once and never overwrites an existing workflow", async () => {
    const service = new ManagedWorkflowService({ dataDir });
    const project = { id: "p", path: projectPath, kind: "folder" as const, missing: false };
    expect(await seedStarterWorkflows(service, project, { cli: "codex" })).toEqual({
      created: ["project-tour", "fix-until-green"],
      failed: [],
    });
    expect(await seeded()).toEqual(["fix-until-green.json", "project-tour.json"]);
    expect(await seedStarterWorkflows(service, project, { cli: "codex" })).toEqual({
      created: [],
      failed: [],
    });
  });
});

describe("POST /api/projects seeding", () => {
  let server: RunningBrowserServer;
  let cookie: string;
  let projects: ProjectView[];

  function store(): BrowserQueryPort {
    return {
      listProjects: () => projects,
      getProject: () => null,
      registerProject: (input: { path: string; name: string; kind: "git" | "folder" }) => {
        const view: ProjectView = {
          id: `p${projects.length}`,
          name: input.name,
          path: input.path,
          kind: input.kind,
          missing: false,
          addedAt: 1_700_000_000_000,
        };
        if (!projects.some((p) => p.path === view.path)) projects.push(view);
        return view;
      },
    } as unknown as BrowserQueryPort;
  }

  beforeEach(async () => {
    projects = [];
    server = await startBrowserServer({
      dataDir,
      store: store(),
      controller: {} as never,
      sessionToken: TOKEN,
      instanceId: "starters",
      version: "0.1.0-test",
      port: 0,
      now: () => 1_700_000_000_000,
      providerStatus: {
        getAll: async () => [
          { id: "claude-code", state: "notInstalled", version: null, checkedAt: 1 },
          { id: "codex", state: "ready", version: "1", checkedAt: 1 },
        ],
        probe: async () => {
          throw new Error("unused");
        },
      },
    });
    const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
    cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  });

  afterEach(async () => {
    await server.close();
  });

  function register(body: unknown): Promise<Response> {
    return fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-DevChestra-Csrf": "1" },
      body: JSON.stringify(body),
    });
  }

  it("seeds a new project with the first detected CLI, and skips re-registration", async () => {
    expect((await register({ path: projectPath })).status).toBe(200);
    expect(await seeded()).toEqual(["fix-until-green.json", "project-tour.json"]);
    const tour = await readFile(
      join(projectPath, ".devchestra/workflows/project-tour.json"),
      "utf8",
    );
    expect(tour).toContain('"cli": "codex"');
    await rm(join(projectPath, ".devchestra"), { recursive: true });
    expect((await register({ path: projectPath })).status).toBe(200);
    expect(await seeded()).toEqual([]);
  });

  it("does not seed when seedStarters is false", async () => {
    expect((await register({ path: projectPath, seedStarters: false })).status).toBe(200);
    expect(await seeded()).toEqual([]);
  });
});
