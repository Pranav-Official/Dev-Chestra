import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry } from "@devchestra/adapters";
import { createEngine, type Engine } from "@devchestra/engine";
import { normalizeWorkflow, parseWorkflowJson } from "@devchestra/schema";
import {
  createAgentGateway,
  ExecTokenRegistry,
  OutputValidator,
  startLoopbackServer,
} from "@devchestra/server";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAKE_AGENT_BIN = join(REPO_ROOT, "tools/fake-agent/dist/main.js");
const SHIM_ENTRY = join(REPO_ROOT, "packages/mcp/dist/bin/shim.js");

const SCRIPT = [
  { type: "tool", name: "context_upsert", args: { key: "finding", value: "api latency p99 2.4s" } },
  { type: "submit", output: { result: "ok" } },
];

const FILE = {
  schemaVersion: 1,
  id: "handoff",
  name: "Handoff",
  context: [{ key: "goal", value: "ship it" }],
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Start", params: [] },
      {
        id: "writer",
        type: "agent",
        name: "Writer",
        cli: "fake",
        prompt: "Record the api finding for downstream agents.",
        output: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
        permissions: { network: false, write: [] },
        context: { project: "read", workflow: "read", execution: "readwrite" },
      },
      {
        id: "reader",
        type: "agent",
        name: "Reader",
        cli: "fake",
        prompt: "Use the recorded finding.",
        output: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
        permissions: { network: false, write: [] },
        context: { project: "read", workflow: "read", execution: "read" },
      },
      { id: "end", type: "end", name: "Done", status: "success", result: "true" },
    ],
    edges: [
      { id: "e1", from: "start", to: "writer" },
      { id: "e2", from: "writer", to: "reader" },
      { id: "e3", from: "reader", to: "end" },
    ],
  },
};

interface Harness {
  store: Store;
  engine: Engine;
  prompts: string[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "devchestra-context-handoff-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: root, kind: "folder" });

  const tokens = new ExecTokenRegistry({
    registerSecret: (token) => store.security.registerSecret(token, "exec-token"),
  });
  const validator = new OutputValidator();
  let port = 0;
  const app = createAgentGateway({
    tokens,
    submissions: store.submissions,
    context: store.contextPool,
    validator,
    port: () => port,
  });
  const listener = await startLoopbackServer(app);
  port = listener.port;

  const prompts: string[] = [];
  const base = createAdapterRegistry({
    nodeBin: process.execPath,
    fakeAgentBin: FAKE_AGENT_BIN,
    fakeScript: SCRIPT,
  }).get("fake");
  const adapter = {
    ...base,
    plan: (request: Parameters<typeof base.plan>[0]) => {
      prompts.push(request.prompt as string);
      return base.plan(request);
    },
  };
  const engine = createEngine({
    store,
    adapters: {
      ids: () => ["fake"],
      has: (id) => id === "fake",
      get: () => adapter as never,
    },
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: listener.url,
      issue: (scope) => {
        const token = tokens.issue({
          identity: scope.identity,
          toolset: "agent",
          outputSchema: scope.outputSchema,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
          context: scope.context,
        });
        return { token, revoke: () => tokens.revoke(token) };
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: SHIM_ENTRY,
    env: process.env,
    validateOutput: (schema, value) => validator.compile(schema).validate(value),
  });
  await engine.start();

  cleanups.push(async () => {
    tokens.clear();
    await listener.close();
    await engine.stop({ graceMs: 1_000 }).catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, engine, prompts };
}

describe("context pool handoff", () => {
  it("passes a writer note to the downstream reader prompt", async () => {
    const h = await harness();
    const parsed = parseWorkflowJson(JSON.stringify(FILE));
    if (!parsed.ok) throw parsed.error;
    const normalized = normalizeWorkflow(parsed.value);
    if (!normalized.ok) throw normalized.error;

    const outcome = await h.engine.run({
      projectId: "p1",
      workflowId: "handoff",
      snapshot: normalized.value,
      snapshotRaw: JSON.stringify(FILE),
      params: {},
      projectContext: [{ key: "stack", value: "node20" }],
    });
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.status).toBe("succeeded");

    // Linear chain: first captured prompt is the writer, second the reader.
    expect(h.prompts).toHaveLength(2);
    const [writerPrompt, readerPrompt] = h.prompts as [string, string];

    // Static pools freeze into every agent prompt.
    for (const prompt of [writerPrompt, readerPrompt]) {
      expect(prompt).toContain("[project]");
      expect(prompt).toContain("stack: node20");
      expect(prompt).toContain("[workflow]");
      expect(prompt).toContain("goal: ship it");
    }
    // The execution pool was empty when the writer ran; the reader sees the note.
    // (The shared note boilerplate mentions [execution]; match the section header.)
    expect(writerPrompt).not.toContain("[execution]\n");
    expect(readerPrompt).toContain("[execution]\n- finding: api latency p99 2.4s");

    const entry = h.store.contextPool.get(outcome.value.runId as never, "finding");
    expect(entry?.value).toBe("api latency p99 2.4s");
    expect(entry?.updatedByPath).toBe("writer");
  }, 120_000);
});
