import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { readServerMetadata, serverMetadataPath } from "../src/server-metadata.js";
import { executeStart } from "../src/start.js";

type Profile = "codex" | "claude-code";

interface CaptureMeta {
  profile: Profile;
  argv: string[];
  cwd: string;
  home: string | null;
  codexHome: string | null;
  modelArg: string | null;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(REPO_ROOT, "packages/cli/test/fixtures/model-selection-agent.mjs");
const ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

const cleanups: (() => void)[] = [];
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempDir(prefix = "devchestra-model-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function webRoot(): string {
  const dir = tempDir("devchestra-model-web-");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>devchestra</title>");
  return dir;
}

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: "start",
    params: {},
    json: false,
    nonInteractive: false,
    retryUncertainShell: false,
    noOpen: true,
    printUrl: false,
    probeDecisions: false,
    ...overrides,
  };
}

function capture(): { stream: NodeJS.WritableStream } {
  return {
    stream: new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback();
      },
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

interface TestEnv {
  captureDir: string;
  home: string;
  codexHome: string;
  claudeHome: string;
  sentinels: Array<{ path: string; bytes: string }>;
}

function installTestEnv(): TestEnv {
  const captureDir = tempDir("devchestra-model-capture-");
  const binDir = tempDir("devchestra-model-bin-");
  const home = tempDir("devchestra-model-home-");
  const codexHome = tempDir("devchestra-model-codex-home-");
  const claudeHome = tempDir("devchestra-model-claude-home-");
  const sentinels = [
    { path: join(home, ".sentinel"), bytes: "home sentinel\n" },
    { path: join(codexHome, "config.toml"), bytes: 'model = "sentinel-only"\n' },
    { path: join(codexHome, "auth.json"), bytes: '{"token":"dummy-test-token"}\n' },
    { path: join(claudeHome, "settings.json"), bytes: '{"model":"sentinel-only"}\n' },
  ];
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  for (const sentinel of sentinels) {
    writeFileSync(sentinel.path, sentinel.bytes, { mode: 0o600 });
  }
  const stubs: [string, Profile][] = [
    ["claude", "claude-code"],
    ["codex", "codex"],
  ];
  for (const [name, profile] of stubs) {
    const file = join(binDir, name);
    const script = [
      "#!/bin/sh",
      `DEVCHESTRA_TEST_CAPTURE_DIR='${captureDir}' DEVCHESTRA_TEST_PROFILE='${profile}' exec '${process.execPath}' '${FIXTURE}' "$@"`,
      "",
    ].join("\n");
    writeFileSync(file, script, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return { captureDir, home, codexHome, claudeHome, sentinels };
}

function modelWorkflow(cli: Profile, model: string | undefined) {
  const agent: Record<string, unknown> = {
    id: "agent",
    type: "agent",
    name: "Model Agent",
    cli,
    prompt: "Return the stand-in result.",
    output: { type: "object", additionalProperties: true },
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
    limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
    context: { project: "none", workflow: "none" },
  };
  if (model !== undefined) agent.model = model;
  return {
    schemaVersion: 1,
    id: `model-${cli}${model === undefined ? "-default" : ""}`,
    name: `Model ${cli}`,
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        agent,
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "end" },
      ],
    },
  };
}

async function registerProject(
  base: string,
  auth: Record<string, string>,
  projectDir: string,
): Promise<string> {
  const response = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ path: projectDir, seedStarters: false }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function createAndSaveWorkflow(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  cli: Profile,
  model: string | undefined,
): Promise<{ workflowId: string; etag: string }> {
  const fixture = modelWorkflow(cli, model);
  const workflowId = fixture.id;
  const created = await fetch(`${base}/api/projects/${projectId}/workflows`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: workflowId, name: fixture.name, template: "blank" }),
  });
  expect(created.status).toBe(201);
  const createdDocument = (await created.json()) as { etag: string };
  const saved = await fetch(`${base}/api/projects/${projectId}/workflows/${workflowId}`, {
    method: "PUT",
    headers: { ...auth, "if-match": `"${createdDocument.etag}"` },
    body: JSON.stringify({ workflow: fixture }),
  });
  expect(saved.status).toBe(200);
  const savedDocument = (await saved.json()) as { etag: string };
  return { workflowId, etag: savedDocument.etag };
}

async function startOwned(
  dataDir: string,
): Promise<{ base: string; auth: Record<string, string>; stop: () => Promise<void> }> {
  const controller = new AbortController();
  const out = capture();
  const running = executeStart(options({ port: 0 }), dataDir, {
    webRoot: webRoot(),
    stdout: out.stream,
    signal: controller.signal,
    openBrowser: () => undefined,
  });
  running.catch(() => undefined);
  await waitFor(() => existsSync(serverMetadataPath(dataDir)), 10_000, "server metadata");
  const read = await readServerMetadata(dataDir);
  if (read.status !== "valid") throw new Error("server metadata is not valid");
  return {
    base: `http://127.0.0.1:${read.value.port}`,
    auth: {
      "x-devchestra-token": read.value.token,
      "x-devchestra-csrf": "1",
      "content-type": "application/json",
    },
    stop: async () => {
      controller.abort();
      await running.catch(() => undefined);
    },
  };
}

function readCapture(captureDir: string, profile: Profile): CaptureMeta {
  const files = readdirSync(captureDir).filter(
    (file) => file.startsWith(`agent-${profile}-`) && file.endsWith(".json"),
  );
  expect(files).toHaveLength(1);
  const file = files[0];
  if (file === undefined) throw new Error(`missing ${profile} capture`);
  return JSON.parse(readFileSync(join(captureDir, file), "utf8")) as CaptureMeta;
}

async function runWorkflow(
  server: { base: string; auth: Record<string, string> },
  projectDir: string,
  cli: Profile,
  model: string | undefined,
): Promise<void> {
  const projectId = await registerProject(server.base, server.auth, projectDir);
  const saved = await createAndSaveWorkflow(server.base, server.auth, projectId, cli, model);
  const launched = await fetch(
    `${server.base}/api/projects/${projectId}/workflows/${saved.workflowId}/runs`,
    {
      method: "POST",
      headers: server.auth,
      body: JSON.stringify({ etag: saved.etag, params: {} }),
    },
  );
  const reply = (await launched.json()) as { runId?: string; error?: { message?: string } };
  if (launched.status !== 202) {
    throw new Error(`start failed ${String(launched.status)}: ${reply.error?.message ?? "?"}`);
  }
  if (reply.runId === undefined) throw new Error("start run did not return a runId");
  let status = "";
  await waitFor(
    async () => {
      const detail = (await (
        await fetch(`${server.base}/api/runs/${reply.runId}`, { headers: server.auth })
      ).json()) as { run: { status: string } };
      status = detail.run.status;
      return ["succeeded", "failed", "cancelled"].includes(status);
    },
    30_000,
    `${cli} run terminal status`,
  );
  expect(status).toBe("succeeded");
}

describe("selected model reaches the actual CLI invocation", () => {
  it.each([
    ["codex", "-m"],
    ["claude-code", "--model"],
  ] as const)("passes the exact node.model to %s", async (cli, flag) => {
    const env = installTestEnv();
    const dataDir = tempDir();
    const projectDir = tempDir("devchestra-model-project-");
    const model = `exact-model-${cli}-${String(Date.now())}`;
    const server = await startOwned(dataDir);
    try {
      await runWorkflow(server, projectDir, cli, model);
      const capture = readCapture(env.captureDir, cli);
      const index = capture.argv.indexOf(flag);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(capture.argv[index + 1]).toBe(model);
      expect(capture.modelArg).toBe(model);
      expect(capture.home).toBe(env.home);
      if (cli === "codex") expect(capture.codexHome).toBe(env.codexHome);
      for (const sentinel of env.sentinels) {
        expect(readFileSync(sentinel.path, "utf8")).toBe(sentinel.bytes);
      }
    } finally {
      await server.stop();
    }
  });

  it("omits the model flag when node.model is absent", async () => {
    const env = installTestEnv();
    const dataDir = tempDir();
    const projectDir = tempDir("devchestra-model-project-");
    const server = await startOwned(dataDir);
    try {
      await runWorkflow(server, projectDir, "codex", undefined);
      const capture = readCapture(env.captureDir, "codex");
      expect(capture.argv).not.toContain("-m");
      expect(capture.modelArg).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
