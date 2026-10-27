import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, type RelayError, type Result } from "@relay/core";
import { clip, NdjsonParser, parseObject, str } from "./parsers.js";
import { checkDir, classifyExit, fail, requireOptionKeys } from "./plan.js";
import { probeVersion } from "./probe.js";
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

const DEFAULT_FAKE = fileURLToPath(
  new URL("../../../tools/fake-agent/dist/main.js", import.meta.url),
);

class FakeParser extends NdjsonParser {
  #session = "";

  protected line(line: string): AdapterEvent[] {
    const event = parseObject(line);
    if (event === null || event.type !== "relay-fake") return [{ t: "raw", line }];
    const kind = str(event.event);
    const events: AdapterEvent[] = [];
    const session = str(event.sessionId);
    if (session !== undefined && session !== this.#session) {
      this.#session = session;
      events.push({ t: "session", sessionId: session });
    }
    if (kind === "say") {
      const text = str(event.text);
      if (text !== undefined) events.push({ t: "text", role: "assistant", text });
    } else if (kind === "tools") {
      events.push({
        t: "notice",
        level: "info",
        text: `tools ${String(event.count ?? 0)}: ${JSON.stringify(event.names ?? [])}`,
      });
    } else if (kind === "tool_result" || kind === "submit_result") {
      const id = `${kind}-${String(event.index ?? 0)}`;
      const name = kind === "submit_result" ? "submit_result" : (str(event.name) ?? "tool");
      events.push({ t: "tool_call", id, name, input: {} });
      events.push({
        t: "tool_result",
        id,
        ok: kind === "submit_result" ? event.accepted === true : event.isError !== true,
        summary: clip(str(event.text) ?? "", 4096),
      });
    } else if (kind === "crash") {
      events.push({
        t: "notice",
        level: "warn",
        text: `scripted crash ${String(event.code ?? "")}`,
      });
    } else if (kind === "error") {
      events.push({ t: "notice", level: "warn", text: str(event.message) ?? "fake agent error" });
    } else if (kind === "end") {
      events.push({
        t: "turn_end",
        isError: false,
        text: event.submitted === true ? "submitted" : "ended without submit",
      });
    } else if (kind === "session" || kind === "sleep") {
      // Session is emitted above; sleep is informational only.
    } else {
      return [{ t: "raw", line }];
    }
    return events;
  }
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${"/"}`) && !path.startsWith("..\\"));
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

/** Resolve the longest existing prefix so a missing checkpoint file is safe. */
function realWithin(root: string, target: string): boolean {
  let probe = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      const resolved = suffix.length === 0 ? real : join(real, ...suffix.slice().reverse());
      return within(root, resolved);
    } catch (error) {
      if (!missing(error)) return false;
      const parent = dirname(probe);
      if (parent === probe) return false;
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}

function checkpointPath(req: RunRequest, value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("checkpoint must be a path");
  const target = isAbsolute(value) ? resolve(value) : resolve(req.cwd, value);
  // The checkpoint may live in the shared cwd or in the engine-owned exec dir.
  const allowed = [req.cwd, req.execDir].some((root) => {
    if (!within(resolve(root), target)) return false;
    return realWithin(canonicalRoot(root), target);
  });
  if (!allowed) throw new Error("checkpoint must stay inside the workspace (cwd) or execDir");
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error("checkpoint must not be a symlink");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return target;
}

function plan(req: RunRequest, bin: string, fake: string): Result<Invocation, RelayError> {
  try {
    checkDir(req.cwd, "cwd");
    checkDir(req.execDir, "execDir");
    const options = req.cliOptions ?? {};
    requireOptionKeys(options, ["checkpoint", "session", "script"]);
    if (options.script !== undefined) throw new Error("script is not a cliOption");
    const checkpoint =
      options.checkpoint === undefined ? undefined : checkpointPath(req, options.checkpoint);
    if (req.mode === "resume" && checkpoint === undefined) {
      throw new Error("fake resume requires cliOptions.checkpoint");
    }
    if (options.session !== undefined && typeof options.session !== "string") {
      throw new Error("session must be a string");
    }
    const args = [fake, "--format", "relay-fake", "--cwd", req.cwd];
    if (checkpoint !== undefined) args.push("--checkpoint", checkpoint);
    if (req.mode === "resume") args.push("--resume");
    else if (typeof options.session === "string") args.push("--session", options.session);
    return ok({
      bin,
      args,
      cwd: req.cwd,
      env: req.env,
      stdin: req.prompt,
      files: [],
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export interface FakeAdapterOptions extends AdapterOptions {
  /** Trusted test-only script; never sourced from workflow cliOptions. */
  fakeScript?: unknown[] | string;
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): CliAdapter {
  const fake = resolve(options.fakeAgentBin ?? DEFAULT_FAKE);
  const node = options.nodeBin ?? process.execPath;
  const script =
    options.fakeScript === undefined
      ? undefined
      : typeof options.fakeScript === "string"
        ? options.fakeScript
        : JSON.stringify(options.fakeScript);
  return {
    id: "fake",
    caps: {
      enforcesPermissions: "advisory",
      structuredOutputFlag: false,
      resumeSupportsMcp: true,
      reportsCost: false,
      usageIsCumulative: false,
      promptViaStdin: true,
      maxPromptArgBytes: 0,
    },
    evidence: {
      cliVersion: "0.1.0",
      argvSource: "synthetic",
      behaviorVerified: true,
      notes: [
        "explicit Relay fake, never live-CLI evidence",
        "checkpoint resume requires the same cwd; engine handles no-submit fallback",
      ],
    },
    plan: (req) => {
      const merged =
        script === undefined || Object.hasOwn(req.env, "FAKE_AGENT_SCRIPT")
          ? req.env
          : { ...req.env, FAKE_AGENT_SCRIPT: script };
      const cliOptions: Record<string, unknown> = { ...(req.cliOptions ?? {}) };
      cliOptions.checkpoint ??= ".relay/fake-checkpoint.json";
      return plan({ ...req, cliOptions, env: { ...merged, ...req.mcp.env } }, node, fake);
    },
    parser: (): StreamParser => new FakeParser(),
    classify: (exit: ExitInfo, _tail: Tail): FailureClass => classifyExit(exit),
    toolRef: (tool) => tool,
    probe: (ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult> =>
      probeVersion("fake", node, ctx, signal, [fake, "--help"]),
  };
}
