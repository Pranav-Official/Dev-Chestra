import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashJson,
  isTerminalRunStatus,
  type JsonObject,
  type Path,
  RelayError,
  type RunId,
  type RunStatus,
} from "@relay/core";
import type { Engine } from "@relay/engine";
import type {
  BrowserModelCatalogPort,
  CommandResponse,
  StartRunCommand,
  StartRunResponse,
} from "@relay/server";
import {
  createBrowserStream,
  createStoreQueryPort,
  RelayError as ServerRelayError,
  startBrowserServer,
} from "@relay/server";
import { openStore, type Store } from "@relay/store";
import type { CliOptions } from "./args.js";
import { createCliEngine } from "./commands.js";
import { loadFakeScript } from "./fake-script.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { acquireDataDirLock, DataDirLockedError, type LockHandle } from "./lock.js";
import { createModelCatalogService, type ModelCatalogService } from "./model-catalog.js";
import { type ExitCode, notice } from "./output.js";
import {
  attachToServer,
  bootstrapUrl,
  clearServerMetadata,
  createInstanceId,
  createSessionToken,
  ownerLooksAlive,
  plainUrl,
  readServerMetadata,
  removeOwnServerMetadata,
  type ServerMetadata,
  writeServerMetadata,
} from "./server-metadata.js";
import { requireFakeScriptForFakeNodes, workflowRequiresRealAdapter } from "./workflow.js";
import { createBrowserWorkspaceService } from "./workspace-service.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_WEB_ROOT = join(REPO_ROOT, "apps/web/dist");

export interface BrowserRunController {
  startRun(input: StartRunCommand): Promise<StartRunResponse>;
  cancelRun(runId: string): Promise<CommandResponse>;
  resumeRun(runId: string): Promise<CommandResponse>;
  resolveApproval(input: {
    runId: string;
    path: string;
    requestId: string;
    decision: "approve" | "reject";
    note?: string;
    expectedAttempt: number;
    expectedGeneration: number;
  }): Promise<{
    runId: string;
    path: string;
    decision: "approve" | "reject";
    note: string | null;
    by: string;
    duplicate: boolean;
    status: string;
    eventId: number;
  }>;
}

export interface BrowserWiring {
  dataDir: string;
  store: Store;
  controller: BrowserRunController;
  modelCatalog: BrowserModelCatalogPort;
  sessionToken: string;
  instanceId: string;
  version: string;
  port: number;
  webRoot: string;
}

export interface BrowserListener {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Optional unexpected-close signal; a request to stop is delivered via signal. */
  closed?: Promise<void>;
}

export interface StartDeps {
  signal?: AbortSignal;
  webRoot?: string;
  startBrowserServer?: (wiring: BrowserWiring) => Promise<BrowserListener>;
  createEngine?: (
    options: CliOptions,
    dataDir: string,
    store: Store,
    gateway: RunningGateway,
    fakeScript: string | undefined,
  ) => Engine;
  createModelCatalog?: (dataDir: string) => ModelCatalogService;
  openBrowser?: (url: string) => void;
  fetchImpl?: typeof fetch;
  identity?: (pid: number) => string | null;
  alive?: (pid: number) => boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  version?: string;
}

async function resolveWebRoot(override?: string): Promise<string> {
  const root = override ?? process.env.RELAY_WEB_ROOT ?? DEFAULT_WEB_ROOT;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(join(root, "index.html"));
  } catch {
    throw new RelayError(
      "E_VALIDATION",
      `Built web app not found at ${root}. Run \`pnpm build\` (or \`pnpm --filter @relay/web build\`) before relay start.`,
    );
  }
  return root;
}

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePort(true));
    });
  });
}

async function portHint(requested: number | undefined): Promise<number> {
  if (requested !== undefined) return requested;
  for (let port = 4821; port <= 4890; port += 1) {
    if (await canBind(port)) return port;
  }
  return 0;
}

function isAddrInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(error));
}

async function defaultBrowserFactory(wiring: BrowserWiring): Promise<BrowserListener> {
  const running = await startBrowserServer({
    dataDir: wiring.dataDir,
    store: createStoreQueryPort(wiring.store),
    controller: wiring.controller,
    modelCatalog: wiring.modelCatalog,
    workspaceService: createBrowserWorkspaceService(),
    stream: createBrowserStream(wiring.store),
    sessionToken: wiring.sessionToken,
    instanceId: wiring.instanceId,
    version: wiring.version,
    port: wiring.port,
    webRoot: wiring.webRoot,
  });
  const closed = new Promise<void>((resolveClose) => {
    running.server.once("close", () => {
      resolveClose();
    });
  });
  return { ...running, closed };
}

async function listen(
  factory: (wiring: BrowserWiring) => Promise<BrowserListener>,
  wiring: Omit<BrowserWiring, "port">,
  requested: number | undefined,
): Promise<BrowserListener> {
  const hint = await portHint(requested);
  try {
    const listener = await factory({ ...wiring, port: hint });
    if (!Number.isSafeInteger(listener.port) || listener.port <= 0 || listener.port > 65535) {
      throw new RelayError("E_INTERNAL", "The browser listener did not report a TCP port");
    }
    return listener;
  } catch (error) {
    if (hint !== 0 && isAddrInUse(error)) {
      const listener = await factory({ ...wiring, port: 0 });
      if (!Number.isSafeInteger(listener.port) || listener.port <= 0) {
        throw new RelayError("E_INTERNAL", "The browser listener did not report a TCP port");
      }
      return listener;
    }
    throw error;
  }
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening the browser is a convenience; the URL is still printed.
  }
}

function controllerFor(
  store: Store,
  engine: Engine,
  options: CliOptions,
  fakeScript: string | undefined,
): BrowserRunController {
  const observe = (runId: string, completion: Promise<unknown>): void => {
    void completion.then(
      () => undefined,
      (error: unknown) => {
        notice(
          `run ${runId} launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  };
  const statusOf = (runId: string, fallback: RunStatus): RunStatus => {
    const record = store.runs.get(runId as never);
    return (record?.status as RunStatus | undefined) ?? fallback;
  };

  return {
    async startRun(input) {
      if (workflowRequiresRealAdapter(input.snapshot) && !options.allowExperimentalAdapters) {
        throw new ServerRelayError(
          "E_VALIDATION",
          "This workflow uses an experimental real CLI adapter. Start relay with --allow-experimental-adapters only after a live contract check.",
        );
      }
      if (requireFakeScriptForFakeNodes(input.snapshot) && fakeScript === undefined) {
        throw new ServerRelayError(
          "E_VALIDATION",
          "This workflow uses test-only fake agent nodes; start relay with RELAY_ALLOW_FAKE=1 and a test-only --fake-script. The browser cannot inject a fake script.",
        );
      }
      const workspace = input.workspace ?? { mode: "project" as const };
      const fingerprint = await hashJson({
        v: 1,
        workflowId: input.workflowId,
        snapshot: input.snapshot,
        params: input.params,
        workspace,
      });
      const launched = await engine.launch({
        projectId: input.projectId,
        workflowId: input.workflowId,
        snapshot: input.snapshot,
        snapshotRaw: input.snapshotRaw,
        params: input.params as JsonObject,
        workspace,
        ...(input.idempotencyKey === undefined
          ? {}
          : {
              idempotency: {
                scope: input.projectId,
                key: input.idempotencyKey,
                fingerprint,
              },
            }),
      });
      if (!launched.ok) throw launched.error;
      observe(launched.value.runId, launched.value.completion);
      return {
        runId: launched.value.runId as RunId,
        duplicate: launched.value.duplicate,
        status: statusOf(launched.value.runId, "queued"),
      };
    },
    async cancelRun(runId) {
      const record = store.runs.get(runId as never);
      if (record === null) throw new RelayError("E_NOT_FOUND", `Run ${runId} does not exist`);
      if (isTerminalRunStatus(record.status as RunStatus)) {
        if (record.status === "cancelled") return { runId: runId as RunId, status: "cancelled" };
        throw new RelayError("E_CONFLICT", `Run ${runId} is already ${record.status}`);
      }
      if (record.status === "paused") {
        const cancelled = await engine.cancel(runId);
        if (!cancelled.ok) throw cancelled.error;
        return { runId: runId as RunId, status: statusOf(runId, "cancelled") };
      }
      const pending = engine.cancel(runId);
      void pending.then(
        (result) => {
          if (!result.ok) notice(`run ${runId} cancel failed: ${result.error.message}`);
        },
        (error: unknown) => {
          notice(
            `run ${runId} cancel failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      return { runId: runId as RunId, status: record.status as RunStatus };
    },
    async resumeRun(runId) {
      const launched = await engine.launchResume(runId);
      if (!launched.ok) throw launched.error;
      observe(runId, launched.value.completion);
      return { runId: runId as RunId, status: statusOf(runId, "paused") };
    },
    async resolveApproval(input) {
      const n = input.note?.trim();
      const note = n === "" ? undefined : n;
      const run = store.runs.get(input.runId as RunId);
      if (!run) throw new RelayError("E_NOT_FOUND", `Run ${input.runId} does not exist`);
      const r = store.approvals.resolve({
        identity: {
          runId: input.runId as RunId,
          path: input.path as Path,
          attempt: input.expectedAttempt,
          generation: input.expectedGeneration,
        },
        requestId: input.requestId,
        decision: input.decision,
        by: "user",
        ...(note === undefined ? {} : { note }),
      });
      if (r.duplicate) {
        const rec = store.approvals.get({
          runId: input.runId as RunId,
          path: input.path as Path,
          attempt: input.expectedAttempt,
          generation: input.expectedGeneration,
        });
        if (!rec?.resolvedEventId)
          throw new RelayError("E_INTERNAL", "Missing resolvedEventId for duplicate approval");
        return {
          runId: input.runId as RunId,
          path: input.path as Path,
          decision: input.decision,
          note: note ?? null,
          by: "user",
          duplicate: true,
          status: statusOf(input.runId, (run.status as RunStatus) ?? "waiting_approval"),
          eventId: rec.resolvedEventId,
        };
      }
      if (r.resolvedEventId == null) throw new RelayError("E_INTERNAL", "Missing resolvedEventId");
      const eid = r.resolvedEventId;
      // Best-effort dispatch; leave durable approval_wakes marker for engine canonical wake on failure
      try {
        const after = store.runs.get(input.runId as RunId);
        if (after && !isTerminalRunStatus(after.status as RunStatus)) {
          const la = await engine.launchResume(input.runId);
          if (la.ok) observe(input.runId, la.value.completion);
        }
      } catch (e) {
        if (e instanceof RelayError && e.code === "E_INTERNAL") throw e;
      }
      return {
        runId: input.runId as RunId,
        path: input.path as Path,
        decision: input.decision,
        note: note ?? null,
        by: "user",
        duplicate: false,
        status: statusOf(input.runId, "running"),
        eventId: eid,
      };
    },
  };
}

async function attach(dataDir: string, options: CliOptions, deps: StartDeps): Promise<boolean> {
  const read = await readServerMetadata(dataDir);
  if (read.status !== "valid") return false;
  try {
    await attachToServer(read.value, {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.identity === undefined ? {} : { identity: deps.identity }),
      ...(deps.alive === undefined ? {} : { alive: deps.alive }),
    });
  } catch {
    return false;
  }
  const url = bootstrapUrl(read.value);
  const stdout = deps.stdout ?? process.stdout;
  if (options.printUrl) {
    stdout.write(`relay: ${url}\n`);
  } else {
    stdout.write(`relay: already running at ${plainUrl(read.value.port)}\n`);
  }
  if (!options.noOpen) (deps.openBrowser ?? openInBrowser)(url);
  return true;
}

async function waitForStop(
  signal: AbortSignal | undefined,
  listener: BrowserListener,
): Promise<void> {
  await new Promise<void>((resolveStop) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", finish);
      resolveStop();
    };
    if (signal?.aborted === true) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    listener.closed?.then(finish, finish);
  });
}

export async function executeStart(
  options: CliOptions,
  dataDir: string,
  deps: StartDeps = {},
): Promise<ExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const version = deps.version ?? "0.1.0";

  let lock: LockHandle;
  try {
    lock = await acquireDataDirLock(dataDir, version);
  } catch (error) {
    if (!(error instanceof DataDirLockedError)) throw error;
    if (await attach(dataDir, options, deps)) return 0;
    throw new RelayError(
      "E_LOCKED",
      "Another Relay process owns this data directory, but no live server could be verified; refusing to start a second writer or overwrite its metadata.",
    );
  }

  let store: Store;
  try {
    store = openStore({ file: join(dataDir, "relay.db") });
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
  let gateway: RunningGateway | undefined;
  let engine: Engine | undefined;
  let modelCatalog: ModelCatalogService | undefined;
  let listener: BrowserListener | undefined;
  let metadata: ServerMetadata | undefined;
  let cleaned = false;

  const cleanup = async (removeMetadata: boolean): Promise<boolean> => {
    if (cleaned) return true;
    cleaned = true;
    let ok = true;
    if (modelCatalog !== undefined) {
      try {
        await modelCatalog.close();
      } catch {
        ok = false;
      }
    }
    if (listener !== undefined) {
      try {
        await listener.close();
      } catch {
        ok = false;
      }
    }
    if (engine !== undefined) {
      try {
        await engine.stop({ graceMs: 5_000 });
      } catch {
        ok = false;
      }
    }
    if (gateway !== undefined) {
      try {
        await gateway.close();
      } catch {
        ok = false;
      }
    }
    try {
      store.close();
    } catch {
      ok = false;
    }
    if (removeMetadata && metadata !== undefined && ok) {
      try {
        await removeOwnServerMetadata(dataDir, metadata);
      } catch {
        ok = false;
      }
    }
    try {
      await lock.release();
    } catch {
      ok = false;
    }
    return ok;
  };

  try {
    const prior = await readServerMetadata(dataDir);
    if (prior.status === "unsafe") {
      throw new RelayError("E_CONFLICT", `Refusing to replace server metadata: ${prior.reason}`);
    }
    if (prior.status === "valid") {
      if (ownerLooksAlive(prior.value, deps.identity ?? undefined, deps.alive ?? undefined)) {
        throw new RelayError(
          "E_CONFLICT",
          "server.json names a live owner while this process holds the data-directory lock; refusing to overwrite it",
        );
      }
    }
    if (prior.status !== "missing") {
      await clearServerMetadata(dataDir);
    }
    const webRoot = await resolveWebRoot(deps.webRoot);

    gateway = await startGateway(store);
    const fakeScript = await loadFakeScript(options.fakeScript);
    engine = (deps.createEngine ?? createCliEngine)(options, dataDir, store, gateway, fakeScript);
    await engine.start();

    modelCatalog =
      deps.createModelCatalog?.(dataDir) ??
      createModelCatalogService({ dataDir, env: process.env });
    const sessionToken = createSessionToken();
    const instanceId = createInstanceId();
    listener = await listen(
      deps.startBrowserServer ?? defaultBrowserFactory,
      {
        dataDir,
        store,
        controller: controllerFor(store, engine, options, fakeScript),
        modelCatalog,
        sessionToken,
        instanceId,
        version,
        webRoot,
      },
      options.port,
    );

    metadata = {
      version,
      pid: process.pid,
      pidStart: lock.owner.pidStart,
      port: listener.port,
      token: sessionToken,
      instanceId,
      startedAt: Date.now(),
    };
    await writeServerMetadata(dataDir, metadata);

    const ready = {
      type: "relay.ready",
      version,
      pid: metadata.pid,
      pidStart: metadata.pidStart,
      port: metadata.port,
      instanceId: metadata.instanceId,
      url: plainUrl(metadata.port),
      dataDir,
    };
    stdout.write(`${JSON.stringify(ready)}\n`);
    if (!options.json) stdout.write(`relay: listening on ${plainUrl(metadata.port)}\n`);
    if (options.printUrl) stdout.write(`relay: ${bootstrapUrl(metadata)}\n`);
    if (!options.noOpen) (deps.openBrowser ?? openInBrowser)(bootstrapUrl(metadata));

    await waitForStop(deps.signal, listener);
    const ok = await cleanup(true);
    if (!ok) {
      notice("relay: shutdown was incomplete; run evidence was retained");
      return 1;
    }
    return 0;
  } catch (error) {
    const hadMetadata = metadata !== undefined;
    await cleanup(hadMetadata);
    throw error;
  }
}
