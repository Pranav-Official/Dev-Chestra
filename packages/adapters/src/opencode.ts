import { ok, type RelayError, type Result } from "@relay/core";
import { clip, NdjsonParser, num, parseObject, record, str } from "./parsers.js";
import { hasControl } from "./discovery-util.js";
import { checkDir, classifyExit, fail, requireOptionKeys } from "./plan.js";
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

/** Per-invocation MCP attachment: env-only merges never register a server, so
 * the relay shim is injected through inline JSON config (highest precedence,
 * merged with the user's own config, never replacing it). */
function mcpConfigContent(req: RunRequest): string {
  return JSON.stringify({
    mcp: {
      [req.mcp.serverName]: {
        type: "local",
        command: [req.mcp.command, ...req.mcp.args],
        environment: req.mcp.env,
        enabled: true,
      },
    },
  });
}

function plan(req: RunRequest, bin: string): Result<Invocation, RelayError> {
  try {
    checkDir(req.cwd, "cwd");
    checkDir(req.execDir, "execDir");
    if (req.mcp.command === "" || req.mcp.args.length === 0) {
      throw new Error("mcp.command and mcp.args are required");
    }
    if (req.mcp.serverName !== "relay") throw new Error("mcp.serverName must be relay");
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
    args.push("--format", "json", "--dir", req.cwd);
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
      cliVersion: "1.19.4",
      argvSource: "help-fixture",
      behaviorVerified: false,
      notes: [
        "argv from opencode 1.19.4 run --help: run [prompt] --model provider/model --format json --dir <cwd> --session <ses_...>",
        "prompt travels as argv (promptViaStdin false), capped at 256 KiB; --session resumes, no --cd/--sandbox flags exist",
        "MCP server attaches via OPENCODE_CONFIG_CONTENT inline JSON (type local, command [shim, ...args], environment, enabled); env travels on fresh and resume",
        "MCP tools register as <server>_<tool>; submit_result is relay_submit_result",
        "JSON stream shapes (step_start/text/tool_use/step_finish/error) come from published cheatsheets, not a live capture",
        "usageIsCumulative false: step_finish tokens are per-step deltas emitted directly",
      ],
    },
    plan: (req) => plan(req, bin),
    parser: (): StreamParser => new OpencodeParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => `relay_${tool}`,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("opencode", bin, ctx, signal),
  };
}
