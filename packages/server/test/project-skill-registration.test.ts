import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectViewSchema } from "@devchestra/api";
import { openStore } from "@devchestra/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserRunControllerPort,
  createBrowserApp,
  createStoreQueryPort,
  ManagedWorkflowService,
  projectSkillTemplate,
} from "../src/index.js";

const TOKEN = "a".repeat(43);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness() {
  const dataDir = temp("devchestra-skill-data-");
  const store = openStore({ file: join(dataDir, "db.sqlite") });
  cleanup.push(() => store.close());
  const port = createStoreQueryPort(store);
  const app = createBrowserApp({
    dataDir,
    store: port,
    controller: {} as BrowserRunControllerPort,
    sessionToken: TOKEN,
    instanceId: "test",
    version: "1",
    port: 51234,
  });
  const request = (path: string, method = "GET", body?: object) =>
    app.request(`http://127.0.0.1:51234${path}`, {
      method,
      headers: {
        host: "127.0.0.1:51234",
        "x-devchestra-token": TOKEN,
        "x-devchestra-csrf": "1",
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const register = (path: string) => request("/api/projects", "POST", { path });
  return { dataDir, store, port, request, register };
}

const skillOf = (project: string): string => join(project, ".devchestra", "skill.md");
const template = projectSkillTemplate();

describe("project registration seeds .devchestra/skill.md", () => {
  it("creates the guide on POST /api/projects and keeps an edited copy on re-register", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const first = await h.register(project);
    expect(first.status).toBe(200);
    const view = projectViewSchema.parse(await first.json());
    expect(readFileSync(skillOf(project)).equals(template)).toBe(true);

    const edited = Buffer.from("# mine\n");
    writeFileSync(skillOf(project), edited);
    const again = await h.register(project);
    expect(again.status).toBe(200);
    expect(projectViewSchema.parse(await again.json()).id).toBe(view.id);
    expect(readFileSync(skillOf(project)).equals(edited)).toBe(true);
  });

  it("backfills an already registered project when it is registered again", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    h.store.projects.ensure({ id: "legacy", name: "Legacy", path: project, kind: "folder" });
    expect(existsSync(join(project, ".devchestra"))).toBe(false);
    expect((await h.register(project)).status).toBe(200);
    expect(readFileSync(skillOf(project)).equals(template)).toBe(true);
  });

  it("restores a removed project without overwriting its guide", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const view = projectViewSchema.parse(await (await h.register(project)).json());
    writeFileSync(skillOf(project), "kept");
    expect((await h.request(`/api/projects/${view.id}`, "DELETE")).status).toBe(200);
    const restored = projectViewSchema.parse(await (await h.register(project)).json());
    expect(restored.id).toBe(view.id);
    expect(readFileSync(skillOf(project), "utf8")).toBe("kept");
  });

  it("creates the guide at the new path on relink and leaves the old one alone", async () => {
    const h = harness();
    const oldPath = temp("devchestra-skill-old-");
    const newPath = temp("devchestra-skill-new-");
    const view = projectViewSchema.parse(await (await h.register(oldPath)).json());
    writeFileSync(skillOf(oldPath), "old edit");
    const relinked = await h.request(`/api/projects/${view.id}/relink`, "POST", {
      path: newPath,
    });
    expect(relinked.status).toBe(200);
    expect(readFileSync(skillOf(newPath)).equals(template)).toBe(true);
    expect(readFileSync(skillOf(oldPath), "utf8")).toBe("old edit");

    writeFileSync(skillOf(newPath), "new edit");
    expect(
      (await h.request(`/api/projects/${view.id}/relink`, "POST", { path: newPath })).status,
    ).toBe(200);
    expect(readFileSync(skillOf(newPath), "utf8")).toBe("new edit");
  });

  it("does not create a missing root and does not register it", async () => {
    const h = harness();
    const parent = temp("devchestra-skill-parent-");
    const missing = join(parent, "missing");
    const response = await h.register(missing);
    expect(response.status).toBe(404);
    expect(existsSync(missing)).toBe(false);
    expect(h.port.listProjects()).toEqual([]);
  });

  it("rejects a conflicting guide path with 403 and leaves the registry empty", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const outside = temp("devchestra-skill-outside-");
    mkdirSync(join(project, ".devchestra"));
    const target = join(outside, "real.md");
    writeFileSync(target, "outside");
    symlinkSync(target, skillOf(project));

    const response = await h.register(project);
    expect(response.status).toBe(403);
    expect(readFileSync(target, "utf8")).toBe("outside");
    expect(lstatSync(skillOf(project)).isSymbolicLink()).toBe(true);
    expect(h.port.listProjects()).toEqual([]);
  });

  it("rejects a .devchestra symlink without writing through it", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const outside = temp("devchestra-skill-outside-");
    symlinkSync(outside, join(project, ".devchestra"));
    expect((await h.register(project)).status).toBe(403);
    expect(readdirSync(outside)).toEqual([]);
    expect(h.port.listProjects()).toEqual([]);
  });

  it("seeds through the store port adapter directly (every real registration path)", () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const registered = h.port.registerProject({ path: project, name: "P", kind: "folder" });
    if (registered instanceof Promise) throw new Error("adapter is synchronous");
    expect(readFileSync(skillOf(project)).equals(template)).toBe(true);
    const other = temp("devchestra-skill-project-");
    const relinked = h.port.relinkProject({
      projectId: registered.id,
      path: other,
      name: "P",
      kind: "folder",
    });
    if (relinked instanceof Promise) throw new Error("adapter is synchronous");
    expect(readFileSync(skillOf(other)).equals(template)).toBe(true);
  });
});

describe("managed workflow initialization backfills the guide", () => {
  const projectFor = (path: string) => ({
    id: "p",
    path,
    kind: "folder" as const,
    missing: false,
  });

  it("creates it on the first workflow for a project registered before the guide existed", async () => {
    const dataDir = temp("devchestra-skill-data-");
    const project = temp("devchestra-skill-project-");
    const service = new ManagedWorkflowService({ dataDir });
    await service.create(projectFor(project), { name: "First" });
    expect(readFileSync(skillOf(project)).equals(template)).toBe(true);
    expect(readdirSync(join(project, ".devchestra")).sort()).toEqual(["skill.md", "workflows"]);
  });

  it("keeps an edited guide when more workflows are created or saved", async () => {
    const dataDir = temp("devchestra-skill-data-");
    const project = temp("devchestra-skill-project-");
    const service = new ManagedWorkflowService({ dataDir });
    const first = await service.create(projectFor(project), { name: "First" });
    writeFileSync(skillOf(project), "edited");
    await service.create(projectFor(project), { name: "Second" });
    await service.save(projectFor(project), first.workflow.id, first.workflow, first.etag);
    expect(readFileSync(skillOf(project), "utf8")).toBe("edited");
  });

  it("does not write anything when only listing", () => {
    const dataDir = temp("devchestra-skill-data-");
    const project = temp("devchestra-skill-project-");
    const service = new ManagedWorkflowService({ dataDir });
    expect(service.listPage(projectFor(project), { limit: 10 }).items).toEqual([]);
    expect(existsSync(join(project, ".devchestra"))).toBe(false);
  });

  it("refuses to create a workflow through a conflicting guide path", async () => {
    const dataDir = temp("devchestra-skill-data-");
    const project = temp("devchestra-skill-project-");
    mkdirSync(join(project, ".devchestra"));
    symlinkSync(join(project, "nowhere"), skillOf(project));
    const service = new ManagedWorkflowService({ dataDir });
    await expect(service.create(projectFor(project), { name: "X" })).rejects.toMatchObject({
      code: "E_FORBIDDEN_PATH",
    });
    expect(existsSync(join(project, "nowhere"))).toBe(false);
  });
});
