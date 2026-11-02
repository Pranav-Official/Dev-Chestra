import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, REPO_ROOT, scriptPath, sleep } from "../../src/fixtures.js";
import type { DevChestraHttp, HttpResult } from "../../src/http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { collectSpawnedAgents } from "../../src/store-read.js";
import {
  createWorkflow,
  getWorkflow,
  registerProject,
  saveWorkflow,
  type WorkflowFileLike,
  waitTerminal,
} from "../../src/workflow-api.js";
import { git } from "./run-workspace-fixtures.js";

const require = createRequire(import.meta.url);

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (file: string) => SqliteDb;
};

export interface ExecutionDetail {
  execution: { path: string; status: string };
  process: { cwd: string } | null;
  output: { data: Record<string, unknown> | null } | null;
  workspace: { dir: string; baseSha: string | null } | null;
}

export interface RunDetail {
  raw: Record<string, unknown>;
  workspace: unknown;
  status: string;
}

export interface DirIdentity {
  dev: number;
  ino: number;
  commonDir: string;
}

export function workspaceWorkflow(
  legacyMode: "scratch" | "worktree" = "scratch",
): WorkflowFileLike {
  return {
    schemaVersion: 1,
    id: "run-workspace",
    name: "Run workspace acceptance",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "first",
          type: "shell",
          name: "First shell",
          command:
            "printf 'first tracked=%s dirty=%s untracked=%s ignored=%s' " +
            '"$(cat tracked.txt)" "$(cat dirty.txt)" ' +
            '"$(test -f untracked.txt && echo present || echo absent)" ' +
            '"$(test -f ignored/cache.txt && echo present || echo absent)"; ' +
            "printf 'shared-value' > shared.txt",
          workspace: { mode: legacyMode },
          timeoutMin: 1,
        },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          cli: "fake",
          prompt: "Return the accepted fake output.",
          output: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "points"],
            properties: {
              summary: { type: "string" },
              points: {
                type: "array",
                maxItems: 20,
                items: { type: "string", maxLength: 500 },
              },
            },
          },
          permissions: { network: false, write: ["workspace"] },
          workspace: { mode: legacyMode },
          limits: { timeoutMin: 1, validationRetries: 1, crashRetries: 0 },
        },
        {
          id: "second",
          type: "shell",
          name: "Second shell",
          command:
            "printf 'second shared=%s tracked=%s dirty=%s untracked=%s' " +
            '"$(cat shared.txt)" "$(cat tracked.txt)" "$(cat dirty.txt)" ' +
            '"$(test -f untracked.txt && echo present || echo absent)"',
          workspace: { mode: legacyMode },
          timeoutMin: 1,
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: '{ "first": first.stdout, "agent": agent.summary, "second": second.stdout }',
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "first" },
        { id: "e2", from: "first", to: "agent" },
        { id: "e3", from: "agent", to: "second" },
        { id: "e4", from: "second", to: "end" },
      ],
    },
  } as WorkflowFileLike;
}

export function workflowWithCommit(): WorkflowFileLike {
  const flow = workspaceWorkflow();
  const first = flow.graph.nodes.find((node) => node.id === "first") as Record<string, unknown>;
  first.command =
    'printf \'first tracked=%s dirty=%s\' "$(cat tracked.txt)" "$(cat dirty.txt)"; ' +
    "printf 'shared-v1' > shared.txt; " +
    "git -c commit.gpgsign=false add shared.txt; " +
    "git -c commit.gpgsign=false commit -qm 'workflow commit'";
  return flow;
}

export async function startRun(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  etag: string,
  workspace?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string; result: HttpResult }> {
  const body: Record<string, unknown> = { etag };
  if (workspace !== undefined) body.workspace = workspace;
  const result = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/runs`,
    {
      body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  );
  const parsed =
    typeof result.body === "object" && result.body !== null
      ? (result.body as Record<string, unknown>)
      : {};
  return { status: result.status, body: parsed, text: result.text, result };
}

export async function runDetail(http: DevChestraHttp, runId: string): Promise<RunDetail> {
  const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}`);
  assert.equal(result.status, 200, `GET run: ${result.text.slice(0, 600)}`);
  const body = result.body as Record<string, unknown>;
  return {
    raw: body,
    workspace: body.workspace,
    status: String((body.run as Record<string, unknown> | undefined)?.status ?? "unknown"),
  };
}

export async function execution(
  http: DevChestraHttp,
  runId: string,
  path: string,
): Promise<ExecutionDetail> {
  const result = await http.api(
    "GET",
    `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(path)}`,
  );
  assert.equal(result.status, 200, `GET execution ${path}: ${result.text.slice(0, 600)}`);
  return result.body as ExecutionDetail;
}

export async function cwdsFor(
  http: DevChestraHttp,
  runId: string,
): Promise<Record<string, string>> {
  const paths = ["first", "agent", "second"] as const;
  const cwds: Record<string, string> = {};
  for (const path of paths) {
    const detail = await execution(http, runId, path);
    assert.ok(detail.process !== null, `${path} execution has no process.cwd`);
    cwds[path] = detail.process.cwd;
  }
  return cwds;
}

export function stdoutOf(detail: ExecutionDetail): string {
  const data = detail.output?.data;
  assert.ok(data !== null && data !== undefined, "execution has no output data");
  return String(data.stdout);
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

export interface EventPageLike {
  events: Array<{ id: number; type: string; path: string; payload: unknown }>;
}

let eventPageSchema: { parse(value: unknown): unknown } | null = null;

async function canonicalEventPage(body: unknown): Promise<EventPageLike> {
  if (eventPageSchema === null) {
    const module = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/api/dist/index.js")).href
    )) as { eventPageResponseSchema: { parse(value: unknown): unknown } };
    eventPageSchema = module.eventPageResponseSchema;
  }
  return eventPageSchema.parse(body) as EventPageLike;
}

export async function readEventPage(http: DevChestraHttp, runId: string): Promise<EventPageLike> {
  const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}/events?limit=200`);
  assert.equal(result.status, 200, `GET run events: ${result.text.slice(0, 500)}`);
  return canonicalEventPage(result.body);
}

export async function waitSpawn(http: DevChestraHttp, runId: string, path: string): Promise<void> {
  await waitFor(
    async () => {
      const result = await http.api(
        "GET",
        `/api/runs/${encodeURIComponent(runId)}/events?limit=200`,
      );
      assert.equal(result.status, 200, `GET run events: ${result.text.slice(0, 500)}`);
      const page = await canonicalEventPage(result.body);
      if (
        page.events.some((event) => event.type === "node.session.captured" && event.path === path)
      ) {
        return true;
      }
      const completed = page.events.find((event) => event.type === "run.completed");
      if (completed !== undefined) {
        const payload = completed.payload as { status?: string } | undefined;
        throw new Error(`run completed ${payload?.status ?? "unknown"} before ${path} spawned`);
      }
      return false;
    },
    60_000,
    `${path} session`,
  );
}

export function patchRunWorkspaceColumnToNull(dataDir: string, runId: string): number {
  const db = new DatabaseSync(join(dataDir, "devchestra.db"));
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('runs')").all() as Array<{
      name: string;
    }>;
    const column = columns
      .map((entry) => entry.name)
      .find((name) => name === "workspace_json" || name.endsWith("_workspace"));
    if (column === undefined) throw new Error("runs table has no workspace column");
    const result = db.prepare(`UPDATE runs SET ${column} = NULL WHERE id = ?`).run(runId) as {
      changes?: number;
    };
    return Number(result.changes ?? 0);
  } finally {
    db.close();
  }
}

export function dirIdentity(path: string, env: NodeJS.ProcessEnv): DirIdentity {
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  const common = git(path, ["rev-parse", "--git-common-dir"], env);
  return { dev: info.dev, ino: info.ino, commonDir: realpathSync(resolve(path, common)) };
}

export interface ServerOptions {
  dataDir: string;
  projectRoot: string;
  fakeScript: string;
  env: Record<string, string>;
  keepDataDir?: boolean;
}

export async function withServer<T>(
  options: ServerOptions,
  fn: (server: OwnedServer) => Promise<T>,
): Promise<T> {
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let result: T | undefined;
  let failure: unknown;
  try {
    server = await startServer({
      cli: CLI,
      dataDir: options.dataDir,
      cwd: options.projectRoot,
      fakeScript: options.fakeScript,
      env: options.env,
    });
    result = await fn(server);
  } catch (error) {
    failure = error;
  }
  const failures = await cleanupRestarted(server, options.dataDir, sentinel, {
    keep: options.keepDataDir === true,
  });
  if (failure !== undefined) {
    if (failures.length > 0) throw new AggregateError([failure, ...failures], "server + cleanup");
    throw failure;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "server cleanup failed");
  return result as T;
}

export async function cleanupRestarted(
  server: OwnedServer | null,
  dataDir: string,
  sentinel: ChildProcess,
  options: { keep?: boolean } = {},
): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (server === null) {
    if (sentinel.exitCode !== null || sentinel.signalCode !== null) {
      failures.push(new Error("unrelated sentinel died during cleanup"));
    } else {
      sentinel.kill("SIGKILL");
    }
    return failures;
  }
  let agents: ReturnType<typeof collectSpawnedAgents> = [];
  let keep = options.keep === true;
  try {
    agents = collectSpawnedAgents(dataDir);
  } catch (error) {
    failures.push(error);
    keep = true;
  }
  try {
    await shutdownOwned({ server, agents, sentinel, keep, dataDir });
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

export async function createManaged(
  http: DevChestraHttp,
  projectRoot: string,
  workflow: WorkflowFileLike,
): Promise<{ projectId: string; workflowId: string; etag: string }> {
  const project = await registerProject(http, projectRoot);
  await createWorkflow(http, project.id, {
    name: "Run workspace acceptance",
    id: "run-workspace",
    template: "blank",
  });
  const blank = await getWorkflow(http, project.id, "run-workspace");
  const saved = await saveWorkflow(http, project.id, "run-workspace", workflow, blank.etag);
  assert.ok(
    saved.validation.ok,
    `workflow must validate: ${JSON.stringify(saved.validation).slice(0, 800)}`,
  );
  return { projectId: project.id, workflowId: saved.id, etag: saved.etag };
}

export { scriptPath, waitTerminal };
