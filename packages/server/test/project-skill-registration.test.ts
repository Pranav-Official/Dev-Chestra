import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const register = (path: string) =>
    request("/api/projects", "POST", { path, seedStarters: false });
  return { dataDir, store, port, request, register };
}

describe("project registration and workflow creation", () => {
  it("does not seed a project guide and preserves existing project instructions", async () => {
    const h = harness();
    const project = temp("devchestra-skill-project-");
    const first = projectViewSchema.parse(await (await h.register(project)).json());
    expect(existsSync(join(project, ".devchestra"))).toBe(false);
    mkdirSync(join(project, ".devchestra"));
    const skill = join(project, ".devchestra", "skill.md");
    writeFileSync(skill, "custom instructions");
    const second = projectViewSchema.parse(await (await h.register(project)).json());
    expect(second.id).toBe(first.id);
    expect(readFileSync(skill, "utf8")).toBe("custom instructions");
    const service = new ManagedWorkflowService({ dataDir: h.dataDir });
    await service.create(
      { id: first.id, path: project, kind: "folder", missing: false },
      { name: "First" },
    );
    expect(readFileSync(skill, "utf8")).toBe("custom instructions");
  });
});
