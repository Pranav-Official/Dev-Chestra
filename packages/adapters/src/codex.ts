import { join } from "node:path";
import { isRecord, ok, type RelayError, type Result } from "@relay/core";
import { clip, NdjsonParser, num, parseObject, record, str, UsageDelta } from "./parsers.js";
import { checkDir, classifyExit, fail, requireOptionKeys, stringList } from "./plan.js";
import { probeVersion } from "./probe.js";
import { codexStatic } from "./provider-config.js";
import type {
  AdapterEvent,
  AdapterOptions,
  CliAdapter,
  ExitInfo,
  FailureClass,
  Invocation,
  ProbeCtx,
  ProbeResult,
  RunRequest,
  StreamParser,
  Tail,
} from "./types.js";

const CONFIG_STRINGS = new Set([
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "review_model",
]);
const CONFIG_NUMBERS = new Set(["model_context_window", "model_max_output_tokens"]);
const CONFIG_BOOLEANS = new Set(["hide_agent_reasoning", "show_raw_agent_reasoning"]);

function mcpText(result: unknown, error: unknown): string {
  const failure = record(error);
  const message = str(failure?.message);
  if (message !== undefined) return message;
  const value = record(result);
  const content = value?.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const item = record(block);
        return item === null ? "" : (str(item.text) ?? "");
      })
      .filter((text) => text !== "")
      .join("\n");
  }
  return (
    str(content) ??
    (value?.structured_content === undefined ? "" : JSON.stringify(value.structured_content))
  );
}

function toml(value: string): string {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) throw new Error("config value contains a control character");
  }
  return JSON.stringify(value);
}

class CodexParser extends NdjsonParser {
  readonly #usage = new UsageDelta();
  readonly #calls = new Set<string>();
  #session = "";

  protected line(line: string): AdapterEvent[] {
    const event = parseObject(line);
    if (event === null) return [{ t: "raw", line }];
    const type = str(event.type);
    const events: AdapterEvent[] = [];
    if (type === "thread.started" || type === "session.created" || type === "session.started") {
      const session = str(event.thread_id) ?? str(event.session_id);
      if (session !== undefined && session !== this.#session) {
        this.#session = session;
        events.push({ t: "session", sessionId: session });
      }
      return events;
    }
    if (type === "item.completed" || type === "item.started") {
      const item = record(event.item);
      if (item === null) return [{ t: "raw", line }];
      const kind = str(item.type);
      if (kind === "agent_message" || kind === "assistant_message") {
        const text = str(item.text) ?? str(record(item.message)?.text);
        if (text !== undefined && text !== "") events.push({ t: "text", role: "assistant", text });
        return events.length === 0 ? [{ t: "raw", line }] : events;
      }
      if (kind === "command_execution" || kind === "shell_command") {
        const id = str(item.id) ?? "command";
        if (!this.#calls.has(id)) {
          this.#calls.add(id);
          events.push({
            t: "tool_call",
            id,
            name: "shell",
            input: { command: item.command ?? "" },
          });
        }
        if (type === "item.completed") {
          events.push({
            t: "tool_result",
            id,
            ok:
              typeof item.exit_code === "number"
                ? item.exit_code === 0
                : item.status === "completed",
            summary: clip(str(item.aggregated_output) ?? str(item.output) ?? "", 4096),
          });
        }
        return events;
      }
      if (kind === "mcp_tool_call") {
        const id = str(item.id) ?? "mcp-call";
        const name = str(item.tool) ?? str(item.name) ?? "unknown";
        if (!this.#calls.has(id)) {
          this.#calls.add(id);
          events.push({ t: "tool_call", id, name, input: item.arguments ?? {} });
        }
        if (type === "item.completed") {
          events.push({
            t: "tool_result",
            id,
            ok: item.error === undefined || item.error === null,
            summary: clip(mcpText(item.result, item.error), 4096),
          });
        }
        return events;
      }
      return [{ t: "raw", line }];
    }
    if (type === "turn.completed") {
      const usage = record(event.usage) ?? record(record(event.turn)?.usage);
      events.push(...this.#usage.take(num(usage?.input_tokens), num(usage?.output_tokens)));
      events.push({ t: "turn_end", isError: false });
      return events;
    }
    if (type === "turn.failed") {
      const error = record(event.error);
      events.push({ t: "turn_end", isError: true, text: str(error?.message) ?? "turn failed" });
      return events;
    }
    if (type === "error") {
      events.push({ t: "notice", level: "warn", text: str(event.message) ?? line });
      return events;
    }
    if (type === "turn.started") return [];
    return [{ t: "raw", line }];
  }
}

function plan(req: RunRequest, bin: string): Result<Invocation, RelayError> {
  try {
    checkDir(req.cwd, "cwd");
    checkDir(req.execDir, "execDir");
    if (req.mcp.command === "" || req.mcp.args.length === 0) {
      throw new Error("mcp.command and mcp.args are required");
    }
    const options = req.cliOptions ?? {};
    requireOptionKeys(options, ["configOverrides", "addDirs"]);
    const permissions = codexStatic.permissionMap;
    const writable = req.permissions.write.length > 0;
    const mode = writable ? permissions.writeMode : permissions.readOnlyMode;
    const overrides: string[] = [];
    if (options.configOverrides !== undefined) {
      if (!isRecord(options.configOverrides)) throw new Error("configOverrides must be an object");
      for (const [key, value] of Object.entries(options.configOverrides)) {
        if (CONFIG_STRINGS.has(key)) {
          if (typeof value !== "string") throw new Error(`Config override ${key} must be a string`);
          overrides.push("-c", `${key}=${toml(value)}`);
        } else if (CONFIG_NUMBERS.has(key)) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Config override ${key} must be a number`);
          }
          overrides.push("-c", `${key}=${String(value)}`);
        } else if (CONFIG_BOOLEANS.has(key)) {
          if (typeof value !== "boolean")
            throw new Error(`Config override ${key} must be a boolean`);
          overrides.push("-c", `${key}=${String(value)}`);
        } else throw new Error(`Config override ${key} is not permitted`);
      }
    }
    const addDirs = options.addDirs === undefined ? [] : stringList(options.addDirs, "addDirs");
    if (req.mode === "resume" && addDirs.length > 0) {
      throw new Error("addDirs is not supported on codex resume");
    }
    for (const dir of addDirs) checkDir(dir, "addDirs");

    const args = ["exec"];
    if (req.mode === "resume") {
      const session = req.sessionId;
      if (session === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(session)) {
        throw new Error("resume requires a safe sessionId");
      }
      args.push("resume", session);
    }
    args.push("--json");
    if (req.mode === "fresh") args.push("--sandbox", mode, "--cd", req.cwd);
    args.push("--skip-git-repo-check");
    for (const dir of addDirs) args.push("--add-dir", dir);
    if (req.model !== undefined && req.model !== "") args.push(codexStatic.modelArg, req.model);
    if (req.mode === "resume") args.push("-c", `sandbox_mode=${toml(mode)}`);
    args.push("-c", `sandbox_workspace_write.network_access=${String(req.permissions.network)}`);

    if (req.mcp.serverName !== "relay") throw new Error("mcp.serverName must be relay");
    const envNames = req.mcp.envNames ?? Object.keys(req.mcp.env);
    for (const name of envNames) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid MCP env name: ${name}`);
      }
    }
    args.push("-c", `mcp_servers.relay.command=${toml(req.mcp.command)}`);
    args.push("-c", `mcp_servers.relay.args=${JSON.stringify(req.mcp.args)}`);
    args.push("-c", `mcp_servers.relay.env_vars=${JSON.stringify(envNames)}`);
    args.push("-c", `mcp_servers.relay.default_tools_approval_mode=${toml("approve")}`);
    args.push("-c", "mcp_servers.relay.startup_timeout_sec=20");
    args.push("-c", "mcp_servers.relay.tool_timeout_sec=120");
    args.push(...overrides);
    args.push("-o", join(req.execDir, "last-message.txt"));

    return ok({
      bin,
      args,
      cwd: req.cwd,
      env: { ...req.env, ...req.mcp.env },
      stdin: req.prompt,
      files: [],
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createCodexAdapter(options: AdapterOptions = {}): CliAdapter {
  const bin = options.codexBin ?? "codex";
  return {
    id: "codex",
    caps: {
      enforcesPermissions: "advisory",
      structuredOutputFlag: true,
      resumeSupportsMcp: true,
      reportsCost: false,
      usageIsCumulative: true,
      promptViaStdin: true,
      maxPromptArgBytes: 0,
    },
    evidence: {
      cliVersion: "0.164.0",
      argvSource: "help-fixture",
      behaviorVerified: false,
      notes: [
        "resume rejects --sandbox/--cd/--add-dir/-a/-p; sandbox_mode is passed via -c",
        "env_vars forwarding and OS sandbox enforcement are UNVERIFIED",
        'per-server MCP approval mode "approve" is schema-valid; headless behavior was not proven until the bounded live smoke',
        "JSON stream event names are documented expectations, not live captures",
      ],
    },
    plan: (req) => plan(req, bin),
    parser: (): StreamParser => new CodexParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => `mcp__relay__${tool}`,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("codex", bin, ctx, signal),
  };
}
