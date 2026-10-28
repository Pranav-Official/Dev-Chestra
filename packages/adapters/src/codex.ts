import { join } from "node:path";
import { isRecord, ok, type RelayError, type Result } from "@relay/core";
import { hasControl } from "./discovery-util.js";
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

/** Inline TOML table for string maps (JSON objects are not valid TOML). */
function tomlTable(entries: Array<readonly [string, string]>): string {
  return `{${entries.map(([key, value]) => `${toml(key)} = ${toml(value)}`).join(", ")}}`;
}

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names that become `-c` key-path segments must be strict: dots would
 *  escape the intended nesting and `relay` is the always-attached shim. */
function checkMcpName(name: string, field: string): string {
  if (!MCP_NAME_RE.test(name)) {
    throw new Error(`${field} is not a safe MCP server name: ${name}`);
  }
  if (name === "relay") {
    throw new Error(`${field} must not be "relay" (reserved for the Relay shim)`);
  }
  return name;
}

/** Env var synthesised for one HTTP header value: the value itself travels
 *  only in the child process env, never in argv. */
function headerEnvVar(server: string, header: string): string {
  const clean = (part: string): string => part.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `RELAY_MCP_${clean(server)}_${clean(header)}`;
}

interface ExtraMcpPlan {
  flags: string[];
  env: Record<string, string>;
}

/** Per-run MCP selection for Codex. Selected extras are attached via
 *  `-c mcp_servers.<name>.*` overrides (secret values only in the child
 *  env); every known-but-unselected stdio/http server is switched off via
 *  `enabled=false`; connectors go through the built-in `codex_apps` server
 *  (`features.apps` gate plus per-connector `[apps.<id>] enabled`). */
function planExtraMcp(req: RunRequest): ExtraMcpPlan {
  const flags: string[] = [];
  const env: Record<string, string> = {};
  const claimEnv = (name: string, value: string, what: string): void => {
    if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid MCP env name: ${name}`);
    const existing = env[name] ?? req.env[name] ?? req.mcp.env[name];
    if (existing !== undefined && existing !== value) {
      throw new Error(`MCP server ${what} redefines already-set env var ${name}`);
    }
    env[name] = value;
  };

  const extras = req.extraMcp ?? [];
  const seen = new Set<string>();
  const selectedServers = new Set<string>();
  const selectedConnectors = new Set<string>();
  for (const extra of extras) {
    // Connectors first: discovery intentionally uses human-readable display
    // names (spaces, parentheses, etc.); only the connectorId becomes a `-c`
    // key-path segment, so only it needs the strict safe-name check. The
    // display name is never interpolated into config and must not fail here.
    if (extra.scope === "connector") {
      if (extra.connectorId === undefined || extra.connectorId === "") {
        throw new Error(`extraMcp connector ${extra.name} is missing its connectorId`);
      }
      checkMcpName(extra.connectorId, "extraMcp[].connectorId");
      if (selectedConnectors.has(extra.connectorId)) {
        throw new Error(`Duplicate extraMcp connector: ${extra.connectorId}`);
      }
      selectedConnectors.add(extra.connectorId);
      continue;
    }
    checkMcpName(extra.name, "extraMcp[].name");
    if (seen.has(extra.name)) throw new Error(`Duplicate extraMcp server: ${extra.name}`);
    seen.add(extra.name);
    selectedServers.add(extra.name);
    if (extra.transport === "http" || extra.transport === "sse") {
      if (extra.url === undefined || extra.url === "") {
        throw new Error(`extraMcp server ${extra.name} needs a url`);
      }
      const headers = Object.entries(extra.headers ?? {});
      const table: Array<readonly [string, string]> = [];
      for (const [header, value] of headers) {
        if (header === "" || hasControl(header)) {
          throw new Error(`extraMcp server ${extra.name} has an invalid header name`);
        }
        const varName = headerEnvVar(extra.name, header);
        claimEnv(varName, value, extra.name);
        table.push([header, varName]);
      }
      flags.push("-c", `mcp_servers.${extra.name}.url=${toml(extra.url)}`);
      if (table.length > 0) {
        flags.push("-c", `mcp_servers.${extra.name}.env_http_headers=${tomlTable(table)}`);
      }
      flags.push("-c", `mcp_servers.${extra.name}.enabled=true`);
      flags.push("-c", `mcp_servers.${extra.name}.default_tools_approval_mode=${toml("approve")}`);
    } else {
      if (extra.command === undefined || extra.command === "") {
        throw new Error(`extraMcp server ${extra.name} needs a command`);
      }
      const names = Object.keys(extra.env ?? {});
      for (const [key, value] of Object.entries(extra.env ?? {})) claimEnv(key, value, extra.name);
      flags.push("-c", `mcp_servers.${extra.name}.command=${toml(extra.command)}`);
      flags.push("-c", `mcp_servers.${extra.name}.args=${JSON.stringify(extra.args ?? [])}`);
      flags.push("-c", `mcp_servers.${extra.name}.env_vars=${JSON.stringify(names)}`);
      if (extra.cwd !== undefined) {
        flags.push("-c", `mcp_servers.${extra.name}.cwd=${toml(extra.cwd)}`);
      }
      flags.push("-c", `mcp_servers.${extra.name}.enabled=true`);
      flags.push("-c", `mcp_servers.${extra.name}.default_tools_approval_mode=${toml("approve")}`);
    }
  }

  for (const known of req.knownMcp ?? []) {
    if (known.scope === "connector") continue; // covered by the apps gate below
    if (known.name === "relay") continue; // our own shim, always attached
    checkMcpName(known.name, "knownMcp[].name");
    if (!selectedServers.has(known.name)) {
      flags.push("-c", `mcp_servers.${known.name}.enabled=false`);
    }
  }

  if (selectedConnectors.size === 0) {
    // No connector selected: switch the whole built-in apps server off, but
    // only when the engine told us what is known (otherwise legacy inherit).
    if (req.knownMcp !== undefined) flags.push("-c", "features.apps=false");
  } else {
    flags.push("-c", "features.apps=true");
    flags.push("-c", "apps.default.enabled=false");
    for (const id of selectedConnectors) flags.push("-c", `apps.${id}.enabled=true`);
  }
  return { flags, env };
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
      if (!ENV_NAME_RE.test(name)) {
        throw new Error(`Invalid MCP env name: ${name}`);
      }
    }
    args.push("-c", `mcp_servers.relay.command=${toml(req.mcp.command)}`);
    args.push("-c", `mcp_servers.relay.args=${JSON.stringify(req.mcp.args)}`);
    args.push("-c", `mcp_servers.relay.env_vars=${JSON.stringify(envNames)}`);
    args.push("-c", `mcp_servers.relay.default_tools_approval_mode=${toml("approve")}`);
    args.push("-c", "mcp_servers.relay.startup_timeout_sec=20");
    args.push("-c", "mcp_servers.relay.tool_timeout_sec=120");
    const extraMcp = planExtraMcp(req);
    args.push(...extraMcp.flags);
    // Built-in shell tool: undefined keeps the legacy rule (shell follows the
    // sandbox mode above); false asks the CLI to remove it, true leaves it.
    if (req.permissions.shell === false) args.push("-c", "features.shell_tool=false");
    args.push(...overrides);
    args.push("-o", join(req.execDir, "last-message.txt"));

    return ok({
      bin,
      args,
      cwd: req.cwd,
      env: { ...req.env, ...req.mcp.env, ...extraMcp.env },
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
        "LIVE codex 0.164.0: stdio extra attached via -c mcp_servers.<name>.command/args/env_vars/enabled=true started AND was called (fixture log: start+call, turn completed); headless calls need default_tools_approval_mode=approve or the turn is denied (approval policy is never)",
        "LIVE: known-but-unselected server (mcp_servers.other.enabled=false, server present in CODEX_HOME config) never started while the selected extra ran; exact selection holds for listed servers",
        "mcp_servers.<unknown>.enabled=false FAILS the run (codex: invalid transport): disables only work for servers present in codex's loaded config (global or trusted-project); stale/untrusted names fail fast instead of silently leaving servers on",
        "LIVE: features.shell_tool=false removes the shell tool (model reports NOSHELL, no command_execution items); without the flag the same prompt runs echo. Shell true/undefined leaves the sandbox-mode rule untouched",
        "connectors: no selection -> features.apps=false (coarse off, live run succeeds); selection -> features.apps=true + apps.default.enabled=false + apps.<connectorId>.enabled=true. Key shapes pass --strict-config, but per-connector tool filtering is UNVERIFIED (verifying would invoke real account tools)",
        "http extras use url + env_http_headers (header values only in the child env); key shapes pass --strict-config but no live HTTP MCP server was exercised",
        "live turns occasionally stall with no output (model-side flake); retries of the identical invocation completed",
        "JSON stream mcp_tool_call items carry server/tool/arguments/result/error/status; tool names are bare (fixture/fixture_echo), not mcp__-prefixed",
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
