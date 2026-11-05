import { type DevChestraError, ok, type Result } from "@devchestra/core";
import { hasControl } from "./discovery-util.js";
import { clip, NdjsonParser, num, parseObject, record, str } from "./parsers.js";
import { checkDir, classifyExit, fail, nativeShellOff, requireOptionKeys } from "./plan.js";
import { probeVersion } from "./probe.js";
import { opencodeStatic } from "./provider-config.js";
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

const SESSION_RE = /^ses_[A-Za-z0-9]{1,128}$/;
const MODEL_MAX = 256;
const PROMPT_MAX_BYTES = 256 * 1024;

function usageOf(part: Record<string, unknown>): AdapterEvent[] {
  // step_finish tokens are per-step deltas, not cumulative totals: emit them
  // directly instead of subtracting across steps.
  const tokens = record(part.tokens);
  const tokensIn = tokens === null ? undefined : num(tokens.input);
  const tokensOut = tokens === null ? undefined : num(tokens.output);
  const costUsd = num(part.cost);
  if (tokensIn === undefined && tokensOut === undefined && costUsd === undefined) return [];
  const usage: Extract<AdapterEvent, { t: "usage" }> = { t: "usage", cumulative: false };
  if (tokensIn !== undefined) usage.tokensIn = tokensIn;
  if (tokensOut !== undefined) usage.tokensOut = tokensOut;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return [usage];
}

function toolOutcome(state: Record<string, unknown>): { ok: boolean; summary: string } {
  const metadata = record(state.metadata);
  const exit = metadata === null ? undefined : metadata.exit;
  const ok =
    state.status === "completed" &&
    state.error === undefined &&
    (typeof exit !== "number" || exit === 0);
  const summary = clip(str(state.output) ?? str(metadata?.output) ?? str(state.title) ?? "", 4096);
  return { ok, summary };
}

class OpencodeParser extends NdjsonParser {
  readonly #calls = new Set<string>();
  #session = "";

  #emitSession(events: AdapterEvent[], session: string | undefined): void {
    if (session !== undefined && session !== "" && session !== this.#session) {
      this.#session = session;
      events.push({ t: "session", sessionId: session });
    }
  }

  protected line(line: string): AdapterEvent[] {
    const event = parseObject(line);
    if (event === null) return [{ t: "raw", line }];
    const type = str(event.type);
    const events: AdapterEvent[] = [];
    this.#emitSession(events, str(event.sessionID));
    if (type === "step_start") return events;
    if (type === "text") {
      const text = str(record(event.part)?.text);
      if (text !== undefined && text !== "") events.push({ t: "text", role: "assistant", text });
      return events.length === 0 ? [{ t: "raw", line }] : events;
    }
    if (type === "tool_use") {
      const part = record(event.part);
      const state = record(part?.state);
      if (part === null || state === null) return [{ t: "raw", line }];
      const id = str(part.callID) ?? str(part.id) ?? `tool-${this.#calls.size}`;
      if (!this.#calls.has(id)) {
        this.#calls.add(id);
        events.push({
          t: "tool_call",
          id,
          name: str(part.tool) ?? "unknown",
          input: state.input ?? {},
        });
      }
      if (state.status === "completed") {
        const outcome = toolOutcome(state);
        events.push({ t: "tool_result", id, ok: outcome.ok, summary: outcome.summary });
      }
      return events;
    }
    if (type === "step_finish") {
      const part = record(event.part);
      if (part !== null) events.push(...usageOf(part));
      if (str(part?.reason) === "stop") events.push({ t: "turn_end", isError: false });
      return events;
    }
    if (type === "error") {
      const error = record(event.error);
      const data = record(error?.data);
      const text = clip(
        str(data?.message) ?? str(error?.message) ?? str(error?.name) ?? "opencode error",
        4096,
      );
      events.push({ t: "turn_end", isError: true, text });
      return events;
    }
    return [{ t: "raw", line }];
  }
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Server names become inline-config keys; `devchestra` is the always-attached shim. */
function checkMcpName(name: string, field: string): string {
  if (!MCP_NAME_RE.test(name)) {
    throw new Error(`${field} is not a safe MCP server name: ${name}`);
  }
  if (name === "devchestra") {
    throw new Error(`${field} must not be "devchestra" (reserved for the DevChestra shim)`);
  }
  return name;
}

/** Split an OpenCode tool name into its MCP server and tool parts. OpenCode
 *  registers MCP tools as `<server>_<tool>`; returns null when the name does
 *  not start with a known `server_` prefix (longest match wins). Built-in
 *  tools such as `bash` never match. */
export function splitOpencodeMcpTool(
  name: string,
  servers: readonly string[],
): { server: string; tool: string } | null {
  let best: { server: string; tool: string } | null = null;
  for (const server of servers) {
    const prefix = `${server}_`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      const candidate = { server, tool: name.slice(prefix.length) };
      if (best === null || candidate.server.length > best.server.length) best = candidate;
    }
  }
  return best;
}

/** Per-invocation MCP attachment: env-only merges never register a server, so
 *  the devchestra shim is injected through inline JSON config (highest precedence,
 *  merged with the user's own config, never replacing it). */
function mcpConfigContent(req: RunRequest): string {
  const seen = new Set<string>([req.mcp.serverName]);
  const mcp: Record<string, unknown> = {
    [req.mcp.serverName]: {
      type: "local",
      command: [req.mcp.command, ...req.mcp.args],
      environment: req.mcp.env,
      enabled: true,
    },
  };
  for (const extra of req.extraMcp ?? []) {
    checkMcpName(extra.name, "extraMcp[].name");
    if (seen.has(extra.name)) throw new Error(`Duplicate extraMcp server: ${extra.name}`);
    seen.add(extra.name);
    if (extra.transport === "http" || extra.transport === "sse") {
      if (extra.url === undefined || extra.url === "") {
        throw new Error(`extraMcp server ${extra.name} needs a url`);
      }
      mcp[extra.name] = {
        type: "remote",
        url: extra.url,
        headers: extra.headers ?? {},
        enabled: true,
      };
    } else {
      if (extra.command === undefined || extra.command === "") {
        throw new Error(`extraMcp server ${extra.name} needs a command`);
      }
      mcp[extra.name] = {
        type: "local",
        command: [extra.command, ...(extra.args ?? [])],
        environment: extra.env ?? {},
        ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}),
        enabled: true,
      };
    }
  }
  // Exact selection: everything the CLI knows but the node did not select
  // stays off, so the merged user config cannot start it.
  for (const known of req.knownMcp ?? []) {
    if (known.name === req.mcp.serverName) continue; // our own shim, always on
    checkMcpName(known.name, "knownMcp[].name");
    if (!seen.has(known.name)) mcp[known.name] = { enabled: false };
  }
  const config: Record<string, unknown> = { mcp };
  // Built-in shell tool: undefined keeps the legacy rule (no shell switch);
  // false denies bash. Verified live against opencode 1.19.4 (see evidence).
  // A policy disables the native shell too; the DevChestra exec tool is the only command route.
  if (nativeShellOff(req.permissions)) config.permission = { bash: "deny" };
  return JSON.stringify(config);
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
    requireOptionKeys(options, []);
    if (req.prompt === "" || req.prompt.includes("\u0000")) {
      throw new Error("prompt must be a non-empty string without NUL");
    }
    if (Buffer.byteLength(req.prompt, "utf8") > PROMPT_MAX_BYTES) {
      throw new Error(`prompt exceeds ${PROMPT_MAX_BYTES} bytes; shorten it`);
    }
    let model: string | undefined;
    if (req.model !== undefined && req.model !== "") {
      if (req.model.includes("\u0000") || hasControl(req.model) || req.model.length > MODEL_MAX) {
        throw new Error("model must be a safe provider/model id");
      }
      // Exact passthrough: the discovered id is used verbatim as -m/--model.
      model = req.model;
    }

    const args = ["run", req.prompt];
    if (model !== undefined) args.push(opencodeStatic.modelArg, model);
    // --standalone: OPENCODE_CONFIG_CONTENT is honored only by a private server;
    // the shared background service silently ignores per-run config (SPIKES 2026-11-04).
    // No --dir: 2.2.5 rejects it, the cwd below is the working directory.
    args.push("--format", "json", "--standalone");
    if (req.mode === "resume") {
      const session = req.sessionId;
      if (session === undefined || !SESSION_RE.test(session)) {
        throw new Error("resume requires a safe opencode sessionId (ses_...)");
      }
      args.push("--session", session);
    }

    for (const name of Object.keys(req.mcp.env)) {
      if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid MCP env name: ${name}`);
    }
    return ok({
      bin,
      args,
      cwd: req.cwd,
      // Env travels on every invocation, so resume re-attaches the MCP
      // server through the same inline config.
      env: { ...req.env, ...req.mcp.env, OPENCODE_CONFIG_CONTENT: mcpConfigContent(req) },
      files: [],
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createOpencodeAdapter(options: AdapterOptions = {}): CliAdapter {
  const bin = options.opencodeBin ?? "opencode";
  return {
    id: "opencode",
    caps: {
      enforcesPermissions: "advisory",
      structuredOutputFlag: true,
      resumeSupportsMcp: true,
      reportsCost: true,
      usageIsCumulative: false,
      promptViaStdin: false,
      maxPromptArgBytes: PROMPT_MAX_BYTES,
    },
    evidence: {
      cliVersion: "2.2.5",
      argvSource: "help-fixture",
      behaviorVerified: false,
      notes: [
        "argv from opencode 2.2.5 run --help: run [prompt] --model provider/model --format json --standalone --session <ses_...>; cwd is the process working directory (2.2.5 rejects --dir)",
        'LIVE opencode 2.2.5 (standalone, `OPENCODE_CONFIG_CONTENT` `permission:{bash:"deny"}`): no `tool_use`, model reports NOSHELL; without it the same prompt runs `echo hi` via the `shell` tool. The `bash` permission key still gates the renamed `shell` tool. Caution: only `--standalone` (private server) honors per-run `OPENCODE_CONFIG_CONTENT`; against the shared background service the deny is silently ignored. Adapter `run --dir` is rejected by 2.2.5 (stale argv from 1.19.4); 1.x flat `mcp` inline shape still attaches.',
        "prompt travels as argv (promptViaStdin false), capped at 256 KiB; --session resumes, no --cd/--sandbox flags exist",
        "MCP server attaches via OPENCODE_CONFIG_CONTENT inline JSON (type local, command [shim, ...args], environment, enabled); env travels on fresh and resume",
        "LIVE opencode 1.19.4: inline JSON merges with the user config - a user-configured fixture server starts when the inline config only carries devchestra, and does NOT start when the inline config adds mcp.<name>.enabled=false",
        "LIVE: inline local extra starts and is callable as <server>_<tool> (fixture_fixture_echo, log: start+call); remote extras use {type:remote,url,headers,enabled:true} per the installed config shape (no live remote server exercised)",
        "LIVE 1.19.4: inline permission:{bash:deny} removes the built-in bash tool (model reports NOSHELL, no tool_use); without it the same prompt runs echo. tools.bash=false was not needed and stays untested",
        "LIVE route-around: with bash denied, the model ran the same echo via an attached MCP exec tool (linremote_shell) - shell:false is advisory, never a sandbox",
        "MCP tools register as <server>_<tool>; splitOpencodeMcpTool attributes them to known servers (longest prefix wins); devchestra_submit_result is the submit ref",
        "JSON stream shapes (step_start/text/tool_use/step_finish/error) confirmed against live --format json output",
        "usageIsCumulative false: step_finish tokens are per-step deltas emitted directly",
      ],
    },
    plan: (req) => plan(req, bin),
    parser: (): StreamParser => new OpencodeParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => `devchestra_${tool}`,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("opencode", bin, ctx, signal),
  };
}
