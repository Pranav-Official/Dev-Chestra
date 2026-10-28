import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@relay/core";
import { ok } from "@relay/core";
import type { Engine, StartRunInput } from "@relay/engine";
import { afterEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { readServerMetadata, serverMetadataPath } from "../src/server-metadata.js";
import { executeStart } from "../src/start.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix = "relay-cli-prop-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Relay Test",
      GIT_AUTHOR_EMAIL: "relay@example.invalid",
      GIT_COMMITTER_NAME: "Relay Test",
      GIT_COMMITTER_EMAIL: "relay@example.invalid",
    },
  });
}

function options(dataDir: string, fakeScript: string): CliOptions {
  return {
    command: "start",
    params: {},
    json: false,
    embedded: false,
    nonInteractive: false,
    retryUncertainShell: false,
    allowExperimentalAdapters: false,
    noOpen: true,
    printUrl: false,
    probeDecisions: false,
    dataDir,
    fakeScript,
  };
}

function recordingEngine(launches: StartRunInput[]): Engine {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    launch: async (input: StartRunInput) => {
      launches.push(input);
      return ok({
        runId: RUN_ID,
        duplicate: false,
        completion: Promise.resolve({ runId: RUN_ID, status: "succeeded" as const }),
      });
    },
    launchResume: async () => {
      throw new Error("unused");
    },
    run: async () => {
      throw new Error("unused");
    },
    resume: async () => {
      throw new Error("unused");
    },
    cancel: async () => {
      throw new Error("unused");
    },
    subscribe: () => () => undefined,
    view: () => {
      throw new Error("unused");
    },
    getRun: async () => null,
  } as unknown as Engine;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("CLI run workspace propagation", () => {
  it("passes the selection to the engine and fingerprints it", async () => {
    const dataDir = tempDir();
    const projectDir = tempDir("relay-cli-prop-repo-");
    const webRoot = tempDir("relay-cli-prop-web-");
    const scriptFile = join(dataDir, "fake.json");
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>relay</title>");
    writeFileSync(scriptFile, "[]");
    writeFileSync(
      join(projectDir, "flow.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "prop-flow",
        name: "Propagation",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "done", type: "end", name: "Done", status: "success", result: '{"ok":true}' },
          ],
          edges: [{ id: "e1", from: "start", to: "done" }],
        },
      }),
    );
    git(projectDir, ["init", "-q"]);
    git(projectDir, ["add", "flow.json"]);
    git(projectDir, ["commit", "-q", "-m", "base"]);

    const launches: StartRunInput[] = [];
    const abort = new AbortController();
    const running = executeStart(options(dataDir, scriptFile), dataDir, {
      webRoot,
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      signal: abort.signal,
      openBrowser: () => undefined,
      createEngine: () => recordingEngine(launches),
    });
    await waitFor(() => existsSync(serverMetadataPath(dataDir)));
    const read = await readServerMetadata(dataDir);
    if (read.status !== "valid") throw new Error("metadata missing");
    const base = `http://127.0.0.1:${read.value.port}`;
    const auth = {
      "x-relay-token": read.value.token,
      "x-relay-csrf": "1",
      "content-type": "application/json",
    };
    const registered = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: projectDir }),
    });
    expect(registered.status).toBe(200);
    const project = (await registered.json()) as { id: string };

    const start = async (workspace: Record<string, string>) => {
      const response = await fetch(`${base}/api/projects/${project.id}/runs`, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "workspace-key" },
        body: JSON.stringify({ workflowFile: "flow.json", workspace }),
      });
      expect(response.status).toBe(202);
      return (await response.json()) as { runId: string };
    };

    await start({ mode: "new-worktree" });
    await start({ mode: "new-worktree" });
    await start({ mode: "project" });
    expect(launches).toHaveLength(3);
    expect(launches[0]?.workspace).toEqual({ mode: "new-worktree" });
    expect(launches[1]?.workspace).toEqual({ mode: "new-worktree" });
    expect(launches[2]?.workspace).toEqual({ mode: "project" });

    const first = launches[0]?.idempotency?.fingerprint;
    const replay = launches[1]?.idempotency?.fingerprint;
    const changed = launches[2]?.idempotency?.fingerprint;
    expect(typeof first).toBe("string");
    expect(replay).toBe(first);
    expect(changed).not.toBe(first);

    abort.abort();
    await expect(running).resolves.toBe(0);
  }, 20_000);

  it("rejects reusing an idempotency key with a different workspace", async () => {
    const dataDir = tempDir();
    const projectDir = tempDir("relay-cli-prop-repo-");
    const webRoot = tempDir("relay-cli-prop-web-");
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>relay</title>");
    writeFileSync(join(dataDir, "unused.json"), "[]");
    writeFileSync(
      join(projectDir, "flow.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "conflict-flow",
        name: "Conflict",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "done", type: "end", name: "Done", status: "success", result: '{"ok":true}' },
          ],
          edges: [{ id: "e1", from: "start", to: "done" }],
        },
      }),
    );
    git(projectDir, ["init", "-q"]);
    git(projectDir, ["add", "flow.json"]);
    git(projectDir, ["commit", "-q", "-m", "base"]);

    const abort = new AbortController();
    const running = executeStart(options(dataDir, join(dataDir, "unused.json")), dataDir, {
      webRoot,
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      signal: abort.signal,
      openBrowser: () => undefined,
    });
    await waitFor(() => existsSync(serverMetadataPath(dataDir)));
    const read = await readServerMetadata(dataDir);
    if (read.status !== "valid") throw new Error("metadata missing");
    const base = `http://127.0.0.1:${read.value.port}`;
    const auth = {
      "x-relay-token": read.value.token,
      "x-relay-csrf": "1",
      "content-type": "application/json",
    };
    const registered = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: projectDir }),
    });
    const project = (await registered.json()) as { id: string };
    const start = async (workspace: Record<string, string>) => {
      const response = await fetch(`${base}/api/projects/${project.id}/runs`, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "one-key" },
        body: JSON.stringify({ workflowFile: "flow.json", workspace }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error?: { code?: string } },
      };
    };

    expect((await start({ mode: "project" })).status).toBe(202);
    const conflict = await start({ mode: "new-worktree" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("E_CONFLICT");

    abort.abort();
    await expect(running).resolves.toBe(0);
  }, 20_000);
});
