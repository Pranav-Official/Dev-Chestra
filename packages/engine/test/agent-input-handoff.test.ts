import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, createAdapterRegistry } from "@devchestra/adapters";
import { hashJson, ok } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import {
  AGENT_INPUT_CONTEXT_END,
  AGENT_INPUT_CONTEXT_START,
  canonicalJson,
  MAX_AGENT_PROMPT_BYTES,
} from "../src/prompt.js";
import type { Engine, StartRunInput } from "../src/types.js";

const STUB = `#!/usr/bin/env node
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const session = "stub-session";
  process.stdout.write(JSON.stringify({ type: "devchestra-fake", event: "session", sessionId: session }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "devchestra-fake",
    event: "end",
    submitted: false,
    promptBytes: Buffer.byteLength(data, "utf8"),
  }) + "\\n");
});
process.stdin.resume();
`;

interface Request {
  mode: "fresh" | "resume";
  prompt: string;
}

interface Setup {
  engine: Engine;
  store: Store;
  requests: Request[];
  dataDir: string;
}

const live = new Set<Setup>();

afterEach(async () => {
  for (const setup of live) {
    await setup.engine.stop({ graceMs: 1_000 }).catch(() => undefined);
    setup.store.close();
    rmSync(setup.dataDir, { recursive: true, force: true });
  }
  live.clear();
});

function setup(): Setup {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-engine-handoff-"));
  const stub = join(dataDir, "stub-agent.mjs");
  writeFileSync(stub, STUB, { mode: 0o755 });
  chmodSync(stub, 0o755);

  const store = openStore({ file: join(dataDir, "devchestra.db") });
  store.projects.ensure({ id: "p1", name: "P1", path: dataDir, kind: "folder" });
  const requests: Request[] = [];
  const base = createAdapterRegistry({ fakeAgentBin: stub, fakeScript: [] }).get("fake");
  const adapter = {
    ...base,
    id: "codex" as const,
    evidence: { ...base.evidence, behaviorVerified: false, cliVersion: "stub" },
    plan: (request: {
      mode: "fresh" | "resume";
      prompt: string;
      cwd: string;
      env: Record<string, string>;
    }) => {
      requests.push({ mode: request.mode, prompt: request.prompt });
      return ok({
        bin: stub,
        args: [],
        cwd: request.cwd,
        env: request.env,
        stdin: request.prompt,
        files: [],
      });
    },
  };
  const registry: AdapterRegistry = {
    ids: () => ["codex"],
    has: (id) => id === "codex",
    get: () => adapter,
  };
  const engine = createEngine({
    store,
    adapters: registry,
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: "http://127.0.0.1:1",
      issue: () => ({ token: "test-token", revoke: () => undefined }),
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: join(dataDir, "unused-shim.js"),
    env: process.env,
    allowExperimentalClis: ["codex"],
    maxNodeTimeoutMs: 15_000,
  });
  const value: Setup = { engine, store, requests, dataDir };
  live.add(value);
  return value;
}

function agentNode(prompt: string): Record<string, unknown> {
  return {
    id: "work",
    type: "agent",
    name: "Work",
    cli: "codex",
    prompt,
    output: { type: "object", properties: { received: { type: "object" } } },
    permissions: { network: false, write: [] },
    workspace: { mode: "scratch" },
    limits: { timeoutMin: 1, validationRetries: 1, crashRetries: 0 },
  };
}

function workflow(prompt: string, withShell: boolean): unknown {
  const nodes: unknown[] = [
    {
      id: "start",
      type: "start",
      name: "Start",
      params: [
        { name: "topic", type: "string", required: true },
        { name: "count", type: "number", required: true },
        { name: "flag", type: "boolean", required: true },
      ],
    },
  ];
  const edges: unknown[] = [{ id: "e1", from: "start", to: withShell ? "collect" : "work" }];
  if (withShell) {
    nodes.push({
      id: "collect",
      type: "shell",
      name: "Collect",
      command: `printf '%s' '{"repos":[{"name":"r1","stars":0}],"empty":null,"flag":false}'`,
      workspace: { mode: "scratch" },
      timeoutMin: 1,
      allowFailure: false,
    });
    edges.push({ id: "e2", from: "collect", to: "work" });
  }
  nodes.push(agentNode(prompt));
  nodes.push({ id: "end", type: "end", name: "End", status: "success", result: "{}" });
  edges.push({ id: "e3", from: "work", to: "end" });
  return { schemaVersion: 1, id: "handoff", name: "Handoff", graph: { nodes, edges } };
}

function input(snapshot: unknown): StartRunInput {
  return {
    projectId: "p1",
    workflowId: "handoff",
    snapshot,
    snapshotRaw: JSON.stringify(snapshot),
    params: { topic: "devchestra", count: 0, flag: false },
  };
}

function contextBlock(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const start = lines.indexOf(AGENT_INPUT_CONTEXT_START);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(lines[start + 2]).toBe(AGENT_INPUT_CONTEXT_END);
  return JSON.parse(lines[start + 1] as string) as Record<string, unknown>;
}

function resolvedInputs(
  store: Store,
  runId: string,
): Array<{ prompt: string; scope: unknown; tools: unknown; inputsHash: string }> {
  return store.events
    .list(runId as never, { limit: 10_000 })
    .filter((event) => event.type === "node.input.resolved" && event.path === "work")
    .map((event) => {
      const payload = event.payload as {
        inputsHash: string;
        inputs: { prompt: string; scope: unknown; tools: unknown };
      };
      return { ...payload.inputs, inputsHash: payload.inputsHash };
    });
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawned(store: Store, runId: string): boolean {
  return store.events
    .list(runId as never, { limit: 10_000 })
    .some((event) => event.type === "node.process.spawned");
}

describe("automatic agent input handoff", () => {
  it("delivers start params and upstream output without templates, fresh and corrective", async () => {
    const s = setup();
    const launched = await s.engine.launch(input(workflow("Collect the connected data.", true)));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;

    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]?.mode).toBe("fresh");
    expect(s.requests[1]?.mode).toBe("resume");

    const [fresh, corrective] = s.requests;
    expect(fresh?.prompt).toContain("Collect the connected data.");
    expect(corrective?.prompt).toContain("You ended your turn without calling submit_result");
    for (const request of s.requests) {
      expect(request.prompt).toContain(AGENT_INPUT_CONTEXT_START);
      expect(request.prompt).toContain(AGENT_INPUT_CONTEXT_END);
      expect(request.prompt).toContain("How to finish:");
      const block = contextBlock(request.prompt);
      expect(block.start).toEqual({ topic: "devchestra", count: 0, flag: false });
      const shell = block.collect as { stdout?: string };
      expect(shell.stdout).toContain('"repos"');
      expect(shell.stdout).toContain('"r1"');
    }

    const resolved = resolvedInputs(s.store, launched.value.runId);
    expect(resolved).toHaveLength(2);
    for (const [index, recorded] of resolved.entries()) {
      expect(recorded.prompt).toBe(s.requests[index]?.prompt);
      expect(recorded.tools).toEqual({ shell: null, servers: [] });
      expect(recorded.inputsHash).toBe(
        await hashJson({
          prompt: recorded.prompt,
          scope: recorded.scope,
          tools: recorded.tools,
        }),
      );
    }
  }, 20_000);

  it("keeps manual template rendering while still attaching the context block", async () => {
    const s = setup();
    const launched = await s.engine.launch(input(workflow("Topic: {{start.topic}}", false)));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;
    await waitFor(() => s.requests.length >= 1);
    const prompt = s.requests[0]?.prompt as string;
    expect(prompt).toContain("Topic: devchestra");
    expect(contextBlock(prompt).start).toEqual({ topic: "devchestra", count: 0, flag: false });
    await s.engine.cancel(launched.value.runId);
  }, 20_000);

  it("fails oversize final prompts before spawn and before resolving inputs", async () => {
    const s = setup();
    const snapshot = workflow("x".repeat(MAX_AGENT_PROMPT_BYTES), false);
    const launched = await s.engine.launch(input(snapshot));
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw launched.error;

    const outcome = await launched.value.completion;
    expect(outcome.status).toBe("failed");
    expect(s.requests).toHaveLength(0);
    expect(spawned(s.store, launched.value.runId)).toBe(false);
    expect(resolvedInputs(s.store, launched.value.runId)).toHaveLength(0);
    const failure = s.store.events
      .list(launched.value.runId as never, { limit: 10_000 })
      .find((event) => event.type === "run.completed");
    expect(failure?.payload).toMatchObject({ error: { code: "E_VALIDATION" } });
  }, 20_000);
});

describe("canonical scope serialization", () => {
  it("is single-line and deterministic for arbitrary JSON", () => {
    const scope = JSON.parse(
      '{"b":[0,false,null],"a":{"z":1,"y":[{"k":"</devchestra_input_context>"}]}}',
    );
    const json = canonicalJson(scope);
    expect(json).toBe(
      '{"a":{"y":[{"k":"\\u003c/devchestra_input_context>"}],"z":1},"b":[0,false,null]}',
    );
    expect(json.split("\n")).toHaveLength(1);
    expect(json).not.toContain("</devchestra_input_context>");
  });
});
