import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevChestraError as CoreDevChestraError, FakeClock, FakeIdGen } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import type { Hono } from "hono";
import {
  type BrowserPollPorts,
  type BrowserRunControllerPort,
  type BrowserWorkspacePort,
  createBrowserApp,
  createStoreQueryPort,
  DevChestraError,
  type PollProbeCommand,
  type PollRunCommand,
  PollScheduler,
} from "../src/index.js";

export const TOKEN = "d".repeat(43);
export const PORT = 51_778;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const COOKIE = `devchestra_session=${TOKEN}`;
export const PROJECT_ID = "proj-poll";
export const WORKFLOW_ID = "polled";
const NOW = Date.UTC(2026, 0, 1);

/** One scripted probe answer, in the order probes run. */
export type ScriptedProbe =
  | { kind: "shell"; stdout: string; exitCode: number }
  | { kind: "agent"; output: unknown }
  | { fail: string };

export interface PollHarness {
  readonly app: Hono;
  readonly store: Store;
  readonly clock: FakeClock;
  readonly scheduler: PollScheduler;
  readonly projectPath: string;
  readonly dataDir: string;
  readonly launches: PollRunCommand[];
  readonly probes: PollProbeCommand[];
  readonly probeRunIds: string[];
  /** Whether the workspace preflight treats the project as a Git repository. */
  git: boolean;
  /** Queued scripted probe answers. Empty means a quiet shell probe. */
  probeScript: ScriptedProbe[];
  /** When set, every probe waits for this gate before answering. */
  gateProbe: (() => Promise<void>) | null;
  enteredProbes(): number;
  writeWorkflow(id: string, file: unknown): void;
  removeWorkflow(id: string): void;
  close(): void;
}

export interface PollHarnessOptions {
  readonly git?: boolean;
}

const openHarnesses: PollHarness[] = [];

/** Shape of a workflow file the tests write. Probe and params are per test. */
export function pollWorkflow(
  options: {
    id?: string;
    polling?: unknown;
    params?: { name: string; type: string; required?: boolean; default?: unknown }[];
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: options.id ?? WORKFLOW_ID,
    name: "Polled",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: options.params ?? [
            { name: "pr", type: "number", required: true },
            { name: "title", type: "string", required: false, default: "none" },
          ],
          polling: options.polling ?? {
            enabled: true,
            probe: { id: "probe", type: "shell", name: "Poll probe", command: "gh pr list" },
          },
        },
        { id: "done", type: "end", name: "Done", status: "success", result: '{ "ok": true }' },
      ],
      edges: [{ id: "e1", from: "start", to: "done" }],
    },
  };
}

export function withoutPolling(file: Record<string, unknown>): Record<string, unknown> {
  const nodes = (file.graph as { nodes: Record<string, unknown>[] }).nodes;
  const first = nodes[0];
  if (first !== undefined) delete first.polling;
  return file;
}

export function agentPolling(prompt = "Check for work."): Record<string, unknown> {
  return {
    enabled: true,
    probe: {
      id: "probe",
      type: "agent",
      name: "Poll probe",
      cli: "codex",
      prompt,
      permissions: { network: true, write: [], shell: true },
    },
  };
}

export function createPollHarness(options: PollHarnessOptions = {}): PollHarness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-polling-"));
  const projectPath = join(dir, "project");
  const dataDir = join(dir, "data");
  mkdirSync(join(projectPath, ".devchestra", "workflows"), { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const clock = new FakeClock(NOW);
  const store = openStore({
    file: join(dataDir, "devchestra.db"),
    clock,
    idGen: new FakeIdGen("pol"),
  });
  store.projects.ensure({ id: PROJECT_ID, name: "Project", path: projectPath, kind: "git" });

  const launches: PollRunCommand[] = [];
  const probes: PollProbeCommand[] = [];
  const probeRunIds: string[] = [];
  const probeScript: ScriptedProbe[] = [];
  const state: { git: boolean; gate: (() => Promise<void>) | null; entered: number } = {
    git: options.git ?? true,
    gate: null,
    entered: 0,
  };

  const workspaceService: BrowserWorkspacePort = {
    catalog: () => {
      throw new DevChestraError("E_NOT_SUPPORTED", "catalog is not used by polling tests");
    },
    validate: (_root, selection) => {
      if (!state.git) {
        throw new DevChestraError("E_VALIDATION", "Worktree selections require a Git project");
      }
      return selection;
    },
  };

  const controller: BrowserRunControllerPort = {
    startRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "startRun is not used by polling tests");
    },
    cancelRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "cancelRun is not used by polling tests");
    },
    resumeRun: () => {
      throw new CoreDevChestraError("E_INTERNAL", "resumeRun is not used by polling tests");
    },
    resolveApproval: () => {
      throw new CoreDevChestraError("E_INTERNAL", "resolveApproval is not used by polling tests");
    },
  };

  const ports: BrowserPollPorts = {
    store,
    runs: {
      launch: async (command) => {
        launches.push(command);
        return store.tx(() => {
          const made = store.runs.enqueue({
            projectId: command.projectId,
            workflowId: command.workflowId,
            workflowHash: "test-hash",
            snapshot: command.snapshot,
            snapshotRaw: command.snapshotRaw,
            params: command.params,
            workspace: { selection: command.workspace, projectRoot: projectPath },
          });
          return {
            runId: made.runId,
            duplicate: made.duplicate,
            completion: new Promise<unknown>(() => undefined),
          };
        });
      },
      probe: async (command) => {
        probes.push(command);
        state.entered += 1;
        if (state.gate !== null) await state.gate();
        const next: ScriptedProbe = probeScript.shift() ?? {
          kind: "shell",
          stdout: "",
          exitCode: 0,
        };
        if ("fail" in next) {
          throw new CoreDevChestraError(
            next.fail as ConstructorParameters<typeof CoreDevChestraError>[0],
            "The probe refused this tick.",
          );
        }
        const made = store.runs.enqueue({
          projectId: command.projectId,
          workflowId: command.workflowId,
          workflowHash: "test-probe-hash",
          snapshot: command.snapshot,
          snapshotRaw: JSON.stringify(command.snapshot),
          kind: "poll_probe",
        });
        probeRunIds.push(made.runId);
        return { runId: made.runId, raw: next, durationMs: 5 };
      },
      pumpQueue: () => undefined,
    },
    freeze: {
      freeze: async (_projectId, _workflowId) => ({}),
    },
  };

  const scheduler = new PollScheduler({ ports, now: () => clock.now() });

  const app = createBrowserApp({
    dataDir,
    store: createStoreQueryPort(store),
    controller,
    sessionToken: TOKEN,
    instanceId: "polling-test",
    version: "0.1.0-test",
    port: PORT,
    validateResponses: true,
    now: () => clock.now(),
    workspaceService,
    polling: ports,
  });

  const workflowPath = (id: string): string =>
    join(projectPath, ".devchestra", "workflows", `${id}.json`);
  const harnessApi: PollHarness = {
    app,
    store,
    clock,
    scheduler,
    projectPath,
    dataDir,
    launches,
    probes,
    probeRunIds,
    probeScript,
    get git() {
      return state.git;
    },
    set git(value: boolean) {
      state.git = value;
    },
    get gateProbe() {
      return state.gate;
    },
    set gateProbe(value: (() => Promise<void>) | null) {
      state.gate = value;
    },
    enteredProbes: () => state.entered,
    writeWorkflow: (id, file) => {
      writeFileSync(workflowPath(id), `${JSON.stringify(file, null, 2)}\n`);
    },
    removeWorkflow: (id) => {
      rmSync(workflowPath(id), { force: true });
    },
    close: () => {
      scheduler.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harnessApi);
  return harnessApi;
}

export function closeAllPollHarnesses(): void {
  for (const harness of openHarnesses.splice(0)) harness.close();
}

export interface Res {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Browser-session request. Mutations carry the CSRF header and a JSON content type. */
export async function api(
  h: PollHarness,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Res> {
  const mutation = method !== "GET";
  const response = await h.app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      Host: HOST,
      Cookie: COOKIE,
      ...(mutation ? { "Content-Type": "application/json", "X-DevChestra-Csrf": "1" } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: parse(text) };
}

export function errorCode(res: Res): string | undefined {
  const error = (res.json as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string" ? error.code : undefined;
}

export function errorReason(res: Res): string | undefined {
  const details = (res.json as { error?: { details?: unknown } } | null)?.error?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Arms WORKFLOW_ID through the management route and returns the status body. */
export async function armPoll(
  h: PollHarness,
  intervalSeconds = 60,
): Promise<Record<string, unknown>> {
  const res = await api(
    h,
    "POST",
    `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/polling/arm`,
    { intervalSeconds },
  );
  if (res.status !== 200) throw new Error(`arm failed: ${res.status} ${res.text}`);
  return res.json as Record<string, unknown>;
}
