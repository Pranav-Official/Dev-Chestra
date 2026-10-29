import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry, createMcpResolver } from "@devchestra/adapters";
import {
  DevChestraError,
  isTerminalRunStatus,
  type JsonObject,
  type RunStatus,
} from "@devchestra/core";
import { createDecisionService } from "@devchestra/decisions";
import { createEngine, type Engine, type RunOutcome, type WorkspacePort } from "@devchestra/engine";
import { PROD_CLIS, validateParams } from "@devchestra/schema";
import { ensureProjectSkill, OutputValidator } from "@devchestra/server";
import { openStore, type Store } from "@devchestra/store";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "@devchestra/workspaces";
import { type CliOptions, UsageError } from "./args.js";
import { loadFakeScript, requireFakeScript } from "./fake-script.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { type ExitCode, exitCodeForOutcome, notice, writeEvent, writeSummary } from "./output.js";
import { loadWorkflow, requireFakeScriptForFakeNodes, resolveRunWorkspace } from "./workflow.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHIM_ENTRY = join(REPO_ROOT, "packages/mcp/dist/bin/shim.js");
const FAKE_AGENT_BIN = join(REPO_ROOT, "tools/fake-agent/dist/main.js");

const workspaces: WorkspacePort = {
  prepare: (request) => prepareRunWorkspace(request),
  acquire: (request) => acquireScratch(request),
  finalize: (workspace, request) => finalizeScratch(workspace, request),
  release: (workspace) => releaseScratch(workspace),
};

function summaryFor(
  outcome: RunOutcome,
  exitCode: ExitCode,
  interrupted: boolean,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    runId: outcome.runId,
    status: outcome.status,
    exitCode,
  };
  if (outcome.pausedReason !== undefined) summary.pausedReason = outcome.pausedReason;
  if (outcome.result !== undefined) summary.result = outcome.result;
  if (outcome.error !== undefined) summary.error = outcome.error;
  if (interrupted) summary.interrupted = true;
  if (outcome.status === "paused") {
    summary.resumable = true;
    if (outcome.pausedReason === "uncertain_side_effect") {
      summary.hint =
        "Run paused for an uncertain shell side effect. Inspect effects, then resume with --retry-uncertain-shell.";
    } else if (outcome.pausedReason === "approval_cap") {
      summary.hint = "Run is waiting for a human approval; this P1 CLI has no approval command.";
    } else {
      summary.hint = "Run is paused; resume it with `devchestra resume <runId> --data-dir <dir>`.";
    }
  }
  return summary;
}

export function createCliEngine(
  options: CliOptions,
  dataDir: string,
  store: Store,
  gateway: RunningGateway,
  fakeScript: string | undefined,
): Engine {
  const adapters = createAdapterRegistry({
    nodeBin: process.execPath,
    fakeAgentBin: FAKE_AGENT_BIN,
    ...(fakeScript === undefined ? {} : { fakeScript }),
  });
  const outputValidator = new OutputValidator();
  return createEngine({
    store,
    adapters,
    workspaces,
    gateway: gateway.port,
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: SHIM_ENTRY,
    env: process.env,
    allowExperimentalClis: [...PROD_CLIS],
    extraEnvNames: ["FAKE_AGENT_CHECKPOINT"],
    validateOutput: (schema, value) => outputValidator.compile(schema).validate(value),
    // Secrets come from process.env then a cwd `.env` (loadDecisionSecrets
    // defaults); the service reads them lazily per call and never mutates
    // process.env. Never passed to agent CLIs or shell nodes.
    decisions: createDecisionService(),
    mcpResolver: createMcpResolver(),
  });
}

async function withEngine(
  options: CliOptions,
  dataDir: string,
  store: Store,
  gateway: RunningGateway,
  fakeScript: string | undefined,
): Promise<{ engine: Engine; unsubscribe: () => void }> {
  const engine = createCliEngine(options, dataDir, store, gateway, fakeScript);
  const unsubscribe = engine.subscribe((event) => {
    writeEvent(event, options.json);
  });
  return { engine, unsubscribe };
}

async function closeEngine(
  engine: Engine | undefined,
  unsubscribe: (() => void) | undefined,
  gateway: RunningGateway | undefined,
  store: Store,
): Promise<void> {
  unsubscribe?.();
  if (engine !== undefined) {
    try {
      await engine.stop({ graceMs: 5_000 });
    } catch {
      notice("engine stop failed");
    }
  }
  if (gateway !== undefined) {
    await gateway.close().catch(() => undefined);
  }
  store.close();
}

export async function executeRun(options: CliOptions, dataDir: string): Promise<ExitCode> {
  if (options.workflow === undefined || options.project === undefined) {
    throw new DevChestraError("E_VALIDATION", "run requires a workflow and --project");
  }
  if (options.budgetUsd !== undefined) {
    throw new UsageError("--budget-usd is not supported by this runner; remove it.");
  }
  const loaded = await loadWorkflow(options.project, options.workflow);
  const workspace = await resolveRunWorkspace(
    loaded.projectRoot,
    options.workspaceMode,
    options.worktreePath,
  );
  const fakeScript = await loadFakeScript(options.fakeScript);
  if (requireFakeScriptForFakeNodes(loaded.normalized)) {
    requireFakeScript(fakeScript);
  }
  const params = validateParams(loaded.file, options.params);
  if (!params.ok) {
    throw new DevChestraError("E_VALIDATION", "Run parameters are invalid", {
      details: { issues: params.errors },
    });
  }

  const store = openStore({ file: join(dataDir, "devchestra.db") });
  let gateway: RunningGateway | undefined;
  let engine: Engine | undefined;
  let unsubscribe: (() => void) | undefined;
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
    if (engine !== undefined) void engine.stop({ graceMs: 5_000 });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // The CLI registers the project implicitly, bypassing the HTTP route.
    ensureProjectSkill(loaded.projectRoot);
    store.projects.ensure({
      id: loaded.projectId,
      name: loaded.projectName,
      path: loaded.projectRoot,
      kind: loaded.projectKind,
    });
    gateway = await startGateway(store);
    const built = await withEngine(options, dataDir, store, gateway, fakeScript);
    engine = built.engine;
    unsubscribe = built.unsubscribe;
    await engine.start();

    const outcome = await engine.run({
      projectId: loaded.projectId,
      workflowId: loaded.workflowId,
      snapshot: loaded.normalized,
      snapshotRaw: loaded.raw,
      params: params.value as JsonObject,
      workspace,
    });
    if (!outcome.ok) throw outcome.error;
    const exitCode = exitCodeForOutcome(outcome.value);
    writeSummary(summaryFor(outcome.value, exitCode, interrupted), options.json);
    return interrupted && exitCode === 0 ? 1 : exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await closeEngine(engine, unsubscribe, gateway, store);
  }
}

export async function executeResume(options: CliOptions, dataDir: string): Promise<ExitCode> {
  if (options.runId === undefined) {
    throw new DevChestraError("E_VALIDATION", "resume requires a run id");
  }
  const store = openStore({ file: join(dataDir, "devchestra.db") });
  let gateway: RunningGateway | undefined;
  let engine: Engine | undefined;
  let unsubscribe: (() => void) | undefined;
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
    if (engine !== undefined) void engine.stop({ graceMs: 5_000 });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    gateway = await startGateway(store);
    const built = await withEngine(
      options,
      dataDir,
      store,
      gateway,
      await loadFakeScript(options.fakeScript),
    );
    engine = built.engine;
    unsubscribe = built.unsubscribe;
    const beforeStart = await engine.getRun(options.runId);
    if (beforeStart === null) {
      throw new DevChestraError("E_NOT_FOUND", `Run ${options.runId} does not exist`);
    }
    if (isTerminalRunStatus(beforeStart.status as RunStatus)) {
      throw new DevChestraError(
        "E_CONFLICT",
        `Run ${options.runId} is already ${beforeStart.status}`,
      );
    }
    await engine.start();
    const current = await engine.getRun(options.runId);
    if (current !== null && isTerminalRunStatus(current.status as RunStatus)) {
      const exitCode = exitCodeForOutcome(current);
      writeSummary(summaryFor(current, exitCode, interrupted), options.json);
      return interrupted && exitCode === 0 ? 1 : exitCode;
    }
    if (current !== null && current.status === "paused") {
      const reason = current.pausedReason;
      if (reason === "uncertain_side_effect" && !options.retryUncertainShell) {
        writeSummary(summaryFor(current, 5, interrupted), options.json);
        return 5;
      }
      if (reason === "approval_cap" || reason === "user") {
        writeSummary(summaryFor(current, 5, interrupted), options.json);
        return 5;
      }
      if (reason === "budget" || reason === "quota") {
        writeSummary(summaryFor(current, 6, interrupted), options.json);
        return 6;
      }
    }
    const outcome = await engine.resume(options.runId, {
      ...(options.retryUncertainShell ? { allowUncertainSideEffectRetry: true } : {}),
    });
    if (!outcome.ok) throw outcome.error;
    const exitCode = exitCodeForOutcome(outcome.value);
    writeSummary(summaryFor(outcome.value, exitCode, interrupted), options.json);
    return interrupted && exitCode === 0 ? 1 : exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await closeEngine(engine, unsubscribe, gateway, store);
  }
}
