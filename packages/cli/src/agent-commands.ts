import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApiClient,
  ApiTransportError,
  type CatalogCli,
  type DecisionTestRequest,
  type GateTestRequest,
  type WorkflowGroupsDocument,
} from "@devchestra/api";
import { parseWorkflow, type WorkflowFile, workflowJsonSchema } from "@devchestra/schema";
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

type CommandSpec = { min: number; max: number; flags: string[]; description: string };
const common = ["data-dir", "json"];
const pageFlags = ["cursor", "limit"];
export const COMMANDS: Record<string, CommandSpec> = {
  "project list": { min: 0, max: 0, flags: pageFlags, description: "List registered projects" },
  "project add": { min: 1, max: 1, flags: [], description: "Register a project" },
  "project show": {
    min: 0,
    max: 1,
    flags: ["project"],
    description: "Inspect a project and its workspaces",
  },
  "workflow schema": { min: 0, max: 0, flags: [], description: "Print the structural JSON schema" },
  "workflow list": {
    min: 0,
    max: 0,
    flags: ["project", ...pageFlags],
    description: "List workflows",
  },
  "workflow show": {
    min: 1,
    max: 1,
    flags: ["project"],
    description: "Inspect a workflow and revision",
  },
  "workflow validate": {
    min: 0,
    max: 0,
    flags: ["project", "file"],
    description: "Validate a workflow document",
  },
  "workflow create": {
    min: 0,
    max: 0,
    flags: ["project", "file"],
    description: "Create a workflow",
  },
  "workflow update": {
    min: 1,
    max: 1,
    flags: ["project", "file", "if-match"],
    description: "Update a workflow with revision fence",
  },
  "workflow delete": {
    min: 1,
    max: 1,
    flags: ["project", "if-match"],
    description: "Delete a workflow with revision fence",
  },
  "workflow groups-show": {
    min: 0,
    max: 0,
    flags: ["project"],
    description: "Show workflow groups",
  },
  "workflow groups-update": {
    min: 0,
    max: 0,
    flags: ["project", "file", "if-match"],
    description: "Save workflow groups with revision fence",
  },
  "gate test": {
    min: 0,
    max: 0,
    flags: ["project", "file"],
    description: "Preview a gate without starting a run",
  },
  "decision test": {
    min: 0,
    max: 0,
    flags: ["project", "file"],
    description: "Test a decision provider (makes a live paid request)",
  },
  "run start": {
    min: 1,
    max: 1,
    flags: [
      "project",
      "params-file",
      "param",
      "workspace",
      "worktree-path",
      "idempotency-key",
      "if-match",
    ],
    description: "Start a durable run",
  },
  "run list": {
    min: 0,
    max: 0,
    flags: ["project", "workflow", "status", "archived", ...pageFlags],
    description: "List runs",
  },
  "run show": { min: 1, max: 1, flags: [], description: "Inspect a run" },
  "run events": { min: 1, max: 1, flags: ["after", "limit"], description: "Page run events" },
  "run execution": { min: 1, max: 1, flags: ["path"], description: "Inspect an execution" },
  "run transcript": {
    min: 1,
    max: 1,
    flags: ["path", ...pageFlags],
    description: "Page an execution transcript",
  },
  "run output": { min: 2, max: 2, flags: [], description: "Inspect an output preview" },
  "run children": { min: 1, max: 1, flags: pageFlags, description: "List child runs" },
  "run foreach": {
    min: 1,
    max: 1,
    flags: ["source", ...pageFlags],
    description: "List foreach items",
  },
  "run usage": { min: 1, max: 1, flags: [], description: "Inspect execution usage" },
  "run cancel": { min: 1, max: 1, flags: [], description: "Cancel a run" },
  "run resume": {
    min: 1,
    max: 1,
    flags: [
      "retry-uncertain-shell",
      "path",
      "expected-attempt",
      "expected-generation",
      "expected-event-id",
    ],
    description:
      "Resume a run; retrying an uncertain shell requires explicit authorization and a fence",
  },
  "run watch": {
    min: 1,
    max: 1,
    flags: ["jsonl", "after", "timeout", "until"],
    description: "Stream run state and events",
  },
  "approval list": {
    min: 0,
    max: 0,
    flags: ["run", "project", ...pageFlags],
    description: "List approvals",
  },
  "approval show": { min: 1, max: 1, flags: ["path"], description: "Inspect an approval" },
  "approval resolve": {
    min: 1,
    max: 1,
    flags: ["path", "decision", "request-id", "expected-attempt", "expected-generation", "note"],
    description: "Resolve a fenced approval",
  },
  "providers list": { min: 0, max: 0, flags: [], description: "List providers and readiness" },
  "providers models": {
    min: 0,
    max: 0,
    flags: ["project", "cli"],
    description: "List provider models",
  },
  "providers mcp": {
    min: 0,
    max: 0,
    flags: ["project", "cli"],
    description: "List configured MCP servers",
  },
};
Object.assign(COMMANDS, {
  "project remove": { min: 1, max: 1, flags: [], description: "Remove a project registration" },
  "project relink": { min: 1, max: 1, flags: ["path"], description: "Relink a project path" },
  "run context": { min: 1, max: 1, flags: pageFlags, description: "Page run context" },
  "run archive": { min: 1, max: 1, flags: [], description: "Archive a run" },
  "run restore": { min: 1, max: 1, flags: [], description: "Restore an archived run" },
  "providers refresh-models": {
    min: 0,
    max: 0,
    flags: ["project", "cli"],
    description: "Refresh provider model discovery",
  },
  "providers probe": { min: 0, max: 0, flags: ["cli"], description: "Probe provider status" },
  "providers enable": { min: 0, max: 0, flags: ["cli"], description: "Enable a provider" },
  "providers disable": { min: 0, max: 0, flags: ["cli"], description: "Disable a provider" },
} satisfies Record<string, CommandSpec>);
export function capabilities(): unknown {
  return {
    contractVersion: 1,
    commands: Object.entries(COMMANDS).map(([name, spec]) => ({
      name: name.replace("groups-", "groups "),
      ...spec,
      flags: [...common, ...spec.flags],
    })),
    nodes: [
      "start",
      "agent",
      "shell",
      "gate",
      "join",
      "approval",
      "decision",
      "loop",
      "foreach",
      "workflow",
      "end",
    ],
    workspaceModes: ["project", "new-worktree", "existing-worktree"],
    headlessServer: true,
    budgetEnforcement: false,
    schemaIsStructural: true,
  };
}
export class AgentUsageError extends Error {}
export class AgentCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
    readonly hint?: string,
  ) {
    super(message);
  }
}
function validateCommand(positional: string[], flags: Flags): void {
  const name = positional.slice(0, 2).join(" ");
  const spec = COMMANDS[name];
  if (!spec) throw new AgentUsageError(`Unknown command: ${name}`);
  const count = positional.length - 2;
  if (count < spec.min || count > spec.max)
    throw new AgentUsageError(`Wrong number of arguments for ${name}`);
  for (const flag of Object.keys(flags))
    if (![...common, ...spec.flags, "help"].includes(flag))
      throw new AgentUsageError(`--${flag} is not valid for ${name}`);
  if (
    flags["retry-uncertain-shell"] !== true &&
    ["path", "expected-attempt", "expected-generation", "expected-event-id"].some(
      (key) => flags[key] !== undefined,
    ) &&
    name === "run resume"
  )
    throw new AgentUsageError("Retry fence requires --retry-uncertain-shell");
}

type Flags = Record<string, string | boolean | string[]>;
function parse(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const switches = new Set(["json", "jsonl", "help", "retry-uncertain-shell"]);
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
    "source",
    "status",
    "workflow",
    "archived",
    "expected-event-id",
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
    if (!values.has(key)) throw new AgentUsageError(`Unknown option: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--"))
      throw new AgentUsageError(`${arg} requires a value`);
    if (key === "param")
      flags[key] = [...(Array.isArray(flags[key]) ? (flags[key] as string[]) : []), value];
    else if (flags[key] !== undefined) throw new AgentUsageError(`${arg} supplied more than once`);
    else flags[key] = value;
  }
  return { positional, flags };
}
function value(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
function required(v: string | undefined, name: string): string {
  if (!v) throw new AgentUsageError(`${name} is required`);
  return v;
}
function numberFlag(flags: Flags, key: string): number | undefined {
  const raw = value(flags, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new AgentUsageError(`--${key} must be a nonnegative integer`);
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
  const record =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? { contractVersion: 1, ...result }
      : { contractVersion: 1, data: result };
  process.stdout.write(`${JSON.stringify(record)}\n`);
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
  if (positional[0] === "workflow" && positional[1] === "groups" && positional[2])
    positional.splice(1, 2, `groups-${positional[2]}`);
  const [group, action, id, extra] = positional;
  if (flags.help || !group || !action) {
    const matches = Object.entries(COMMANDS).filter(
      ([name]) => !group || name.startsWith(`${group} `),
    );
    process.stdout.write(
      HELP +
        "\n" +
        matches
          .map(
            ([name, spec]) =>
              `  ${name.replace("groups-", "groups ")}: ${spec.description} [${[...common, ...spec.flags].map((flag) => `--${flag}`).join(" ")}]`,
          )
          .join("\n") +
        "\n",
    );
    return 0;
  }
  validateCommand(positional, flags);
  if (group === "workflow" && action === "schema") {
    print({
      schema: workflowJsonSchema(),
      schemaVersion: 1,
      semanticValidation: "Run workflow validate for graph and project rules.",
    });
    return 0;
  }
  const metadata = await readServerMetadata(resolve(value(flags, "data-dir") ?? defaultDataDir()));
  if (metadata.status !== "valid")
    throw new AgentCommandError(
      "E_SERVER_UNAVAILABLE",
      "No usable server metadata.",
      true,
      undefined,
      "Start the server with devchestra start --headless.",
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
    else if (action === "remove")
      result = await client.removeProject(await projectId(client, required(id, "project")));
    else if (action === "relink")
      result = await client.relinkProject(await projectId(client, required(id, "project")), {
        path: resolve(path()),
      });
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
    else if (action === "groups-show") result = await client.getWorkflowGroups(p);
    else if (action === "groups-update")
      result = await client.saveWorkflowGroups(
        p,
        (await readInput(required(value(flags, "file"), "--file"))) as WorkflowGroupsDocument,
        required(value(flags, "if-match"), "--if-match"),
      );
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
  } else if (group === "gate" && action === "test") {
    result = await client.testGate(
      await pid(),
      (await readInput(required(value(flags, "file"), "--file"))) as GateTestRequest,
    );
  } else if (group === "decision" && action === "test") {
    result = await client.testDecision(
      await pid(),
      (await readInput(required(value(flags, "file"), "--file"))) as DecisionTestRequest,
    );
  } else if (group === "run") {
    if (action === "start") {
      const p = await pid();
      const wf = await client.getWorkflow(p, required(id, "workflow ID"));
      const paramsRaw = value(flags, "params-file")
        ? await readInput(required(value(flags, "params-file"), "--params-file"))
        : {};
      if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw))
        throw new AgentUsageError("Parameters must be a JSON object");
      const params = { ...paramsRaw } as Record<string, import("@devchestra/core").JsonValue>;
      for (const param of (flags.param as string[] | undefined) ?? []) {
        const at = param.indexOf("=");
        if (at < 1) throw new AgentUsageError("--param requires key=value");
        const raw = param.slice(at + 1);
        try {
          params[param.slice(0, at)] = JSON.parse(raw);
        } catch {
          params[param.slice(0, at)] = raw;
        }
      }
      const mode = value(flags, "workspace") ?? "project";
      if (!["project", "new-worktree", "existing-worktree"].includes(mode))
        throw new AgentUsageError("Invalid workspace mode");
      if (mode !== "existing-worktree" && value(flags, "worktree-path"))
        throw new AgentUsageError("--worktree-path requires existing-worktree mode");
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
        ...(value(flags, "workflow") ? { workflow: value(flags, "workflow") } : {}),
        ...(value(flags, "status")
          ? { status: value(flags, "status") as import("@devchestra/core").RunStatus }
          : {}),
        ...(value(flags, "archived")
          ? { archived: value(flags, "archived") as "true" | "false" }
          : {}),
      });
    else if (action === "show") result = await client.getRun(runId());
    else if (action === "events")
      result = await client.listRunEvents(runId(), {
        ...(numberFlag(flags, "after") === undefined
          ? {}
          : { after: numberFlag(flags, "after") ?? 0 }),
        ...(page.limit === undefined ? {} : { limit: page.limit }),
      });
    else if (action === "context") result = await client.getRunContext(runId(), page);
    else if (action === "archive") result = await client.setRunArchived(runId(), true);
    else if (action === "restore") result = await client.setRunArchived(runId(), false);
    else if (action === "execution") result = await client.getExecution(runId(), path());
    else if (action === "transcript")
      result = await client.getExecutionTranscript(runId(), path(), page);
    else if (action === "output")
      result = await client.getRunOutput(runId(), required(extra, "output ID"));
    else if (action === "children") result = await client.listRunChildren(runId(), page);
    else if (action === "foreach")
      result = await client.listForeachItems(
        runId(),
        required(value(flags, "source"), "--source"),
        page,
      );
    else if (action === "usage") {
      const detail = await client.getRun(runId());
      const executions = [];
      for (const executionPath of Object.keys(detail.view.executions)) {
        const execution = await client.getExecution(runId(), executionPath);
        executions.push({ path: executionPath, usage: execution.usage, scope: "current_attempt" });
      }
      result = {
        runId: runId(),
        budget: detail.view.budget,
        executions,
        note: "Per-execution figures are for the current attempt; missing provider reports are not zero cost.",
      };
    } else if (action === "cancel") result = await client.cancelRun(runId());
    else if (action === "resume") {
      const fence =
        flags["retry-uncertain-shell"] === true
          ? {
              path: path(),
              attempt: numberFlag(flags, "expected-attempt") ?? 0,
              generation: numberFlag(flags, "expected-generation") ?? 0,
              eventId: numberFlag(flags, "expected-event-id") ?? -1,
            }
          : undefined;
      result = await client.resumeRun(
        runId(),
        {},
        fence === undefined ? undefined : { uncertaintyFence: fence },
      );
    } else if (action === "watch") {
      const after = numberFlag(flags, "after");
      const timeout = numberFlag(flags, "timeout");
      let lastEventId = after;
      const controller = new AbortController();
      const timer =
        timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout * 1000);
      const until = value(flags, "until") ?? "action";
      if (!["action", "terminal"].includes(until))
        throw new AgentUsageError("--until must be action or terminal");
      try {
        const initial = await client.getRun(runId(), { signal: controller.signal });
        let cursor = after ?? initial.watermark;
        if (after === undefined) lastEventId = initial.watermark;
        if (after === undefined)
          print({
            event: "snapshot",
            data: { runId: runId(), view: initial.view, watermark: initial.watermark },
          });
        else {
          let hasMore = true;
          while (hasMore) {
            const page = await client.listRunEvents(
              runId(),
              {
                after: cursor,
                upTo: initial.watermark,
                limit: 200,
              },
              { signal: controller.signal },
            );
            for (const event of page.events) {
              print({ event: "run", id: event.id, data: event });
              lastEventId = event.id;
            }
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
            throw new AgentCommandError(
              "E_STREAM_OVERFLOW",
              "Stream overflow.",
              true,
              { lastEventId: message.data.lastEventId },
              "Reconnect with --after using lastEventId.",
            );
          if (message.event === "run") lastEventId = message.id;
          if (message.event === "run") {
            const detail = await client.getRun(runId(), { signal: controller.signal });
            if (message.id >= detail.watermark && shouldStop(detail.view.status)) {
              print({ event: "state", data: detail.view });
              return exitFor(detail.view.status);
            }
          }
        }
        throw new AgentCommandError(
          "E_STREAM_DISCONNECTED",
          "Run stream disconnected.",
          true,
          { lastEventId },
          "Inspect the run and reconnect with --after using lastEventId.",
        );
      } catch (error) {
        if (error instanceof ApiTransportError)
          throw new AgentCommandError(
            "E_STREAM_DISCONNECTED",
            "Run stream disconnected.",
            true,
            { lastEventId },
            "Inspect the run and reconnect with --after using lastEventId.",
          );
        if (controller.signal.aborted)
          throw new AgentCommandError(
            "E_TIMEOUT",
            "Watch timed out.",
            true,
            { lastEventId },
            "Inspect the run and reconnect with --after using lastEventId.",
          );
        throw error;
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
        throw new AgentUsageError("--decision must be approve or reject");
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
    else if (action === "refresh-models")
      result = await client.refreshCliModels(
        await pid(),
        required(value(flags, "cli"), "--cli") as CatalogCli,
      );
    else if (action === "probe")
      result = await client.probeCli(required(value(flags, "cli"), "--cli") as CatalogCli);
    else if (action === "enable" || action === "disable")
      result = await client.setCliEnabled(required(value(flags, "cli"), "--cli") as CatalogCli, {
        enabled: action === "enable",
      });
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
