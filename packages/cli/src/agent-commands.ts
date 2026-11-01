import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiClient, type CatalogCli } from "@devchestra/api";
import { parseWorkflow, type WorkflowFile } from "@devchestra/schema";
import { defaultDataDir } from "./data-dir.js";
import { attachToServer, readServerMetadata } from "./server-metadata.js";

const HELP = `Agent CLI (all commands return JSON; watch returns JSONL):
  devchestra project list|add|show [project] [--project PROJECT]
  devchestra workflow list|show|validate|create|update|delete [ID] --project PROJECT [--file FILE] [--if-match ETAG]
  devchestra run start|list|show|watch|events|execution|transcript|output|children|usage|cancel|resume [ID] [options]
  devchestra approval list|show|resolve [RUN-ID] [options]
  devchestra providers list|models|mcp [--project PROJECT] [--cli CLI]
Use --data-dir DIR to select the server. FILE may be - for stdin.
`;

type Flags = Record<string, string | boolean | string[]>;
function parse(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const switches = new Set(["json", "jsonl", "help"]);
  const values = new Set([
    "data-dir",
    "project",
    "file",
    "if-match",
    "path",
    "run",
    "decision",
    "note",
    "request-id",
    "expected-attempt",
    "expected-generation",
    "after",
    "cursor",
    "limit",
    "params-file",
    "param",
    "idempotency-key",
    "workspace",
    "worktree-path",
    "cli",
    "timeout",
    "until",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (switches.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!values.has(key)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (key === "param")
      flags[key] = [...(Array.isArray(flags[key]) ? (flags[key] as string[]) : []), value];
    else if (flags[key] !== undefined) throw new Error(`${arg} supplied more than once`);
    else flags[key] = value;
  }
  return { positional, flags };
}
function value(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required`);
  return v;
}
function numberFlag(flags: Flags, key: string): number | undefined {
  const raw = value(flags, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`--${key} must be a nonnegative integer`);
  return Number(raw);
}
async function readInput(file: string): Promise<unknown> {
  const text =
    file === "-"
      ? await new Promise<string>((ok, fail) => {
          let s = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (x: string) => {
            s += x;
          });
          process.stdin.on("end", () => ok(s));
          process.stdin.on("error", fail);
        })
      : await readFile(file, "utf8");
  return JSON.parse(text) as unknown;
}
async function workflow(flags: Flags): Promise<WorkflowFile> {
  const raw = await readInput(required(value(flags, "file"), "--file"));
  const parsed = parseWorkflow(raw);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
function print(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
async function projectId(client: ApiClient, raw: string): Promise<string> {
  let cursor: string | undefined;
  let canonical: string | undefined;
  try {
    canonical = await realpath(resolve(raw));
  } catch {
    /* ID or missing path */
  }
  do {
    const page = await client.listProjects(cursor === undefined ? {} : { cursor });
    const found = page.items.find(
      (p) => p.id === raw || (canonical !== undefined && p.path === canonical),
    );
    if (found) return found.id;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throw new Error(`Project not registered: ${raw}`);
}
function exitFor(status: string): number {
  return status === "succeeded"
    ? 0
    : status === "rejected"
      ? 2
      : status === "cancelled"
        ? 3
        : status === "paused" || status === "waiting_approval"
          ? 5
          : 1;
}
const stopped = (status: string): boolean =>
  ["succeeded", "failed", "rejected", "cancelled", "paused", "waiting_approval"].includes(status);

export async function executeAgentCommands(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const [group, action, id, extra] = positional;
  if (flags.help || !group || !action) {
    process.stdout.write(HELP);
    return 0;
  }
  const metadata = await readServerMetadata(resolve(value(flags, "data-dir") ?? defaultDataDir()));
  if (metadata.status !== "valid")
    throw new Error(
      "No usable server metadata; start the server with `devchestra start --headless`.",
    );
  await attachToServer(metadata.value, { allowHeadless: true });
  const client = new ApiClient({
    baseUrl: `http://127.0.0.1:${metadata.value.port}`,
    token: metadata.value.token,
  });
  const pid = async (): Promise<string> =>
    projectId(client, required(value(flags, "project"), "--project"));
  const runId = (): string => required(id, "run ID");
  const path = (): string => required(value(flags, "path"), "--path");
  const page = {
    ...(value(flags, "cursor") === undefined
      ? {}
      : { cursor: required(value(flags, "cursor"), "--cursor") }),
    ...(numberFlag(flags, "limit") === undefined ? {} : { limit: numberFlag(flags, "limit") ?? 0 }),
  };
  let result: unknown;
  if (group === "project") {
    if (action === "list") result = await client.listProjects(page);
    else if (action === "add")
      result = await client.registerProject({ path: resolve(required(id, "project path")) });
    else if (action === "show") {
      const p = await projectId(client, required(id ?? value(flags, "project"), "project"));
      result = {
        project: await client.getProject(p),
        workspaces: await client.listProjectWorkspaces(p),
      };
    } else throw new Error(`Unknown project action: ${action}`);
  } else if (group === "workflow") {
    const p = await pid();
    if (action === "list") result = await client.listWorkflows(p, page);
    else if (action === "show") result = await client.getWorkflow(p, required(id, "workflow ID"));
    else if (action === "validate") {
      const wf = await workflow(flags);
      const validation = await client.validateWorkflow(p, wf.id, { workflow: wf });
      print(validation);
      return validation.validation.ok ? 0 : 4;
    } else if (action === "create") {
      const wf = await workflow(flags);
      const validation = await client.validateWorkflow(p, wf.id, { workflow: wf });
      if (!validation.validation.ok) {
        print(validation);
        return 4;
      }
      result = await client.createWorkflow(p, { id: wf.id, name: wf.name, workflow: wf });
    } else if (action === "update") {
      const wf = await workflow(flags);
      const validation = await client.validateWorkflow(p, wf.id, { workflow: wf });
      if (!validation.validation.ok) {
        print(validation);
        return 4;
      }
      result = await client.saveWorkflow(
        p,
        required(id, "workflow ID"),
        { workflow: wf },
        required(value(flags, "if-match"), "--if-match"),
      );
    } else if (action === "delete") {
      await client.deleteWorkflow(
        p,
        required(id, "workflow ID"),
        required(value(flags, "if-match"), "--if-match"),
      );
      result = { ok: true };
    } else throw new Error(`Unknown workflow action: ${action}`);
  } else if (group === "run") {
    if (action === "start") {
      const p = await pid();
      const wf = await client.getWorkflow(p, required(id, "workflow ID"));
      const paramsRaw = value(flags, "params-file")
        ? await readInput(required(value(flags, "params-file"), "--params-file"))
        : {};
      if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw))
        throw new Error("Parameters must be a JSON object");
      const params = { ...paramsRaw } as Record<string, import("@devchestra/core").JsonValue>;
      for (const param of (flags.param as string[] | undefined) ?? []) {
        const at = param.indexOf("=");
        if (at < 1) throw new Error("--param requires key=value");
        const raw = param.slice(at + 1);
        try {
          params[param.slice(0, at)] = JSON.parse(raw);
        } catch {
          params[param.slice(0, at)] = raw;
        }
      }
      const mode = value(flags, "workspace") ?? "project";
      if (!["project", "new-worktree", "existing-worktree"].includes(mode))
        throw new Error("Invalid workspace mode");
      if (mode !== "existing-worktree" && value(flags, "worktree-path"))
        throw new Error("--worktree-path requires existing-worktree mode");
      const workspace =
        mode === "existing-worktree"
          ? ({ mode, path: required(value(flags, "worktree-path"), "--worktree-path") } as const)
          : mode === "new-worktree"
            ? ({ mode } as const)
            : ({ mode: "project" } as const);
      const key = value(flags, "idempotency-key");
      result = await client.startWorkflowRun(
        p,
        wf.workflow.id,
        { params, etag: value(flags, "if-match") ?? wf.etag, workspace },
        key ? { idempotencyKey: key } : {},
      );
    } else if (action === "list")
      result = await client.listRuns({
        ...page,
        ...(value(flags, "project") ? { project: await pid() } : {}),
      });
    else if (action === "show") result = await client.getRun(runId());
    else if (action === "events")
      result = await client.listRunEvents(runId(), {
        ...(numberFlag(flags, "after") === undefined
          ? {}
          : { after: numberFlag(flags, "after") ?? 0 }),
        ...(page.limit === undefined ? {} : { limit: page.limit }),
      });
    else if (action === "execution") result = await client.getExecution(runId(), path());
    else if (action === "transcript")
      result = await client.getExecutionTranscript(runId(), path(), page);
    else if (action === "output")
      result = await client.getRunOutput(runId(), required(extra, "output ID"));
    else if (action === "children") result = await client.listRunChildren(runId(), page);
    else if (action === "usage") {
      const detail = await client.getRun(runId());
      const executions = await Promise.all(
        Object.keys(detail.view.executions).map(async (executionPath) => {
          const execution = await client.getExecution(runId(), executionPath);
          return { path: executionPath, usage: execution.usage };
        }),
      );
      result = { runId: runId(), budget: detail.view.budget, executions };
    } else if (action === "cancel") result = await client.cancelRun(runId());
    else if (action === "resume") result = await client.resumeRun(runId());
    else if (action === "watch") {
      const after = numberFlag(flags, "after");
      const timeout = numberFlag(flags, "timeout");
      const controller = new AbortController();
      const timer =
        timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout * 1000);
      const until = value(flags, "until") ?? "action";
      if (!["action", "terminal"].includes(until))
        throw new Error("--until must be action or terminal");
      try {
        const initial = await client.getRun(runId());
        let cursor = after ?? initial.watermark;
        if (after === undefined)
          print({
            event: "snapshot",
            data: { runId: runId(), view: initial.view, watermark: initial.watermark },
          });
        else {
          let hasMore = true;
          while (hasMore) {
            const page = await client.listRunEvents(runId(), {
              after: cursor,
              upTo: initial.watermark,
              limit: 200,
            });
            for (const event of page.events) print({ event: "run", id: event.id, data: event });
            cursor = page.nextAfter;
            hasMore = page.hasMore;
          }
        }
        const shouldStop = (status: string): boolean =>
          stopped(status) &&
          (until === "action" || !["paused", "waiting_approval"].includes(status));
        if (shouldStop(initial.view.status)) {
          print({ event: "state", data: initial.view });
          return exitFor(initial.view.status);
        }
        for await (const message of client.streamRunEvents(
          runId(),
          { after: cursor },
          { signal: controller.signal },
        )) {
          print(message);
          if (message.event === "overflow")
            throw new Error(`Stream overflow; reconnect with --after ${message.data.lastEventId}`);
          if (message.event === "run") {
            const detail = await client.getRun(runId());
            if (message.id >= detail.watermark && shouldStop(detail.view.status)) {
              print({ event: "state", data: detail.view });
              return exitFor(detail.view.status);
            }
          }
        }
        throw new Error("Run stream disconnected; reconnect using the last event ID");
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    } else throw new Error(`Unknown run action: ${action}`);
  } else if (group === "approval") {
    if (action === "list")
      result = value(flags, "run")
        ? await client.listRunApprovals(required(value(flags, "run"), "--run"), page)
        : await client.listApprovals({
            ...page,
            ...(value(flags, "project") ? { project: await pid() } : {}),
          });
    else if (action === "show") result = await client.getApproval(runId(), path());
    else if (action === "resolve") {
      const decision = required(value(flags, "decision"), "--decision");
      if (decision !== "approve" && decision !== "reject")
        throw new Error("--decision must be approve or reject");
      result = await client.resolveApproval(runId(), path(), {
        decision,
        requestId: required(value(flags, "request-id"), "--request-id"),
        expectedAttempt: numberFlag(flags, "expected-attempt") ?? 0,
        expectedGeneration: numberFlag(flags, "expected-generation") ?? 0,
        ...(value(flags, "note") === undefined
          ? {}
          : { note: required(value(flags, "note"), "--note") }),
      });
    } else throw new Error(`Unknown approval action: ${action}`);
  } else if (group === "providers") {
    if (action === "list")
      result = {
        clis: await client.listClis(),
        status: await client.listCliStatus(),
        decisions: await client.listDecisionProviders(),
      };
    else if (action === "models")
      result = await client.getCliModels(
        await pid(),
        required(value(flags, "cli"), "--cli") as CatalogCli,
      );
    else if (action === "mcp")
      result = await client.getCliMcpServers(
        await pid(),
        required(value(flags, "cli"), "--cli") as CatalogCli,
      );
    else throw new Error(`Unknown providers action: ${action}`);
  } else throw new Error(`Unknown command: ${group}`);
  print(result);
  return 0;
}
