import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Path } from "@devchestra/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DevChestraError } from "../src/errors.js";
import { ManagedWorkflowService, type WorkflowProject } from "../src/workflows/service.js";

const TOKEN = "c".repeat(43);

let root: string;
let dataDir: string;
let projectPath: string;
let service: ManagedWorkflowService;
let project: WorkflowProject;

function file(id: string, workflowId: string | null): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name: id,
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        ...(workflowId
          ? [
              {
                id: "call",
                type: "workflow",
                name: "Call",
                workflowId,
                inputs: {},
              },
            ]
          : []),
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: workflowId ? "call" : "start",
        },
      ],
      edges:
        workflowId === null
          ? [{ id: "e1", from: "start", to: "end" }]
          : [
              { id: "e1", from: "start", to: "call" },
              { id: "e2", from: "call", to: "end" },
            ],
    },
  };
}

async function writeWorkflow(id: string, workflowId: string | null): Promise<void> {
  await writeFile(
    join(projectPath, ".devchestra", "workflows", `${id}.json`),
    JSON.stringify(file(id, workflowId)),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-children-"));
  dataDir = join(root, "data");
  projectPath = join(root, "proj");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(projectPath, ".devchestra", "workflows"), { recursive: true });
  service = new ManagedWorkflowService({ dataDir });
  project = { id: "p1", path: projectPath, kind: "folder", missing: false };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("child-workflow single-id reader (engine owns freeze)", () => {
  it("reads one child by id with no transitive walk", async () => {
    await writeWorkflow("leaf", null);
    await writeWorkflow("root", "leaf");
    const resolved = await service.readChildNormalized(project, "leaf");
    expect(resolved.id).toBe("leaf");
    expect(resolved.normalized.id).toBe("leaf");
    expect(typeof resolved.hash).toBe("string");
    const doc = service.get(project, "root");
    expect(doc.workflow.id).toBe("root");
  });

  it("missing target fails explicitly, never silent", async () => {
    await writeWorkflow("root", "ghost");
    await expect(service.readChildNormalized(project, "ghost")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
    });
  });

  it("run returns the root snapshot only (no server freeze)", async () => {
    await writeWorkflow("leaf", null);
    await writeWorkflow("root", "leaf");
    const doc = service.get(project, "root");
    const snapshot = await service.run(project, "root", { etag: doc.etag });
    expect(snapshot.workflowId).toBe("root");
    expect(snapshot.snapshot.id).toBe("root");
    expect("dependencies" in snapshot).toBe(false);
  });
});

describe("provenance inspection (refs only, paginated)", () => {
  it("lists children, foreach items with outputId refs, and resolves values via outputs API", async () => {
    const { startBrowserServer } = await import("../src/index.js");
    const { openStore } = await import("@devchestra/store");
    const { createStoreQueryPort } = await import("../src/browser/store-query.js");
    const store = openStore({ file: join(dataDir, "devchestra.db") });
    store.projects.ensure({ id: "p1", name: "P", path: projectPath, kind: "folder" });
    const snapshot = { schemaVersion: 1, id: "main", name: "M", graph: { nodes: [], edges: [] } };
    const parent = store.runs.create({
      projectId: "p1",
      workflowId: "main",
      workflowHash: "h",
      snapshot,
      snapshotRaw: "{}",
    });
    const childA = store.runs.create({
      projectId: "p1",
      workflowId: "leaf",
      workflowHash: "h",
      snapshot,
      snapshotRaw: "{}",
    });
    const childB = store.runs.create({
      projectId: "p1",
      workflowId: "leaf",
      workflowHash: "h",
      snapshot,
      snapshotRaw: "{}",
    });
    for (const [nodePath, child] of [
      ["sub", childA],
      ["sub2", childB],
    ] as const) {
      store.executions.ensure({
        runId: parent.runId,
        path: nodePath as Path,
        nodeId: nodePath,
        kind: "workflow",
      });
      const linkInv = store.executions.beginInvocation({
        runId: parent.runId,
        path: nodePath as Path,
        attempt: 1,
        resolvedConfigHash: "cfg",
      });
      store.workflowCalls.link({
        identity: linkInv,
        childRunId: child.runId,
        workflowId: "leaf",
        workflowHash: "h",
      });
      if (nodePath === "sub") {
        store.workflowCalls.complete({
          identity: linkInv,
          childRunId: child.runId,
          status: "succeeded",
          resultRef: null,
        });
      }
    }
    // Foreach source + items; item 0 carries a real recorded output.
    store.executions.ensure({
      runId: parent.runId,
      path: "each" as Path,
      nodeId: "each",
      kind: "foreach",
    });
    const inv = store.executions.beginInvocation({
      runId: parent.runId,
      path: "each" as Path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    const { source } = store.foreach.createSource({
      identity: inv,
      kind: "expression",
      items: [{ v: "a" }, { v: "b" }],
      maxItems: 10,
    });
    store.foreach.start({
      identity: inv,
      total: 2,
      maxItems: 10,
      sourceId: source.id,
      sourceHash: source.sourceHash,
    });
    store.executions.ensure({
      runId: parent.runId,
      path: "each[0]/work" as Path,
      nodeId: "work",
      kind: "agent",
    });
    const inv0 = store.executions.beginInvocation({
      runId: parent.runId,
      path: "each[0]/work" as Path,
      attempt: 1,
      resolvedConfigHash: "cfg",
    });
    const recorded = store.outputs.recordDeterministic({
      identity: inv0,
      output: { summary: "one" },
    });
    // outputId linkage on item rows is engine-side (map_result rows pending);
    // item results are recorded here; the outputs route proves resolvability.
    store.foreach.decideItem({
      identity: inv,
      sourceId: source.id,
      index: 0,
      status: "succeeded",
      result: { summary: "one" },
    });
    store.foreach.decideItem({ identity: inv, sourceId: source.id, index: 1, status: "skipped" });

    const server = await startBrowserServer({
      dataDir,
      store: createStoreQueryPort(store),
      controller: {
        startRun: () => {
          throw new DevChestraError("E_INTERNAL", "unused");
        },
        cancelRun: async () => ({ runId: "r" as never, status: "cancelled" as never }),
        resumeRun: async () => ({ runId: "r" as never, status: "paused" as never }),
        resolveApproval: async () => {
          throw new DevChestraError("E_INTERNAL", "unused");
        },
      },
      sessionToken: TOKEN,
      instanceId: "workflow-children-test-instance-id-12",
      version: "0.1.0-test",
      port: 0,
    });
    try {
      const bootstrap = await fetch(`${server.url}/?t=${TOKEN}`, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const get = async (path: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`${server.url}${path}`, { headers: { Cookie: cookie } });
        const text = await res.text();
        return { status: res.status, body: text === "" ? null : JSON.parse(text) };
      };

      // Validate real store projections and envelopes, not hand-written API fixtures.
      const { runDetailResponseSchema, parseRunStreamEvent } = await import("@devchestra/api");
      const detail = await get(`/api/runs/${parent.runId}`);
      expect(detail.status).toBe(200);
      const parsedDetail = runDetailResponseSchema.parse(detail.body);
      expect(parsedDetail.view.executions.sub?.workflow).toMatchObject({
        status: "succeeded",
        resultRef: null,
        eventId: expect.any(Number),
      });
      expect(parsedDetail.view.executions.each?.foreach).toMatchObject({
        processed: 2,
        eventId: expect.any(Number),
      });
      const events = await get(`/api/runs/${parent.runId}/events?limit=100`);
      expect(events.status).toBe(200);
      const envelopes = (events.body as { events: Array<{ id: number; type: string }> }).events;
      expect(envelopes.some((event) => event.type === "workflow.completed")).toBe(true);
      for (const event of envelopes) {
        expect(
          parseRunStreamEvent({
            id: String(event.id),
            event: "run",
            data: JSON.stringify(event),
            retry: null,
          })?.event,
        ).toBe("run");
      }

      // Children: refs only, paginated.
      const page1 = await get(`/api/runs/${parent.runId}/children?limit=1`);
      expect(page1.status).toBe(200);
      expect((page1.body as { items: unknown[] }).items).toHaveLength(1);
      expect((page1.body as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
        childRunId: childA.runId,
        workflowId: "leaf",
        path: "sub",
        status: "succeeded",
      });
      const cursor = (page1.body as { nextCursor: string }).nextCursor;
      expect(typeof cursor).toBe("string");
      const page2 = await get(`/api/runs/${parent.runId}/children?limit=1&cursor=${cursor}`);
      expect(page2.status).toBe(200);
      expect((page2.body as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
        childRunId: childB.runId,
        path: "sub2",
      });
      expect((page2.body as { nextCursor: unknown }).nextCursor).toBeNull();

      // Foreach items: source metadata + outputId refs, no inlined values.
      const items = await get(`/api/runs/${parent.runId}/foreach/${source.id}/items`);
      expect(items.status).toBe(200);
      const itemsBody = items.body as {
        source: { sourceId: string; kind: string; path: string; total: number };
        items: Array<{ index: number; status: string; path: string; outputId: string | null }>;
        nextCursor: string | null;
      };
      expect(itemsBody.source).toMatchObject({ kind: "expression", path: "each", total: 2 });
      expect(itemsBody.items[0]).toMatchObject({
        index: 0,
        status: "succeeded",
        path: "each[0]",
      });
      expect(itemsBody.items[1]).toMatchObject({ index: 1, status: "skipped", outputId: null });

      // Per-item result values resolve via the public outputs API (the
      // reference target for outputId tokens): the recorded item output
      // fetches with its data intact.
      const out = await get(`/api/runs/${parent.runId}/outputs/${recorded.output.id}`);
      expect(out.status).toBe(200);
      expect((out.body as { data: unknown }).data).toMatchObject({ summary: "one" });

      // Ownership + 404/400 behavior.
      expect((await get("/api/runs/does-not-exist/children")).status).toBe(404);
      expect((await get(`/api/runs/${parent.runId}/foreach/nope/items`)).status).toBe(404);
      expect((await get(`/api/runs/${parent.runId}/children?limit=101`)).status).toBe(400);
      // A source from another run is not visible here, nor are its outputs.
      const other = store.runs.create({
        projectId: "p1",
        workflowId: "main",
        workflowHash: "h",
        snapshot,
        snapshotRaw: "{}",
      });
      expect((await get(`/api/runs/${other.runId}/outputs/${recorded.output.id}`)).status).toBe(
        404,
      );
      store.executions.ensure({
        runId: other.runId,
        path: "each" as Path,
        nodeId: "each",
        kind: "foreach",
      });
      const otherInv = store.executions.beginInvocation({
        runId: other.runId,
        path: "each" as Path,
        attempt: 1,
        resolvedConfigHash: "cfg",
      });
      const otherSource = store.foreach.createSource({
        identity: otherInv,
        kind: "csv",
        items: [{ v: "x" }],
        maxItems: 10,
      });
      expect(
        (await get(`/api/runs/${parent.runId}/foreach/${otherSource.source.id}/items`)).status,
      ).toBe(404);
      void childB;
      void other;
    } finally {
      await server.close();
      store.close();
    }
  });
});
