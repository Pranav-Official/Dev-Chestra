import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createAdapterRegistry } from "@devchestra/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { readServerMetadata, serverMetadataPath } from "../src/server-metadata.js";
import { executeStart } from "../src/start.js";

type Profile = "codex" | "claude-code";

const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function tempDir(prefix = "devchestra-experimental-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function webRoot(): string {
  const dir = tempDir("devchestra-experimental-web-");
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

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function installCliStubs(): { marker: string } {
  const dir = tempDir("devchestra-experimental-stubs-");
  const marker = join(dir, "invoked.marker");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  --version|-v) printf "stub 0.0.0\\n"; exit 0 ;;',
    "esac",
    `printf "invoked\\n" >> '${marker}'`,
    "exit 1",
    "",
  ].join("\n");
  for (const name of ["codex", "claude"]) {
    const file = join(dir, name);
    writeFileSync(file, script, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  return { marker };
}

function experimentalWorkflow(cli: Profile) {
  const agent = (id: string) => ({
    id,
    type: "agent",
    name: id,
    cli,
    prompt: `Run the ${id} step.`,
    output: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string", maxLength: 2000 },
      },
    },
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
    limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
    context: { project: "none", workflow: "none" },
  });
  return {
    schemaVersion: 1,
    id: `experimental-${cli}`,
    name: `Experimental ${cli}`,
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        agent("first"),
        agent("second"),
        { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
      ],
      edges: [
        { id: "e1", from: "start", to: "first" },
        { id: "e2", from: "first", to: "second" },
        { id: "e3", from: "second", to: "done" },
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
    body: JSON.stringify({ path: projectDir }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

type RunReply = {
  error?: { code?: string; message?: string };
  runId?: string;
  status?: string;
};

async function postRun(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: RunReply }> {
  const response = await fetch(`${base}/api/projects/${projectId}/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, reply: (await response.json()) as RunReply };
}

async function createAndSaveWorkflow(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  cli: Profile,
): Promise<{ workflowId: string; etag: string }> {
  const fixture = experimentalWorkflow(cli);
  const workflowId = fixture.id;
  const created = await fetch(`${base}/api/projects/${projectId}/workflows`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: workflowId, name: fixture.name, template: "blank" }),
  });
  expect(created.status).toBe(201);
  const createdDocument = (await created.json()) as { etag: string };
  expect(typeof createdDocument.etag).toBe("string");

  const saved = await fetch(`${base}/api/projects/${projectId}/workflows/${workflowId}`, {
    method: "PUT",
    headers: { ...auth, "if-match": `"${createdDocument.etag}"` },
    body: JSON.stringify({ workflow: fixture }),
  });
  expect(saved.status).toBe(200);
  const savedDocument = (await saved.json()) as { etag: string };
  expect(typeof savedDocument.etag).toBe("string");
  return { workflowId, etag: savedDocument.etag };
}

async function postWorkflowRun(
  base: string,
  auth: Record<string, string>,
  projectId: string,
  workflowId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: RunReply }> {
  const response = await fetch(`${base}/api/projects/${projectId}/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, reply: (await response.json()) as RunReply };
}

async function getJson(base: string, path: string, auth: Record<string, string>): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers: auth });
  expect(response.status).toBe(200);
  return response.json();
}

async function startOwned(
  dataDir: string,
  cliOptions: CliOptions,
): Promise<{
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}> {
  const controller = new AbortController();
  const out = capture();
  const running = executeStart(cliOptions, dataDir, {
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

describe("experimental adapter launch over the real CLI HTTP server", () => {
  it("rejects bodies that try to inject launch options", async () => {
    const { marker } = installCliStubs();
    const dataDir = tempDir();
    const projectDir = tempDir("devchestra-experimental-project-");
    writeFileSync(join(projectDir, "workflow.json"), JSON.stringify(experimentalWorkflow("codex")));
    const server = await startOwned(dataDir, options({ port: 0 }));
    try {
      const projectId = await registerProject(server.base, server.auth, projectDir);
      const override = await postRun(server.base, server.auth, projectId, {
        workflowFile: "workflow.json",
        params: {},
        allowExperimentalAdapters: true,
        fakeScript: "/tmp/untrusted.json",
      });
      expect(override.status).toBe(400);
      expect(override.reply.error?.message).not.toContain("--allow-experimental-adapters");

      const runs = (await getJson(server.base, `/api/runs?project=${projectId}`, server.auth)) as {
        items: unknown[];
      };
      expect(runs.items).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it.each(["codex", "claude-code"] as const)(
    "launches a two-node %s workflow when the flag is set",
    async (cli) => {
      const adapters = createAdapterRegistry();
      expect(adapters.get("codex").evidence.behaviorVerified).toBe(false);
      expect(adapters.get("claude-code").evidence.behaviorVerified).toBe(false);

      const { marker } = installCliStubs();
      const dataDir = tempDir();
      const projectDir = tempDir("devchestra-experimental-project-");
      const server = await startOwned(dataDir, options({ port: 0 }));
      try {
        const projectId = await registerProject(server.base, server.auth, projectDir);
        const saved = await createAndSaveWorkflow(server.base, server.auth, projectId, cli);
        const launched = await postWorkflowRun(
          server.base,
          server.auth,
          projectId,
          saved.workflowId,
          { etag: saved.etag, params: {} },
        );
        expect(launched.status).toBe(202);
        const runId = launched.reply.runId;
        if (runId === undefined) throw new Error("start run did not return a runId");

        const created = (await getJson(server.base, `/api/runs/${runId}`, server.auth)) as {
          run: { status: string };
        };
        expect(typeof created.run.status).toBe("string");

        await waitFor(() => existsSync(marker), 15_000, `${cli} stub invocation`);
        expect(readFileSync(marker, "utf8")).toContain("invoked");

        let status = "";
        await waitFor(
          async () => {
            const detail = (await getJson(server.base, `/api/runs/${runId}`, server.auth)) as {
              run: { status: string };
            };
            status = detail.run.status;
            return ["succeeded", "failed", "cancelled"].includes(status);
          },
          30_000,
          `${cli} run terminal status`,
        );
        expect(status).toBe("failed");

        const durable = (await getJson(server.base, `/api/runs/${runId}`, server.auth)) as {
          run: { id: string; status: string };
        };
        expect(durable.run.id).toBe(runId);
      } finally {
        await server.stop();
      }
    },
  );
});
