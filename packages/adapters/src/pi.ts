import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type DevChestraError, ok, type Result } from "@devchestra/core";
import { clip, NdjsonParser, num, parseObject, record, str } from "./parsers.js";
import { checkDir, classifyExit, fail, nativeShellOff, requireOptionKeys } from "./plan.js";
import { probeVersion } from "./probe.js";
import { piStatic } from "./provider-config.js";
import type {
  AdapterEvent,
  AdapterOptions,
  CliAdapter,
  ExitInfo,
  FailureClass,
  Invocation,
  ProbeCtx,
  ProbeResult,
  ResolvedMcpServer,
  RunRequest,
  StreamParser,
  Tail,
} from "./types.js";

const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SESSION_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      const item = record(block);
      return item === null ? "" : (str(item.text) ?? "");
    })
    .filter((text) => text !== "")
    .join("\n");
}

function usageOf(message: Record<string, unknown>): AdapterEvent[] {
  // Each completed message reports its own tokens: count it once, directly.
  // Intermediate message_update deltas and the turn_end echo of the last
  // message are skipped by the callers so a message is never counted twice.
  const usage = record(message.usage);
  if (usage === null) return [];
  const cost = record(usage.cost);
  const tokensIn = num(usage.input);
  const tokensOut = num(usage.output);
  const costUsd = num(cost?.total);
  if (tokensIn === undefined && tokensOut === undefined && costUsd === undefined) return [];
  if ((tokensIn ?? 0) === 0 && (tokensOut ?? 0) === 0 && (costUsd ?? 0) === 0) return [];
  const event: Extract<AdapterEvent, { t: "usage" }> = { t: "usage", cumulative: false };
  if (tokensIn !== undefined) event.tokensIn = tokensIn;
  if (tokensOut !== undefined) event.tokensOut = tokensOut;
  if (costUsd !== undefined) event.costUsd = costUsd;
  return [event];
}

class PiParser extends NdjsonParser {
  readonly #calls = new Set<string>();
  readonly #results = new Set<string>();
  #session = "";

  #emitSession(id: string | undefined, events: AdapterEvent[]): void {
    if (id !== undefined && id !== "" && id !== this.#session) {
      this.#session = id;
      events.push({ t: "session", sessionId: id });
    }
  }

  #toolCall(id: string, name: string, input: unknown, events: AdapterEvent[]): void {
    if (this.#calls.has(id)) return;
    this.#calls.add(id);
    events.push({ t: "tool_call", id, name, input: input ?? {} });
  }

  #toolResult(id: string, ok: boolean, summary: string, events: AdapterEvent[]): void {
    if (this.#results.has(id)) return;
    this.#results.add(id);
    events.push({ t: "tool_result", id, ok, summary });
  }

  #assistant(message: Record<string, unknown>, events: AdapterEvent[]): void {
    const content = message.content;
    if (typeof content === "string") {
      if (content !== "") events.push({ t: "text", role: "assistant", text: content });
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        const block = record(raw);
        const kind = str(block?.type);
        if (kind === "text") {
          const text = str(block?.text);
          if (text !== undefined && text !== "")
            events.push({ t: "text", role: "assistant", text });
        } else if (kind === "toolCall") {
          this.#toolCall(
            str(block?.id) ?? `tool-${this.#calls.size}`,
            str(block?.name) ?? "unknown",
            block?.arguments,
            events,
          );
        }
      }
    }
    events.push(...usageOf(message));
    const stop = str(message.stopReason);
    if (stop === "error" || stop === "aborted") {
      events.push({
        t: "notice",
        level: "warn",
        text: clip(str(message.errorMessage) ?? `assistant stopped: ${stop}`, 1024),
      });
    }
  }

  #toolResultMessage(message: Record<string, unknown>, events: AdapterEvent[]): void {
    const id = str(message.toolCallId) ?? "unknown";
    const summary = clip(contentText(message.content), 4096);
    this.#toolResult(id, message.isError !== true, summary, events);
    events.push(...usageOf(message));
  }

  #turnEnd(event: Record<string, unknown>): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    const message = record(event.message);
    if (message !== null) {
      const results = event.toolResults;
      if (Array.isArray(results)) {
        for (const raw of results) {
          const result = record(raw);
          if (result === null) continue;
          this.#toolResult(
            str(result.toolCallId) ?? "unknown",
            result.isError !== true,
            clip(contentText(result.content), 4096),
            events,
          );
        }
      }
      // turn_end re-states the last message's usage; counting it here would
      // double-count the message_end already handled above.
      const stop = str(message.stopReason);
      const isError = stop === "error" || stop === "aborted";
      events.push({
        t: "turn_end",
        isError,
        ...(isError ? { text: clip(str(message.errorMessage) ?? `turn ${stop}`, 4096) } : {}),
      });
      return events;
    }
    events.push({ t: "turn_end", isError: false });
    return events;
  }

  protected line(line: string): AdapterEvent[] {
    const event = parseObject(line);
    if (event === null) return [{ t: "raw", line }];
    const type = str(event.type);
    const events: AdapterEvent[] = [];
    switch (type) {
      case "session":
        this.#emitSession(str(event.id), events);
        return events;
      case "agent_start":
      case "turn_start":
      case "message_start":
      case "agent_end":
      case "agent_settled":
      case "tool_execution_update":
      case "queue_update":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
      case "compaction_start":
      case "compaction_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update":
        return events;
      case "message_end": {
        const message = record(event.message);
        if (message === null) return [{ t: "raw", line }];
        const role = str(message.role);
        if (role === "assistant") this.#assistant(message, events);
        else if (role === "toolResult") this.#toolResultMessage(message, events);
        else if (role === "bashExecution") {
          events.push({
            t: "notice",
            level: "info",
            text: clip(
              `bash ${str(message.command) ?? ""} exit ${String(message.exitCode ?? "?")}`,
              1024,
            ),
          });
        }
        return events;
      }
      case "message": {
        // Session-file shape; accept defensively, same as message_end.
        const message = record(event.message);
        if (message === null) return [{ t: "raw", line }];
        if (str(message.role) === "assistant") this.#assistant(message, events);
        else if (str(message.role) === "toolResult") this.#toolResultMessage(message, events);
        return events;
      }
      case "message_update": {
        // Streaming deltas only: text and usage finalize at message_end,
        // which is the single authoritative emission per message. Emitting
        // here as well duplicates both.
        const inner = record(event.assistantMessageEvent);
        const kind = str(inner?.type);
        if (kind === "toolcall_end") {
          const call = record(inner?.toolCall);
          if (call !== null) {
            this.#toolCall(
              str(call.id) ?? `tool-${this.#calls.size}`,
              str(call.name) ?? "unknown",
              call.arguments,
              events,
            );
          }
        } else if (kind === "error") {
          events.push({
            t: "notice",
            level: "warn",
            text: clip(str(inner?.error) ?? str(inner?.reason) ?? "stream error", 1024),
          });
        }
        return events;
      }
      case "tool_execution_start": {
        this.#toolCall(
          str(event.toolCallId) ?? `tool-${this.#calls.size}`,
          str(event.toolName) ?? "unknown",
          event.args,
          events,
        );
        return events;
      }
      case "tool_execution_end": {
        const result = record(event.result);
        this.#toolResult(
          str(event.toolCallId) ?? "unknown",
          event.isError !== true,
          clip(result === null ? "" : contentText(result.content), 4096),
          events,
        );
        return events;
      }
      case "turn_end":
        return this.#turnEnd(event);
      case "auto_retry_start":
        events.push({
          t: "notice",
          level: "info",
          text: clip(
            `retry ${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")}: ${str(event.errorMessage) ?? ""}`,
            1024,
          ),
        });
        return events;
      case "auto_retry_end":
        if (event.success !== true) {
          events.push({
            t: "notice",
            level: "warn",
            text: clip(str(event.finalError) ?? "retries exhausted", 1024),
          });
        }
        return events;
      case "extension_error":
        events.push({
          t: "notice",
          level: "warn",
          text: clip(str(event.error) ?? "extension error", 1024),
        });
        return events;
      default:
        return [{ t: "raw", line }];
    }
  }
}

/** mcp.json entry for one extra server (Pi's mcpServers shape). Secrets stay in the file. */
function extraMcpEntry(server: ResolvedMcpServer): Record<string, unknown> {
  if (server.transport === "http" || server.transport === "sse") {
    if (server.url === undefined || server.url === "") {
      throw new Error(`extraMcp server ${server.name} needs a url`);
    }
    return {
      url: server.url,
      ...(server.headers !== undefined ? { headers: server.headers } : {}),
    };
  }
  if (server.command === undefined || server.command === "" || server.args === undefined) {
    throw new Error(`extraMcp server ${server.name} needs command and args`);
  }
  if (server.cwd !== undefined) checkDir(server.cwd, "extraMcp cwd");
  for (const name of Object.keys(server.env ?? {})) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid extraMcp env name: ${name}`);
  }
  return {
    command: server.command,
    args: server.args,
    ...(server.env !== undefined ? { env: server.env } : {}),
    ...(server.cwd !== undefined && server.cwd !== "" ? { cwd: server.cwd } : {}),
  };
}

/** Validated extra servers: safe unique names, none colliding with devchestra. */
function extraMcpServers(req: RunRequest): ResolvedMcpServer[] {
  const extra = req.extraMcp ?? [];
  const seen = new Set<string>();
  for (const server of extra) {
    if (!MCP_NAME_RE.test(server.name)) {
      throw new Error(`extraMcp server name is not safe: ${server.name}`);
    }
    if (server.name === "devchestra" || server.name === req.mcp.serverName) {
      throw new Error(`extraMcp server name is reserved: ${server.name}`);
    }
    if (seen.has(server.name)) {
      throw new Error(`extraMcp duplicate server name: ${server.name}`);
    }
    seen.add(server.name);
  }
  return extra;
}

/**
 * Canonical agent dir shared by every Pi run on this host, or null when no
 * canonical credential store is in play (then plan() links nothing and runs
 * stay isolated). The engine serializes Pi runs on this scope: Pi's
 * auth.json lock is per supplied path (proper-lockfile realpath:false), so
 * per-run symlinks would otherwise lock different paths and lose concurrent
 * credential updates. Conservative by design: it matches symlink creation
 * except a pathological canonical==piHome overlap, which only over-locks.
 */
export function piCredentialScope(env: Record<string, string>, cwd: string): string | null {
  const dir = canonicalAgentDir(env, cwd);
  if (dir === null) return null;
  for (const name of ["auth.json", "models.json", "settings.json"] as const) {
    try {
      if (statSync(join(dir, name)).isFile()) return dir;
    } catch {
      // Absent: keep looking.
    }
  }
  return null;
}

function splitModel(model: string): { provider?: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { id: model };
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** Canonical agent dir Pi would use without DevChestra's isolation, resolved from
 * the child env exactly like discovery identity does. */
function canonicalAgentDir(env: Record<string, string>, cwd: string): string | null {
  const override = env.PI_CODING_AGENT_DIR;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) ? resolve(override) : resolve(cwd, override);
  }
  const home = env.HOME;
  if (home === undefined || home === "") return null;
  const base = isAbsolute(home) ? resolve(home) : resolve(cwd, home);
  return join(base, ".pi", "agent");
}

/** Absolute target when the canonical store actually carries the file, so the
 * isolated dir links live credentials/settings instead of hiding them. A
 * missing canonical file stays missing: first-login flows keep today's
 * isolated behavior rather than writing through a dangling link. */
function canonicalFile(
  env: Record<string, string>,
  cwd: string,
  isolatedDir: string,
  name: string,
): string | null {
  const dir = canonicalAgentDir(env, cwd);
  if (dir === null || dir === isolatedDir) return null;
  const target = join(dir, name);
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return target;
}

function plan(req: RunRequest, bin: string): Result<Invocation, DevChestraError> {
  try {
    checkDir(req.cwd, "cwd");
    checkDir(req.execDir, "execDir");
    if (req.mcp.command === "" || req.mcp.args.length === 0) {
      throw new Error("mcp.command and mcp.args are required");
    }
    if (req.mcp.serverName !== "devchestra") throw new Error("mcp.serverName must be devchestra");
    const options = req.cliOptions ?? {};
    requireOptionKeys(options, ["approve", "provider"]);
    if (options.approve !== undefined && typeof options.approve !== "boolean") {
      throw new Error("approve must be a boolean");
    }
    let providerOpt: string | undefined;
    if (options.provider !== undefined) {
      if (typeof options.provider !== "string" || !PROVIDER_RE.test(options.provider)) {
        throw new Error("provider must be a safe provider name");
      }
      providerOpt = options.provider;
    }
    const args = ["-p", "--mode", "json"];
    // Sessions persist under a node-stable dir so resume survives generation
    // exec dirs; the MCP home stays per-execDir because its token is per-run.
    const sessionDir = join(resolve(req.execDir), "..", "pi-sessions");
    args.push("--session-dir", sessionDir);
    if (req.mode === "resume") {
      const session = req.sessionId;
      if (session === undefined || !SESSION_RE.test(session)) {
        throw new Error("resume requires a safe sessionId");
      }
      args.push("--session-id", session);
    }
    if (req.model !== undefined && req.model !== "") {
      if (req.model.includes("\u0000") || req.model.length > 512) {
        throw new Error("model must be a non-empty pattern without NUL");
      }
      const split = splitModel(req.model);
      const provider = providerOpt ?? split.provider;
      if (provider !== undefined && !PROVIDER_RE.test(provider)) {
        throw new Error("provider must be a safe provider name");
      }
      if (provider !== undefined) args.push("--provider", provider);
      args.push(piStatic.modelArg, req.model);
    } else if (providerOpt !== undefined) {
      throw new Error("provider requires a model");
    }

    const permissions = piStatic.permissionMap;
    const denied: string[] = [];
    if (req.permissions.write.length === 0) denied.push(...permissions.readOnlyDeniedTools);
    if (!req.permissions.network) denied.push(...permissions.networkTools);
    // Shell is independent of write when explicitly set; undefined keeps legacy.
    // A shell policy excludes the native shell even when shell is true/undefined.
    if (nativeShellOff(req.permissions)) {
      for (const tool of ["bash", "powershell"]) {
        if (!denied.includes(tool)) denied.push(tool);
      }
    } else if (req.permissions.shell === true) {
      const kept = denied.filter((tool) => tool !== "bash");
      denied.length = 0;
      denied.push(...kept);
    }
    if (denied.length > 0) args.push("--exclude-tools", denied.join(","));

    // Default --no-approve: ignore trust-gated project-local files unless the
    // caller explicitly opts into project trust.
    args.push(options.approve === true ? "--approve" : "--no-approve");
    // Prompt travels as argv after -- so a leading dash is not parsed as a flag.
    args.push("--", req.prompt);

    const piHome = join(req.execDir, "pi-home");
    const mcpPath = join(piHome, "mcp.json");
    const mcpServers: Record<string, unknown> = {
      [req.mcp.serverName]: {
        command: req.mcp.command,
        args: req.mcp.args,
        env: req.mcp.env,
        // DevChestra tools are small and model-called: declare them like built-ins
        // instead of hiding them behind codemode/tool_search.
        exposure: "direct",
      },
    };
    for (const server of extraMcpServers(req)) mcpServers[server.name] = extraMcpEntry(server);
    const mcp = { mcpServers };
    for (const name of Object.keys(req.mcp.env)) {
      if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid MCP env name: ${name}`);
    }
    // The isolated dir carries only DevChestra's mcp.json, but auth.json (OAuth +
    // API-key credentials), models.json (custom models/endpoints) and
    // settings.json (defaults) link back to the canonical store: Pi keeps
    // working authentication, and credential refresh writes through the
    // links instead of dying in the per-run directory.
    const files: Invocation["files"] = [
      { path: mcpPath, content: `${JSON.stringify(mcp)}\n`, mode: 0o600 },
    ];
    for (const name of ["auth.json", "models.json", "settings.json"] as const) {
      const target = canonicalFile(req.env, req.cwd, piHome, name);
      if (target !== null) files.push({ path: join(piHome, name), symlink: target });
    }
    return ok({
      bin,
      args,
      cwd: req.cwd,
      env: { ...req.env, ...req.mcp.env, PI_CODING_AGENT_DIR: piHome },
      files,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createPiAdapter(options: AdapterOptions = {}): CliAdapter {
  const bin = options.piBin ?? "pi";
  return {
    id: "pi",
    caps: {
      enforcesPermissions: "advisory",
      structuredOutputFlag: true,
      resumeSupportsMcp: true,
      reportsCost: true,
      // Pi's wire usage is cumulative per assistant response, not per run:
      // each completed message_end carries that response's own totals.
      usageIsCumulative: false,
      promptViaStdin: false,
      maxPromptArgBytes: 0,
    },
    evidence: {
      cliVersion: "1.4.0",
      argvSource: "help-fixture",
      behaviorVerified: false,
      notes: [
        "argv from pi 1.4.0 --help plus docs/json.md, docs/message-types.md, docs/cli.md, docs/mcp.md; no live tool-call run captured",
        "--session-id creates the id when absent (pi warns); resume of a foreign id starts a new session",
        "isolated PI_CODING_AGENT_DIR carries devchestra mcp.json plus symlinks to the canonical auth.json/models.json/settings.json when present; API-key providers also pass through documented env vars",
        "symlinks alone cannot serialize Pi's per-path auth.json lock (proper-lockfile realpath:false): the engine holds auth.json.devchestra-lock in the canonical dir across Pi runs sharing it",
        "toolResult ok comes from ToolResultMessage.isError; turn_end error comes from stopReason/errorMessage",
        "extraMcp verified live 2026-10-28 (pi 1.4.0, opencode-go/deepseek-v4.1-flash): fixture stdio server in the isolated mcp.json called as mcp__fixture__fixture_echo (model found it via codemode searchTools; extras default to codemode exposure, only devchestra is direct); canonical-home unselected server not started",
        "permissions.shell verified live 2026-10-28: false+write excludes bash+powershell (model reports no bash tool); true+read-only runs bash (echo hi -> hi)",
        "live-run caveats 2026-10-28: isolated runs reinstall settings `packages` and need npm on the launching process PATH (version managers may expose it only in interactive shells); nvidia catalog models 404 for this account, ollama provider is down; opencode-go/deepseek-v4.1-flash worked",
      ],
    },
    plan: (req) => plan(req, bin),
    parser: (): StreamParser => new PiParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => `mcp__devchestra__${tool}`,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("pi", bin, ctx, signal),
  };
}
