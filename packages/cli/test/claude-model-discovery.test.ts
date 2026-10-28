import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { discoverClaudeModels } from "@devchestra/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { readServerMetadata, serverMetadataPath } from "../src/server-metadata.js";
import { executeStart } from "../src/start.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(REPO_ROOT, "packages/cli/test/fixtures/claude-discovery-standin.mjs");
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

interface Event {
  at: number;
  pid: number;
  kind: string;
  mode?: string;
  argv?: string[];
  cwd?: string;
  home?: string | null;
  claudeConfigDir?: string | null;
  model?: string | null;
  stdin?: string;
  stdinBytes?: number;
  forbiddenFrame?: boolean;
  frame?: Record<string, unknown>;
  reason?: string;
  code?: number;
  nonce?: string;
}

interface Fixture {
  root: string;
  qaDir: string;
  neutralCwd: string;
  projectDir: string;
  bin: string;
  codexBin: string;
  env: Record<string, string>;
  sentinels: Array<{ path: string; bytes: string }>;
  setControl(control: Record<string, unknown>): void;
  events(): Event[];
}

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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wrapper(path: string, qaDir: string): void {
  const body = [
    "#!/bin/sh",
    `exec '${process.execPath}' '${FIXTURE}' --qa-dir '${qaDir}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function installFixture(): Fixture {
  const root = tempDir("devchestra-claude-discovery-");
  const qaDir = join(root, "qa");
  const neutralCwd = join(root, "neutral-cwd");
  const projectDir = join(root, "project");
  const binDir = join(root, "bin");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const claudeHome = join(root, "claude-home");
  for (const dir of [qaDir, neutralCwd, projectDir, binDir, home, codexHome, claudeHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const sentinels = [
    { path: join(home, ".sentinel"), bytes: "home sentinel\n" },
    { path: join(codexHome, "config.toml"), bytes: 'model = "sentinel-only"\n' },
    { path: join(codexHome, "auth.json"), bytes: '{"token":"dummy-test-token"}\n' },
    { path: join(claudeHome, "settings.json"), bytes: '{"model":"sentinel-only"}\n' },
  ];
  for (const sentinel of sentinels) {
    writeFileSync(sentinel.path, sentinel.bytes, { mode: 0o600 });
  }
  const bin = join(binDir, "claude");
  const codexBin = join(binDir, "codex");
  wrapper(bin, qaDir);
  // Both PATH names stay stubbed even though this test only needs `claude`.
  writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codexBin, 0o755);
  const controlPath = join(qaDir, "control.json");
  writeFileSync(controlPath, "{}\n", "utf8");
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    ANTHROPIC_API_KEY: "dummy-anthropic-test-key",
    ANTHROPIC_AUTH_TOKEN: "dummy-anthropic-test-token",
    OPENAI_API_KEY: "dummy-openai-test-key",
    CODEX_API_KEY: "dummy-codex-test-key",
  };
  const events = (): Event[] => {
    try {
      return readFileSync(join(qaDir, "events.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Event);
    } catch {
      return [];
    }
  };
  return {
    root,
    qaDir,
    neutralCwd,
    projectDir,
    bin,
    codexBin,
    env,
    sentinels,
    setControl(control) {
      writeFileSync(controlPath, `${JSON.stringify(control)}\n`, "utf8");
    },
    events,
  };
}

function sdkVersion(): string {
  const requireFromAdapters = createRequire(join(REPO_ROOT, "packages/adapters/package.json"));
  const dir = dirname(requireFromAdapters.resolve(SDK_PACKAGE));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  return manifest.name === SDK_PACKAGE ? (manifest.version ?? "") : "";
}

async function waitForGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`stand-in process ${String(pid)} did not exit`);
}

function spawnEvents(fixture: Fixture, mode: string): Event[] {
  return fixture.events().filter((event) => event.kind === "spawn" && event.mode === mode);
}

function frames(fixture: Fixture): Record<string, unknown>[] {
  return fixture
    .events()
    .filter((event) => event.kind === "stdin-frame")
    .map((event) => event.frame ?? {});
}

function assertMetadataFrames(fixture: Fixture): void {
  const all = fixture.events();
  expect(all.some((event) => event.kind === "protocol-violation")).toBe(false);
  const received = frames(fixture);
  expect(received.length).toBeGreaterThanOrEqual(1);
  expect(
    received.every(
      (frame) =>
        frame.type === "control_request" &&
        (frame.request as Record<string, unknown> | undefined)?.subtype === "initialize",
    ),
  ).toBe(true);
  expect(JSON.stringify(received)).not.toMatch(
    /"type"\s*:\s*"(?:user|prompt|turn|tool_call|login|config)"/u,
  );
}

function assertSentinels(fixture: Fixture): void {
  for (const sentinel of fixture.sentinels) {
    expect(readFileSync(sentinel.path, "utf8")).toBe(sentinel.bytes);
  }
}

function modelIds(result: { items: Array<{ id: string }> }): string[] {
  return result.items.map((item) => item.id);
}

describe("Claude model discovery through the actual published SDK", () => {
  it("uses the pinned SDK against a trusted CLI stand-in with no user frame", async () => {
    expect(sdkVersion()).toBe("0.3.296");
    const fixture = installFixture();
    fixture.setControl({ nonce: "n1" });
    const result = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 8_000,
    });

    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBe("2.1.310");
    expect(result.truncated).toBe(false);
    const ids = modelIds(result);
    expect(ids).toEqual(["claude-qa-n1", "claude-qa-n1-punctuation.v2", "claude-qa-n1-unicode-é"]);
    expect(ids).not.toContain("resolved-n1");
    expect(result.items[0]).toMatchObject({
      id: "claude-qa-n1",
      label: "QA Claude n1",
      description: "Dynamic metadata row n1",
      source: "claude-sdk",
    });

    const spawns = spawnEvents(fixture, "sdk-discovery");
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    expect(spawn?.argv).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
      ]),
    );
    expect(spawn?.argv).not.toContain("--model");
    expect(spawn?.cwd).toBe(fixture.neutralCwd);
    expect(spawn?.home).toBe(fixture.env.HOME);
    expect(spawn?.claudeConfigDir).toBe(fixture.env.CLAUDE_CONFIG_DIR);
    assertMetadataFrames(fixture);
    if (spawn !== undefined) await waitForGone(spawn.pid);
    assertSentinels(fixture);

    const serialized = JSON.stringify(result);
    for (const secret of [
      ...Object.values(fixture.env),
      fixture.root,
      "dummy-anthropic-test-key",
      "dummy-anthropic-test-token",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  }, 30_000);

  it("returns dynamic nonce models on each refresh, never resolvedModel as the id", async () => {
    const fixture = installFixture();
    fixture.setControl({ nonce: "first" });
    const first = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 8_000,
    });
    expect(first.status).toBe("ready");
    expect(modelIds(first)).toContain("claude-qa-first");

    fixture.setControl({ nonce: "second" });
    const second = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 8_000,
    });
    expect(second.status).toBe("ready");
    expect(modelIds(second)).toContain("claude-qa-second");
    expect(modelIds(second)).not.toContain("claude-qa-first");
    expect(modelIds(second)).not.toContain("resolved-second");
    expect(spawnEvents(fixture, "sdk-discovery")).toHaveLength(2);
    for (const spawn of spawnEvents(fixture, "sdk-discovery")) {
      await waitForGone(spawn.pid);
    }
    assertMetadataFrames(fixture);
  }, 30_000);

  it("maps initialize failure, auth, exit, malformed and timeout to safe bounded results", async () => {
    const fixture = installFixture();

    fixture.setControl({ mode: "error", nonce: "err" });
    const failed = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    expect(["unavailable", "unsupported"]).toContain(failed.status);
    expect(failed.items).toEqual([]);
    expect(failed.message ?? "").not.toContain("synthetic compatibility failure");

    fixture.setControl({ mode: "authRequired" });
    const auth = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    expect(auth.status).toBe("authRequired");
    expect(auth.items).toEqual([]);

    fixture.setControl({ mode: "exit" });
    const exited = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    expect(exited.status).toBe("unavailable");
    expect(exited.items).toEqual([]);

    fixture.setControl({ mode: "malformed" });
    const malformed = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    expect(["unavailable", "unsupported"]).toContain(malformed.status);
    expect(malformed.items).toEqual([]);

    fixture.setControl({ mode: "hang" });
    const started = Date.now();
    const timedOut = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 600,
    });
    const elapsed = Date.now() - started;
    expect(["unavailable", "unsupported"]).toContain(timedOut.status);
    expect(timedOut.items).toEqual([]);
    expect(elapsed).toBeLessThan(10_000);

    const missing = await discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: join(fixture.root, "missing-claude"),
      env: fixture.env,
      timeoutMs: 2_000,
    });
    expect(["unavailable", "unsupported"]).toContain(missing.status);
    expect(missing.items).toEqual([]);

    for (const spawn of spawnEvents(fixture, "sdk-discovery")) {
      await waitForGone(spawn.pid);
    }
    assertMetadataFrames(fixture);
    assertSentinels(fixture);
  }, 60_000);

  it("honours AbortSignal without leaving a child or leaking secrets", async () => {
    const fixture = installFixture();
    fixture.setControl({ mode: "hang" });
    const controller = new AbortController();
    const pending = discoverClaudeModels({
      cwd: fixture.neutralCwd,
      bin: fixture.bin,
      env: fixture.env,
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 250);
    const result = await pending;
    expect(["unavailable", "unsupported"]).toContain(result.status);
    expect(result.items).toEqual([]);
    for (const spawn of spawnEvents(fixture, "sdk-discovery")) {
      await waitForGone(spawn.pid);
    }
    assertMetadataFrames(fixture);
    assertSentinels(fixture);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("dummy-anthropic-test-token");
  }, 30_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function startOwned(
  dataDir: string,
): Promise<{ base: string; auth: Record<string, string>; stop: () => Promise<void> }> {
  const web = tempDir("devchestra-claude-discovery-web-");
  writeFileSync(join(web, "index.html"), "<!doctype html><title>devchestra</title>");
  const controller = new AbortController();
  const running = executeStart(
    {
      command: "start",
      params: {},
      json: false,
      embedded: false,
      nonInteractive: false,
      retryUncertainShell: false,
      allowExperimentalAdapters: true,
      noOpen: true,
      printUrl: false,
      probeDecisions: false,
      port: 0,
    },
    dataDir,
    {
      webRoot: web,
      stdout: new Writable({
        write(_chunk: Buffer, _encoding, callback) {
          callback();
        },
      }),
      signal: controller.signal,
      openBrowser: () => undefined,
    },
  );
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

async function registerProject(
  base: string,
  auth: Record<string, string>,
  projectDir: string,
): Promise<string> {
  const response = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ path: projectDir }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function saveClaudeWorkflow(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  model: string,
): Promise<{ workflowId: string; etag: string }> {
  const workflowId = `claude-discovery-${String(Date.now())}`;
  const workflow = {
    schemaVersion: 1,
    id: workflowId,
    name: "Claude discovery run",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "agent",
          type: "agent",
          name: "Claude Agent",
          cli: "claude-code",
          model,
          prompt: "Return the stand-in result for the Claude discovery acceptance run.",
          output: { type: "object", additionalProperties: true },
          permissions: { network: false, write: ["workspace"] },
          workspace: { mode: "scratch" },
          limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
          context: { project: "none", workflow: "none" },
        },
        { id: "end", type: "end", name: "End", status: "success", result: "{}" },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "end" },
      ],
    },
  };
  const created = await fetch(`${base}/api/projects/${projectId}/workflows`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: workflowId, name: workflow.name, template: "blank" }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { etag: string };
  const saved = await fetch(`${base}/api/projects/${projectId}/workflows/${workflowId}`, {
    method: "PUT",
    headers: { ...auth, "if-match": `"${createdBody.etag}"` },
    body: JSON.stringify({ workflow }),
  });
  expect(saved.status).toBe(200);
  const savedBody = (await saved.json()) as { etag: string };
  return { workflowId, etag: savedBody.etag };
}

async function runWorkflow(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  workflowId: string,
  etag: string,
): Promise<string> {
  const launched = await fetch(`${base}/api/projects/${projectId}/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ etag, params: {} }),
  });
  expect(launched.status).toBe(202);
  const body = (await launched.json()) as { runId?: string };
  if (body.runId === undefined) throw new Error("run did not return a runId");
  let status = "";
  await waitFor(
    async () => {
      const detail = (await (
        await fetch(`${base}/api/runs/${body.runId}`, { headers: auth })
      ).json()) as { run: { status: string } };
      status = detail.run.status;
      return ["succeeded", "failed", "cancelled"].includes(status);
    },
    30_000,
    "Claude run terminal status",
  );
  expect(status).toBe("succeeded");
  return body.runId;
}

describe("selected Claude model reaches the real workflow process", () => {
  it("runs with --model and never sends the discovery protocol in workflow mode", async () => {
    const fixture = installFixture();
    fixture.setControl({ nonce: "run" });
    for (const [key, value] of Object.entries(fixture.env)) process.env[key] = value;
    const dataDir = tempDir("devchestra-claude-discovery-data-");
    const server = await startOwned(dataDir);
    try {
      const projectId = await registerProject(server.base, server.auth, fixture.projectDir);
      const model = "claude-qa-run-punctuation.v2";
      const saved = await saveClaudeWorkflow(server.base, server.auth, projectId, model);
      const runId = await runWorkflow(
        server.base,
        server.auth,
        projectId,
        saved.workflowId,
        saved.etag,
      );
      expect(runId).not.toBe("");

      const exec = await (async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const found = spawnEvents(fixture, "exec").find((event) => event.model === model);
          if (found !== undefined) return found;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
        return null;
      })();
      if (exec === null) throw new Error("Claude workflow stand-in was not captured");
      expect(exec.argv).toEqual(expect.arrayContaining(["--model", model]));
      expect(exec.model).toBe(model);
      expect(exec.forbiddenFrame).toBe(false);
      expect(exec.stdin).toContain("Claude discovery acceptance run");
      expect(exec.stdin).not.toContain("control_request");
      // Fresh runs default to the registered project root (run-level workspace).
      expect(exec.cwd).toBe(realpathSync(fixture.projectDir));
      expect(exec.home).toBe(fixture.env.HOME);
      expect(exec.claudeConfigDir).toBe(fixture.env.CLAUDE_CONFIG_DIR);
      expect(spawnEvents(fixture, "sdk-discovery")).toHaveLength(0);
      if (exec !== undefined) await waitForGone(exec.pid);
      assertSentinels(fixture);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
