import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Engine } from "@devchestra/engine";
import { afterEach, describe, expect, it } from "vitest";
import type { CliOptions } from "../src/args.js";
import { acquireDataDirLock, processIdentity } from "../src/lock.js";
import {
  attachToServer,
  createInstanceId,
  createSessionToken,
  readServerMetadata,
  removeOwnServerMetadata,
  type ServerMetadata,
  serverMetadataPath,
  writeServerMetadata,
} from "../src/server-metadata.js";
import { type BrowserWiring, executeStart } from "../src/start.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix = "devchestra-cli-start-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function webRoot(): string {
  const dir = tempDir("devchestra-cli-web-");
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

function metadata(port = 4821): ServerMetadata {
  const pidStart = processIdentity(process.pid);
  if (pidStart === null) throw new Error("test runtime has no process identity");
  return {
    version: "0.1.0",
    pid: process.pid,
    pidStart,
    port,
    token: createSessionToken(),
    instanceId: createInstanceId(),
    startedAt: Date.now(),
  };
}

function stubEngine(launches: unknown[]): Engine {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    launch: async (input: unknown) => {
      launches.push(input);
      throw new Error("engine.launch must not run");
    },
    launchResume: async () => {
      throw new Error("engine.launchResume must not run");
    },
    run: async () => {
      throw new Error("engine.run must not run");
    },
    resume: async () => {
      throw new Error("engine.resume must not run");
    },
    cancel: async () => {
      throw new Error("engine.cancel must not run");
    },
    subscribe: () => () => undefined,
    view: () => {
      throw new Error("engine.view must not run");
    },
    getRun: async () => null,
  } as unknown as Engine;
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("server metadata", () => {
  it("rejects a symlinked data-dir before creating lock or database state", async () => {
    const parent = tempDir();
    const target = tempDir("devchestra-cli-symlink-target-");
    const link = join(parent, "data-link");
    symlinkSync(target, link);
    await expect(
      executeStart(options({ port: 0 }), link, {
        webRoot: webRoot(),
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow(/symlink/i);
    expect(existsSync(join(target, "devchestra.lock"))).toBe(false);
    expect(existsSync(join(target, "devchestra.db"))).toBe(false);
  });

  it("writes owner-only atomically and removes only its own file", async () => {
    const dir = tempDir();
    const value = metadata();
    await writeServerMetadata(dir, value);
    const file = serverMetadataPath(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const read = await readServerMetadata(dir);
    expect(read.status).toBe("valid");
    if (read.status === "valid") expect(read.value).toEqual(value);

    await removeOwnServerMetadata(dir, { ...value, token: createSessionToken() });
    expect(existsSync(file)).toBe(true);
    await removeOwnServerMetadata(dir, value);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to follow a symlinked server.json", async () => {
    const dir = tempDir();
    const target = join(dir, "target.json");
    writeFileSync(target, "keep");
    symlinkSync(target, serverMetadataPath(dir));
    await expect(writeServerMetadata(dir, metadata())).rejects.toThrow(/symlink/i);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect((await readServerMetadata(dir)).status).toBe("unsafe");
  });
});

describe("devchestra start lifecycle", () => {
  it("runs open by default and requires opt-in --secure for session auth", async () => {
    const wirings: (BrowserWiring | undefined)[] = [];
    const runOnce = async (overrides: Partial<CliOptions>): Promise<void> => {
      const dir = tempDir();
      const out = capture();
      const controller = new AbortController();
      let wiring: BrowserWiring | undefined;
      const running = executeStart(options(overrides), dir, {
        webRoot: webRoot(),
        stdout: out.stream,
        signal: controller.signal,
        openBrowser: () => undefined,
        startBrowserServer: async (value) => {
          wiring = value;
          return {
            url: "http://127.0.0.1:4821",
            port: 4821,
            close: async () => undefined,
          };
        },
      });
      await waitFor(() => existsSync(serverMetadataPath(dir)));
      controller.abort();
      await expect(running).resolves.toBe(0);
      wirings.push(wiring);
    };
    await runOnce({});
    await runOnce({ secure: true });
    expect(wirings[0]?.noAuth).toBe(true);
    expect(wirings[1]?.noAuth).toBeUndefined();
  });
  it("emits one tokenless ready line, writes metadata, and cleans only its own state", async () => {
    const dir = tempDir();
    const out = capture();
    const controller = new AbortController();
    let closed = false;
    let wiring: BrowserWiring | undefined;
    const running = executeStart(options({ printUrl: true }), dir, {
      webRoot: webRoot(),
      stdout: out.stream,
      signal: controller.signal,
      openBrowser: () => undefined,
      startBrowserServer: async (value) => {
        wiring = value;
        return {
          url: "http://127.0.0.1:4821",
          port: 4821,
          close: async () => {
            closed = true;
          },
        };
      },
    });

    await waitFor(() => existsSync(serverMetadataPath(dir)));
    const read = await readServerMetadata(dir);
    expect(read.status).toBe("valid");
    if (read.status !== "valid") throw new Error("metadata missing");
    expect(read.value.token.length).toBeGreaterThanOrEqual(32);
    expect(wiring?.instanceId).toBe(read.value.instanceId);
    expect(wiring?.webhooks).toBeDefined();
    expect(wiring?.polling).toBeDefined();

    const readyText = out.text();
    expect(readyText).toContain('"type":"devchestra.ready"');
    const readyLine =
      readyText.split("\n").find((line) => line.includes('"devchestra.ready"')) ?? "";
    expect(JSON.parse(readyLine).port).toBe(4821);
    expect(readyLine.includes(read.value.token)).toBe(false);
    expect(readyText.match(new RegExp(read.value.token, "g"))).toHaveLength(1);

    controller.abort();
    await expect(running).resolves.toBe(0);
    expect(closed).toBe(true);
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
    expect(existsSync(join(dir, "devchestra.lock"))).toBe(false);
  });

  it("serves the real browser API on an ephemeral loopback port", async () => {
    const dir = tempDir();
    const out = capture();
    const controller = new AbortController();
    const running = executeStart(options({ port: 0 }), dir, {
      webRoot: webRoot(),
      stdout: out.stream,
      signal: controller.signal,
      openBrowser: () => undefined,
    });
    await waitFor(() => existsSync(serverMetadataPath(dir)));
    const read = await readServerMetadata(dir);
    if (read.status !== "valid") throw new Error("metadata missing");
    const response = await fetch(`http://127.0.0.1:${read.value.port}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; instanceId: string };
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe(read.value.instanceId);
    const page = await fetch(`http://127.0.0.1:${read.value.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("devchestra");
    controller.abort();
    await expect(running).resolves.toBe(0);
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
  });

  it("names the failed shutdown stage and keeps evidence on disk", async () => {
    const dir = tempDir();
    const out = capture();
    const controller = new AbortController();
    const running = executeStart(options({ port: 0 }), dir, {
      webRoot: webRoot(),
      stdout: out.stream,
      signal: controller.signal,
      openBrowser: () => undefined,
      createEngine: () => ({
        ...stubEngine([]),
        stop: async () => {
          throw new Error("engine boom");
        },
      }),
    });

    await waitFor(() => existsSync(serverMetadataPath(dir)));
    controller.abort();
    await expect(running).resolves.toBe(1);
    // The engine stage failed, so our own metadata is retained as evidence.
    expect(existsSync(serverMetadataPath(dir))).toBe(true);
  });

  it("returns actionable startup gate errors over HTTP without launching", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const dataDir = tempDir();
    const projectDir = tempDir("devchestra-cli-gate-project-");
    for (const name of ["linear-claude-code.json", "linear-fake.json"]) {
      writeFileSync(join(projectDir, name), readFileSync(join(root, "examples", name)));
    }
    const launches: unknown[] = [];
    const out = capture();
    const controller = new AbortController();
    const running = executeStart(options({ port: 0 }), dataDir, {
      webRoot: webRoot(),
      stdout: out.stream,
      signal: controller.signal,
      openBrowser: () => undefined,
      createEngine: () => stubEngine(launches),
    });
    await waitFor(() => existsSync(serverMetadataPath(dataDir)));
    const read = await readServerMetadata(dataDir);
    if (read.status !== "valid") throw new Error("metadata missing");
    const base = `http://127.0.0.1:${read.value.port}`;
    const auth = {
      "x-devchestra-token": read.value.token,
      "x-devchestra-csrf": "1",
      "content-type": "application/json",
    };
    const registered = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: projectDir }),
    });
    expect(registered.status).toBe(200);
    const project = (await registered.json()) as { id: string };
    const startRun = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/projects/${project.id}/runs`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error?: { code: string; message: string } },
      };
    };

    const fake = await startRun({
      workflowFile: "linear-fake.json",
      params: { topic: "devchestra" },
    });
    expect(fake.status).toBe(400);
    expect(fake.body.error?.code).toBe("E_VALIDATION");
    expect(fake.body.error?.message).toContain("--fake-script");

    const injected = await startRun({
      workflowFile: "linear-claude-code.json",
      params: { topic: "devchestra" },
      allowExperimentalAdapters: true,
      fakeScript: "/tmp/untrusted.json",
    });
    expect(injected.status).toBe(400);
    expect(injected.body.error?.message).not.toContain("--allow-experimental-adapters");

    const runs = await fetch(`${base}/api/runs?project=${project.id}`, { headers: auth });
    expect(((await runs.json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(launches).toHaveLength(0);

    controller.abort();
    await expect(running).resolves.toBe(0);
  });

  it("accepts an API start twice with one child and one durable run", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const dataDir = tempDir();
    const projectDir = tempDir("devchestra-cli-project-");
    writeFileSync(
      join(projectDir, "workflow.json"),
      readFileSync(join(root, "examples/linear-fake.json")),
    );
    const script = join(dataDir, "fake.json");
    writeFileSync(
      script,
      JSON.stringify([{ type: "submit", output: { summary: "api ok", points: ["one"] } }]),
    );
    const out = capture();
    const controller = new AbortController();
    const running = executeStart(options({ port: 0, fakeScript: script, json: true }), dataDir, {
      webRoot: webRoot(),
      stdout: out.stream,
      signal: controller.signal,
      openBrowser: () => undefined,
    });
    await waitFor(() => existsSync(serverMetadataPath(dataDir)));
    const read = await readServerMetadata(dataDir);
    if (read.status !== "valid") throw new Error("metadata missing");
    const base = `http://127.0.0.1:${read.value.port}`;
    const auth = {
      "x-devchestra-token": read.value.token,
      "x-devchestra-csrf": "1",
      "content-type": "application/json",
    };
    const registered = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: projectDir }),
    });
    expect(registered.status).toBe(200);
    const project = (await registered.json()) as { id: string };

    const start = async (): Promise<{ runId: string; duplicate: boolean; status: string }> => {
      const response = await fetch(`${base}/api/projects/${project.id}/runs`, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "api-key-1" },
        body: JSON.stringify({ workflowFile: "workflow.json", params: { topic: "devchestra" } }),
      });
      expect(response.status).toBe(202);
      return (await response.json()) as { runId: string; duplicate: boolean; status: string };
    };

    const first = await start();
    expect(first.duplicate).toBe(false);
    const replay = await start();
    expect(replay.duplicate).toBe(true);
    expect(replay.runId).toBe(first.runId);

    let status = first.status;
    let events: { event: string; data: unknown }[] = [];
    await waitFor(async () => {
      const response = await fetch(`${base}/api/runs/${first.runId}`, { headers: auth });
      const body = (await response.json()) as { run: { status: string } };
      status = body.run.status;
      const eventResponse = await fetch(`${base}/api/runs/${first.runId}/events`, {
        headers: auth,
      });
      const page = (await eventResponse.json()) as { events: { type: string; path: string }[] };
      events = page.events.map((event) => ({ event: event.type, data: event }));
      return status === "succeeded" || status === "failed";
    });
    expect(status).toBe("succeeded");
    expect(
      events.filter(
        (entry) =>
          entry.event === "node.process.spawned" &&
          (entry.data as { path: string }).path === "draft",
      ),
    ).toHaveLength(1);

    const list = await fetch(`${base}/api/runs?project=${project.id}`, { headers: auth });
    const runs = (await list.json()) as { items: unknown[] };
    expect(runs.items).toHaveLength(1);

    controller.abort();
    await expect(running).resolves.toBe(0);
  }, 30_000);

  it("attaches to a verified live server without creating a second session", async () => {
    const dir = tempDir();
    const value = metadata();
    await writeServerMetadata(dir, value);
    await acquireDataDirLock(dir);
    const out = capture();
    let started = false;
    const code = await executeStart(options(), dir, {
      webRoot: webRoot(),
      stdout: out.stream,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true, instanceId: value.instanceId, webReady: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      startBrowserServer: async () => {
        started = true;
        throw new Error("must not start a second server");
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
    expect(out.text()).toContain("already running");
    const read = await readServerMetadata(dir);
    expect(read.status).toBe("valid");
    if (read.status === "valid") expect(read.value.token).toBe(value.token);
  });

  it("refuses to overwrite metadata when attach identity does not match", async () => {
    const dir = tempDir();
    const value = metadata();
    await writeServerMetadata(dir, value);
    await acquireDataDirLock(dir);
    await expect(
      executeStart(options(), dir, {
        webRoot: webRoot(),
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: true, instanceId: "different" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/verified|E_LOCKED/i);
    const read = await readServerMetadata(dir);
    expect(read.status).toBe("valid");
    if (read.status === "valid") expect(read.value.token).toBe(value.token);
  });

  it("rejects an unhealthy recorded server", async () => {
    const value = metadata();
    await expect(
      attachToServer(value, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: true, instanceId: "other" }), {
            status: 200,
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/identity/i);
  });
});
