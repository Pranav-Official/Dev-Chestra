import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapResponseSchema, projectViewSchema, runListResponseSchema } from "@relay/api";
import type { Path, RunId } from "@relay/core";
import { normalizeWorkflow } from "@relay/schema";
import { openStore } from "@relay/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserRunControllerPort,
  createBrowserApp,
  createStoreQueryPort,
} from "../src/index.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const TOKEN = "a".repeat(43);
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "relay-cleanup-http-"));
  const projectDir = mkdtempSync(join(tmpdir(), "relay-cleanup-project-"));
  const store = openStore({ file: join(dir, "db.sqlite") });
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });
  const port = createStoreQueryPort(store);
  const project = port.registerProject({ path: projectDir, name: "Project", kind: "folder" });
  // Concrete store adapter is synchronous.
  if (project instanceof Promise) throw new Error("Unexpected asynchronous adapter");
  const app = createBrowserApp({
    dataDir: dir,
    store: port,
    controller: {} as BrowserRunControllerPort,
    sessionToken: TOKEN,
    instanceId: "test",
    version: "1",
    port: 51234,
  });
  const request = (path: string, method = "GET", body?: object, csrf = true) =>
    app.request(`http://127.0.0.1:51234${path}`, {
      method,
      headers: {
        host: "127.0.0.1:51234",
        "x-relay-token": TOKEN,
        ...(csrf ? { "x-relay-csrf": "1" } : {}),
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const normalized = normalizeWorkflow({
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "done", type: "end", name: "Done", status: "success", result: "{}" },
      ],
      edges: [{ id: "e1", from: "start", to: "done" }],
    },
  });
  if (!normalized.ok) throw normalized.error;
  const create = (workflowId = "wf") =>
    store.runs.create({
      projectId: project.id,
      workflowId,
      workflowHash: "hash",
      snapshot: normalized.value,
      snapshotRaw: "{}",
    }).runId;
  const finish = (runId: RunId) =>
    store.events.append(runId, [
      { runId, path: "" as Path, type: "run.cancelled", actor: "user", payload: {} },
    ]);
  return { store, request, project, projectDir, create, finish };
}

describe("workspace cleanup HTTP", () => {
  it("blocks active removal/archive, hides completed runs, and restores via existing ids", async () => {
    const h = harness();
    const id = h.create();
    expect((await h.request(`/api/runs/${id}/archive`, "POST", {})).status).toBe(409);
    const blocked = await h.request(`/api/projects/${h.project.id}`, "DELETE");
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("active");
    h.finish(id);
    expect((await h.request(`/api/runs/${id}/archive`, "POST", {})).status).toBe(200);
    expect(runListResponseSchema.parse(await (await h.request("/api/runs")).json()).items).toEqual(
      [],
    );
    const archived = runListResponseSchema.parse(
      await (await h.request("/api/runs?archived=true")).json(),
    );
    expect(archived.items[0]).toMatchObject({
      id,
      status: "cancelled",
      archivedAt: expect.any(Number),
    });
    expect((await h.request(`/api/runs/${id}`)).status).toBe(200);
    expect((await h.request(`/api/runs/${id}/restore`, "POST", {})).status).toBe(200);
    expect(
      runListResponseSchema.parse(await (await h.request("/api/runs")).json()).items[0]?.id,
    ).toBe(id);
    expect((await h.request("/api/runs?archived=invalid")).status).toBe(400);
  });

  it("preserves files and history across remove/re-add, and protects mutations with CSRF", async () => {
    const h = harness();
    const id = h.create();
    h.finish(id);
    const file = join(h.projectDir, "keep.txt");
    writeFileSync(file, "preserved");
    expect(
      (await h.request(`/api/projects/${h.project.id}`, "DELETE", undefined, false)).status,
    ).toBe(403);
    expect((await h.request(`/api/projects/${h.project.id}`, "DELETE")).status).toBe(200);
    expect(
      bootstrapResponseSchema.parse(await (await h.request("/api/bootstrap")).json()).projects,
    ).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("preserved");
    expect((await h.request(`/api/runs/${id}`)).status).toBe(200);
    const restored = projectViewSchema.parse(
      await (await h.request("/api/projects", "POST", { path: h.projectDir })).json(),
    );
    expect(restored.id).toBe(h.project.id);
    expect(
      runListResponseSchema.parse(await (await h.request("/api/runs")).json()).items[0]?.id,
    ).toBe(id);
  });

  it("bulk archives only terminal runs and provides independent workflow summaries", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      const id = h.create();
      h.finish(id);
    }
    const active = h.create();
    const other = h.create("other");
    const summaries = runListResponseSchema.parse(
      await (await h.request(`/api/projects/${h.project.id}/run-summaries`)).json(),
    );
    expect(summaries.items).toHaveLength(4);
    expect(summaries.items.every((r) => r.workflowName === "Workflow")).toBe(true);
    const base = `/api/projects/${h.project.id}/workflows/wf/archive-runs`;
    expect((await h.request(base, "POST", {})).status).toBe(200);
    const visible = runListResponseSchema.parse(
      await (await h.request(`/api/projects/${h.project.id}/run-summaries`)).json(),
    );
    expect(new Set(visible.items.map((r: { id: string }) => r.id))).toEqual(
      new Set([active, other]),
    );
    expect(
      runListResponseSchema.parse(await (await h.request("/api/runs?archived=true&limit=2")).json())
        .nextCursor,
    ).not.toBeNull();
    expect((await h.request("/api/runs/missing/archive", "POST", {})).status).toBe(404);
  });
});
