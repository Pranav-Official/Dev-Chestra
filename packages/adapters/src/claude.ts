import { join } from "node:path";
import { ok, type RelayError, type Result } from "@relay/core";
import { clip, NdjsonParser, num, parseObject, record, str, UsageDelta } from "./parsers.js";
import {
  checkDir,
  checkToolNames,
  classifyExit,
  fail,
  requireOptionKeys,
  stringList,
  uuid,
} from "./plan.js";
import { probeVersion } from "./probe.js";
import { claudeStatic } from "./provider-config.js";
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

const ALLOWED = new Set([
  "allowedTools",
  "disallowedTools",
  "appendSystemPrompt",
  "maxBudgetUsd",
  "addDirs",
]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      const item = record(block);
      return item === null ? "" : (str(item.text) ?? JSON.stringify(item));
    })
    .filter((text) => text !== "")
    .join("\n");
}

class ClaudeParser extends NdjsonParser {
  readonly #usage = new UsageDelta();
  #session = "";

  protected line(line: string): AdapterEvent[] {
    const event = parseObject(line);
    if (event === null) return [{ t: "raw", line }];
    const type = str(event.type);
    const events: AdapterEvent[] = [];
    if (type === "system" && event.subtype === "init") {
      const session = str(event.session_id);
      if (session !== undefined && session !== this.#session) {
        this.#session = session;
        events.push({ t: "session", sessionId: session });
      }
      return events;
    }
    if (type === "assistant") {
      const message = record(event.message);
      const content = message?.content;
      if (typeof content === "string") events.push({ t: "text", role: "assistant", text: content });
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = record(raw);
          const kind = str(block?.type);
          if (kind === "text") {
            const text = str(block?.text);
            if (text !== undefined && text !== "")
              events.push({ t: "text", role: "assistant", text });
          } else if (kind === "tool_use") {
            events.push({
              t: "tool_call",
              id: str(block?.id) ?? `tool-${events.length}`,
              name: str(block?.name) ?? "unknown",
              input: block?.input ?? {},
            });
          }
        }
      }
      return events.length === 0 ? [{ t: "raw", line }] : events;
    }
    if (type === "user") {
      const message = record(event.message);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = record(raw);
          if (str(block?.type) !== "tool_result") continue;
          events.push({
            t: "tool_result",
            id: str(block?.tool_use_id) ?? "unknown",
            ok: block?.is_error !== true,
            summary: clip(contentText(block?.content), 4096),
          });
        }
      }
      return events.length === 0 ? [{ t: "raw", line }] : events;
    }
    if (type === "result") {
      const session = str(event.session_id);
      if (session !== undefined && session !== this.#session) {
        this.#session = session;
        events.push({ t: "session", sessionId: session });
      }
      const usage = record(event.usage);
      events.push(
        ...this.#usage.take(
          num(usage?.input_tokens),
          num(usage?.output_tokens),
          num(event.total_cost_usd),
        ),
      );
      const text = str(event.result);
      events.push({
        t: "turn_end",
        isError: event.is_error === true,
        ...(text === undefined ? {} : { text: clip(text, 16_384) }),
      });
      return events;
    }
    return [{ t: "raw", line }];
  }
}

function plan(req: RunRequest, bin: string): Result<Invocation, RelayError> {
  try {
    if (req.cwd === "" || req.execDir === "") throw new Error("cwd and execDir are required");
    checkDir(req.cwd, "cwd");
    checkDir(req.execDir, "execDir");
    if (req.mcp.command === "" || req.mcp.args.length === 0) {
      throw new Error("mcp.command and mcp.args are required");
    }
    const options = req.cliOptions ?? {};
    requireOptionKeys(options, [...ALLOWED]);
    const extraAllowed =
      options.allowedTools === undefined ? [] : stringList(options.allowedTools, "allowedTools");
    const extraDenied =
      options.disallowedTools === undefined
        ? []
        : stringList(options.disallowedTools, "disallowedTools");
    checkToolNames(extraAllowed, "allowedTools");
    checkToolNames(extraDenied, "disallowedTools");
    if (
      options.appendSystemPrompt !== undefined &&
      typeof options.appendSystemPrompt !== "string"
    ) {
      throw new Error("appendSystemPrompt must be a string");
    }
    if (options.maxBudgetUsd !== undefined) {
      if (
        typeof options.maxBudgetUsd !== "number" ||
        !Number.isFinite(options.maxBudgetUsd) ||
        options.maxBudgetUsd <= 0
      ) {
        throw new Error("maxBudgetUsd must be a positive number");
      }
    }
    const addDirs = options.addDirs === undefined ? [] : stringList(options.addDirs, "addDirs");
    for (const dir of addDirs) checkDir(dir, "addDirs");

    const permissions = claudeStatic.permissionMap;
    const writable = req.permissions.write.length > 0;
    const allowed = new Set(["mcp__relay__*", "Read", "Glob", "Grep", ...extraAllowed]);
    const denied = new Set<string>(extraDenied);
    if (writable) for (const tool of permissions.writeTools) allowed.add(tool);
    else for (const tool of permissions.readOnlyDeniedTools) denied.add(tool);
    if (req.permissions.network) for (const tool of permissions.networkTools) allowed.add(tool);
    else for (const tool of permissions.networkTools) denied.add(tool);
    for (const tool of extraAllowed) {
      if (denied.has(tool)) {
        throw new Error(`cliOptions.allowedTools cannot enable permission-disabled tool ${tool}`);
      }
    }

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (req.mode === "resume") {
      if (req.sessionId === undefined || !uuid(req.sessionId)) {
        throw new Error("resume requires a valid UUID sessionId");
      }
      args.push("--resume", req.sessionId);
    }
    const mcpPath = join(req.execDir, "mcp.json");
    args.push("--mcp-config", mcpPath, "--strict-mcp-config", "--permission-mode", "dontAsk");
    args.push("--allowedTools", [...allowed].join(","));
    if (denied.size > 0) args.push("--disallowedTools", [...denied].join(","));
    if (req.limits.maxTurns !== undefined) {
      if (!Number.isSafeInteger(req.limits.maxTurns) || req.limits.maxTurns < 1) {
        throw new Error("limits.maxTurns must be a positive integer");
      }
      args.push("--max-turns", String(req.limits.maxTurns));
    }
    if (req.model !== undefined && req.model !== "") args.push(claudeStatic.modelArg, req.model);
    for (const dir of new Set([...req.permissions.extraReadDirs, ...addDirs])) {
      checkDir(dir, "extraReadDirs");
      args.push("--add-dir", dir);
    }
    if (typeof options.appendSystemPrompt === "string") {
      args.push("--append-system-prompt", options.appendSystemPrompt);
    }
    if (typeof options.maxBudgetUsd === "number") {
      args.push("--max-budget-usd", String(options.maxBudgetUsd));
    }

    const mcp = {
      mcpServers: {
        [req.mcp.serverName]: { command: req.mcp.command, args: req.mcp.args, env: req.mcp.env },
      },
    };
    return ok({
      bin,
      args,
      cwd: req.cwd,
      env: req.env,
      stdin: req.prompt,
      files: [{ path: mcpPath, content: `${JSON.stringify(mcp)}\n`, mode: 0o600 }],
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createClaudeAdapter(options: AdapterOptions = {}): CliAdapter {
  const bin = options.claudeBin ?? "claude";
  return {
    id: "claude-code",
    caps: {
      enforcesPermissions: "partial",
      structuredOutputFlag: true,
      resumeSupportsMcp: true,
      reportsCost: true,
      usageIsCumulative: true,
      promptViaStdin: true,
      maxPromptArgBytes: 0,
    },
    evidence: {
      cliVersion: "2.1.310",
      argvSource: "help-fixture",
      behaviorVerified: false,
      notes: [
        "no --sandbox flag; sandbox settings and enforcement are unverified",
        "--max-turns is hidden but parses in 2.1.310",
        "stream shapes, cost accounting and resume re-attachment are UNVERIFIED",
        "bounded live fresh+resume submit passed 2026-10-26; sandbox/permission enforcement is still unverified",
      ],
    },
    plan: (req) => plan(req, bin),
    parser: (): StreamParser => new ClaudeParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => `mcp__relay__${tool}`,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("claude-code", bin, ctx, signal),
  };
}
