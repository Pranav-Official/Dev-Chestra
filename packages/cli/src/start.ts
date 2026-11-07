import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DevChestraError,
  hashJson,
  isTerminalRunStatus,
  type JsonObject,
  type Path,
  type RunId,
  type RunStatus,
} from "@devchestra/core";
import { createDecisionService } from "@devchestra/decisions";
import type { Engine } from "@devchestra/engine";
import type {
  BrowserModelCatalogPort,
  BrowserPollPorts,
  BrowserWebhookPorts,
  CommandResponse,
  PollScheduler,
  StartRunCommand,
  StartRunResponse,
} from "@devchestra/server";
import {
  createBrowserStream,
  createMcpServersPort,
  createProviderStatusService,
  createStoreQueryPort,
  DevChestraError as ServerDevChestraError,
  startBrowserServer,
} from "@devchestra/server";
import { openStore, type Store } from "@devchestra/store";
import type { CliOptions } from "./args.js";
import { createCliEngine } from "./commands.js";
import { loadFakeScript } from "./fake-script.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { acquireDataDirLock, DataDirLockedError, type LockHandle } from "./lock.js";
import { createModelCatalogService, type ModelCatalogService } from "./model-catalog.js";
import { type ExitCode, notice } from "./output.js";
import { createPollPorts, createPollScheduler } from "./poll-wiring.js";
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
import { createWebhookPorts } from "./webhook-wiring.js";
import { listenWindowsControl } from "./windows-control.js";
import { requireFakeScriptForFakeNodes } from "./workflow.js";
import { createBrowserWorkspaceService } from "./workspace-service.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_WEB_ROOT = join(REPO_ROOT, "apps/web/dist");

export interface BrowserRunController {
  startRun(input: StartRunCommand): Promise<StartRunResponse>;
  cancelRun(runId: string): Promise<CommandResponse>;
  resumeRun(
    runId: string,
    request?: import("@devchestra/api").ResumeRunRequest,
  ): Promise<CommandResponse>;
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
  webRoot?: string;
  /**
   * Skip the session-token requirement so any local tab can use the plain
   * URL. The CLI sets this unless `--secure` was passed; the server library
   * defaults to requiring the session.
   */
  noAuth?: boolean;
  /** Webhook triggers: launch, queue pump and freeze ports over this engine and store. */
  webhooks?: BrowserWebhookPorts;
  /** Polling triggers: probe, launch, queue pump and freeze ports over this engine and store. */
  polling?: BrowserPollPorts;
}

export interface BrowserListener {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Optional unexpected-close signal; a request to stop is delivered via signal. */
  closed?: Promise<void>;
}

/** One failed stage of the `executeStart` shutdown sequence. */
export interface ShutdownFailure {
  stage: string;
  error: unknown;
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
  const root = override ?? process.env.DEVCHESTRA_WEB_ROOT ?? DEFAULT_WEB_ROOT;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(join(root, "index.html"));
  } catch {
    throw new DevChestraError(
      "E_VALIDATION",
      `Built web app not found at ${root}. Run \`npm run build\` (or \`pnpm build\` / \`bun run build\`) before devchestra start.`,
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
    providerStatus: createProviderStatusService(),
    providerSettings: {
      list: () =>
        wiring.store.providerSettings.list().map(({ cli, enabled }) => ({ cli, enabled })),
      setEnabled: (cli, enabled) => wiring.store.providerSettings.setEnabled(cli, enabled),
      disabled: () => wiring.store.providerSettings.disabled(),
    },
    mcpServers: createMcpServersPort({
      getProjectDir: (projectId) => wiring.store.projects.get(projectId)?.path ?? null,
    }),
    workspaceService: createBrowserWorkspaceService(),
    stream: createBrowserStream(wiring.store),
    decisions: createDecisionService(),
    sessionToken: wiring.sessionToken,
    instanceId: wiring.instanceId,
    version: wiring.version,
    port: wiring.port,
    ...(wiring.noAuth === true ? { noAuth: true } : {}),
    ...(wiring.webRoot === undefined ? {} : { webRoot: wiring.webRoot }),
    ...(wiring.webhooks === undefined ? {} : { webhooks: wiring.webhooks }),
    ...(wiring.polling === undefined ? {} : { polling: wiring.polling }),
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
      throw new DevChestraError("E_INTERNAL", "The browser listener did not report a TCP port");
    }
    return listener;
  } catch (error) {
    if (hint !== 0 && isAddrInUse(error)) {
      const listener = await factory({ ...wiring, port: 0 });
      if (!Number.isSafeInteger(listener.port) || listener.port <= 0) {
        throw new DevChestraError("E_INTERNAL", "The browser listener did not report a TCP port");
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
      if (requireFakeScriptForFakeNodes(input.snapshot) && fakeScript === undefined) {
        throw new ServerDevChestraError(
          "E_VALIDATION",
          "This workflow uses test-only fake agent nodes; start devchestra with DEVCHESTRA_ALLOW_FAKE=1 and a test-only --fake-script. The browser cannot inject a fake script.",
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
      if (record === null) throw new DevChestraError("E_NOT_FOUND", `Run ${runId} does not exist`);
      if (isTerminalRunStatus(record.status as RunStatus)) {
        if (record.status === "cancelled") return { runId: runId as RunId, status: "cancelled" };
        throw new DevChestraError("E_CONFLICT", `Run ${runId} is already ${record.status}`);
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
    async resumeRun(runId, request) {
      const fence = request?.uncertaintyFence;
      const launched = await engine.launchResume(
        runId,
        fence === undefined
          ? {}
          : { allowUncertainSideEffectRetry: true, approvedBy: "user", uncertaintyFence: fence },
      );
      if (!launched.ok) throw launched.error;
      observe(runId, launched.value.completion);
      return { runId: runId as RunId, status: statusOf(runId, "paused") };
    },
    async resolveApproval(input) {
      const n = input.note?.trim();
      const note = n === "" ? undefined : n;
      const run = store.runs.get(input.runId as RunId);
      if (!run) throw new DevChestraError("E_NOT_FOUND", `Run ${input.runId} does not exist`);
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
          throw new DevChestraError("E_INTERNAL", "Missing resolvedEventId for duplicate approval");
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
      if (r.resolvedEventId == null)
        throw new DevChestraError("E_INTERNAL", "Missing resolvedEventId");
      const eid = r.resolvedEventId;
      // Best-effort dispatch; leave durable approval_wakes marker for engine canonical wake on failure
      try {
        const after = store.runs.get(input.runId as RunId);
        if (after && !isTerminalRunStatus(after.status as RunStatus)) {
          const la = await engine.launchResume(input.runId);
          if (la.ok) observe(input.runId, la.value.completion);
        }
      } catch (e) {
        if (e instanceof DevChestraError && e.code === "E_INTERNAL") throw e;
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
    stdout.write(`devchestra: ${url}\n`);
  } else {
    stdout.write(`devchestra: already running at ${plainUrl(read.value.port)}\n`);
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
    throw new DevChestraError(
      "E_LOCKED",
      "Another DevChestra process owns this data directory, but no live server could be verified; refusing to start a second writer or overwrite its metadata.",
    );
  }

  let store: Store;
  try {
    store = openStore({ file: join(dataDir, "devchestra.db") });
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
  let gateway: RunningGateway | undefined;
  let engine: Engine | undefined;
  let modelCatalog: ModelCatalogService | undefined;
  let listener: BrowserListener | undefined;
  let pollScheduler: PollScheduler | undefined;
  let metadata: ServerMetadata | undefined;
  let cleaned = false;
  let closeWindowsControl: (() => Promise<void>) | undefined;
  const windowsStop = new AbortController();

  // Each shutdown stage reports its own failure instead of collapsing to one
  // boolean (TD-014). Every failure is logged as it happens (TD-007), so a
  // partial shutdown names the stage instead of hiding it.
  const cleanup = async (removeMetadata: boolean): Promise<ShutdownFailure[]> => {
    if (cleaned) return [];
    cleaned = true;
    const failures: ShutdownFailure[] = [];
    const runStage = async (stage: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        failures.push({ stage, error });
        notice(
          `shutdown stage '${stage}' failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const cwc = closeWindowsControl;
    if (cwc !== undefined) await runStage("windows-control", () => cwc());
    const catalog = modelCatalog;
    if (catalog !== undefined) await runStage("model-catalog", () => catalog.close());
    const scheduler = pollScheduler;
    if (scheduler !== undefined) {
      await runStage("poll-scheduler", async () => {
        scheduler.stop();
      });
    }
    const lst = listener;
    if (lst !== undefined) await runStage("listener", () => lst.close());
    const eng = engine;
    if (eng !== undefined) await runStage("engine", () => eng.stop({ graceMs: 5_000 }));
    const gw = gateway;
    if (gw !== undefined) await runStage("gateway", () => gw.close());
    await runStage("store", async () => {
      store.close();
    });
    // Preserve the old guard: never remove our own metadata when an earlier
    // stage failed, so a partial shutdown keeps its evidence on disk.
    const meta = removeMetadata ? metadata : undefined;
    if (meta !== undefined && failures.length === 0) {
      await runStage("server-metadata", () => removeOwnServerMetadata(dataDir, meta));
    }
    await runStage("data-dir-lock", () => lock.release());
    return failures;
  };

  try {
    const prior = await readServerMetadata(dataDir);
    if (prior.status === "unsafe") {
      throw new DevChestraError(
        "E_CONFLICT",
        `Refusing to replace server metadata: ${prior.reason}`,
      );
    }
    if (prior.status === "valid") {
      if (ownerLooksAlive(prior.value, deps.identity ?? undefined, deps.alive ?? undefined)) {
        throw new DevChestraError(
          "E_CONFLICT",
          "server.json names a live owner while this process holds the data-directory lock; refusing to overwrite it",
        );
      }
    }
    if (prior.status !== "missing") {
      await clearServerMetadata(dataDir);
    }
    const webRoot = options.headless ? undefined : await resolveWebRoot(deps.webRoot);

    gateway = await startGateway(store);
    const fakeScript = await loadFakeScript(options.fakeScript);
    engine = (deps.createEngine ?? createCliEngine)(options, dataDir, store, gateway, fakeScript);
    await engine.start();

    modelCatalog =
      deps.createModelCatalog?.(dataDir) ??
      createModelCatalogService({ dataDir, env: process.env });
    const sessionToken = createSessionToken();
    const instanceId = createInstanceId();
    const pollPorts = createPollPorts(store, engine);
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
        ...(webRoot === undefined ? {} : { webRoot }),
        ...(options.secure === true ? {} : { noAuth: true }),
        webhooks: createWebhookPorts(store, engine),
        polling: pollPorts,
      },
      options.port,
    );
    // The polling timer starts after the engine is up and stops with the server.
    pollScheduler = createPollScheduler(pollPorts);
    pollScheduler.start();

    metadata = {
      version,
      pid: process.pid,
      pidStart: lock.owner.pidStart,
      port: listener.port,
      token: sessionToken,
      instanceId,
      startedAt: Date.now(),
    };
    if (process.platform === "win32")
      closeWindowsControl = await listenWindowsControl(metadata, () => windowsStop.abort());
    // A published record must be immediately stoppable, including detached starts.
    await writeServerMetadata(dataDir, metadata);

    const ready = {
      type: "devchestra.ready",
      version,
      pid: metadata.pid,
      pidStart: metadata.pidStart,
      port: metadata.port,
      instanceId: metadata.instanceId,
      url: plainUrl(metadata.port),
      dataDir,
    };
    stdout.write(`${JSON.stringify(ready)}\n`);
    if (!options.json) stdout.write(`devchestra: listening on ${plainUrl(metadata.port)}\n`);
    if (options.printUrl) stdout.write(`devchestra: ${bootstrapUrl(metadata)}\n`);
    if (!options.noOpen) (deps.openBrowser ?? openInBrowser)(bootstrapUrl(metadata));

    const stopSignal =
      deps.signal === undefined
        ? windowsStop.signal
        : AbortSignal.any([deps.signal, windowsStop.signal]);
    await waitForStop(stopSignal, listener);
    const failures = await cleanup(true);
    if (failures.length > 0) {
      notice(
        `shutdown was incomplete (failed: ${failures.map((failure) => failure.stage).join(", ")}); run evidence was retained`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    const hadMetadata = metadata !== undefined;
    await cleanup(hadMetadata);
    throw error;
  }
}
