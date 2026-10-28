#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { resolveSubmitFromInputs } from "./input.js";
import { parseFakeScript } from "./script.js";
import type { FakeCheckpoint, FakeStep } from "./types.js";

const PROFILE = "fake";
const VERSION = "0.1.0";

interface ParsedArgs {
  prompt: string | undefined;
  promptFile: string | undefined;
  cwd: string | undefined;
  script: string | undefined;
  scriptFile: string | undefined;
  checkpoint: string | undefined;
  session: string | undefined;
  format: string;
  resume: boolean;
  help: boolean;
  positional: string | undefined;
}

interface EmitContext {
  sessionId: string;
  cwd: string;
}

interface ShimLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const HELP = `relay-fake-agent — scriptable fake agent for Relay

Usage:
  relay-fake-agent --prompt <text> --cwd <dir> [--script <json|file>]
                   [--checkpoint <file>] [--resume] [--session <id>]

Environment:
  RELAY_MCP_SHIM_ENTRY   required; packages/mcp/dist/bin/shim.js (or src/bin/shim.ts)
  RELAY_EXEC_TOKEN       required for the shim
  RELAY_GATEWAY_URL      required for the shim
  RELAY_TOOLSET          required for the shim (agent|supervisor)
  FAKE_AGENT_SCRIPT      JSON step array when --script is omitted
  FAKE_AGENT_CHECKPOINT  checkpoint path when --checkpoint is omitted

Steps:
  {"type":"say","text":"..."}
  {"type":"tool","name":"...","args":{...}}
  {"type":"submit","output":{...}}
  {"type":"submit-from-inputs","path":["agent"],"fallback":{...}}
  {"type":"sleep","ms":100}
  {"type":"crash","code":9}

This is an explicit fake profile. It does not imitate Claude, Codex, OpenCode or Pi streams.
`;

function takeValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const current = argv[index] ?? "";
  const equals = current.indexOf("=");
  if (equals !== -1) {
    return { value: current.slice(equals + 1), next: index + 1 };
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${name} requires a value.`);
  }
  return { value, next: index + 2 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    prompt: undefined,
    promptFile: undefined,
    cwd: undefined,
    script: undefined,
    scriptFile: undefined,
    checkpoint: undefined,
    session: undefined,
    format: "relay-fake",
    resume: false,
    help: false,
    positional: undefined,
  };

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] ?? "";
    const equalsIndex = arg.indexOf("=");
    const option = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    switch (option) {
      case "--help":
      case "-h":
        parsed.help = true;
        index += 1;
        break;
      case "--resume":
        parsed.resume = true;
        index += 1;
        break;
      case "--prompt":
      case "--prompt-file":
      case "--cwd":
      case "--script":
      case "--script-file":
      case "--checkpoint":
      case "--session":
      case "--format": {
        const { value, next } = takeValue(argv, index, option);
        switch (option) {
          case "--prompt":
            parsed.prompt = value;
            break;
          case "--prompt-file":
            parsed.promptFile = value;
            break;
          case "--cwd":
            parsed.cwd = value;
            break;
          case "--script":
            parsed.script = value;
            break;
          case "--script-file":
            parsed.scriptFile = value;
            break;
          case "--checkpoint":
            parsed.checkpoint = value;
            break;
          case "--session":
            parsed.session = value;
            break;
          case "--format":
            parsed.format = value;
            break;
          default:
            break;
        }
        index = next;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (parsed.positional !== undefined) {
          throw new Error("Only one positional prompt is supported.");
        }
        parsed.positional = arg;
        index += 1;
        break;
    }
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolvePrompt(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<string> {
  if (parsed.prompt !== undefined) {
    return parsed.prompt;
  }
  if (parsed.positional !== undefined) {
    return parsed.positional;
  }
  if (parsed.promptFile !== undefined) {
    return readFile(resolve(process.cwd(), parsed.promptFile), "utf8");
  }
  if (env.FAKE_AGENT_PROMPT !== undefined) {
    return env.FAKE_AGENT_PROMPT;
  }
  if (!process.stdin.isTTY) {
    return readStdin();
  }
  return "";
}

async function resolveScript(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<FakeStep[]> {
  const inline = parsed.script;
  if (inline !== undefined) {
    const trimmed = inline.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      return parseFakeScript(trimmed);
    }
    return parseFakeScript(await readFile(resolve(process.cwd(), inline), "utf8"));
  }
  if (parsed.scriptFile !== undefined) {
    return parseFakeScript(await readFile(resolve(process.cwd(), parsed.scriptFile), "utf8"));
  }
  const fromEnv = env.FAKE_AGENT_SCRIPT;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return parseFakeScript(fromEnv);
  }
  return [];
}

function toChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function shimLaunch(cwd: string, env: NodeJS.ProcessEnv): Promise<ShimLaunch> {
  const entry = env.RELAY_MCP_SHIM_ENTRY;
  if (entry === undefined || entry === "") {
    throw new Error(
      "RELAY_MCP_SHIM_ENTRY is required (path to the built shim or its TypeScript source).",
    );
  }
  const absolute = resolve(process.cwd(), entry);
  await stat(absolute).catch(() => {
    throw new Error(`RELAY_MCP_SHIM_ENTRY does not exist: ${absolute}`);
  });
  const isTypeScript =
    absolute.endsWith(".ts") || absolute.endsWith(".mts") || absolute.endsWith(".cts");
  const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
  const args = isTypeScript ? ["--import", tsxLoader, absolute] : [absolute];

  if (env.RELAY_EXEC_TOKEN === undefined || env.RELAY_EXEC_TOKEN === "") {
    throw new Error("RELAY_EXEC_TOKEN is required.");
  }
  if (env.RELAY_GATEWAY_URL === undefined || env.RELAY_GATEWAY_URL === "") {
    throw new Error("RELAY_GATEWAY_URL is required.");
  }
  if (env.RELAY_TOOLSET !== "agent" && env.RELAY_TOOLSET !== "supervisor") {
    throw new Error('RELAY_TOOLSET must be "agent" or "supervisor".');
  }

  return {
    command: process.execPath,
    args,
    cwd,
    env: toChildEnv(env),
  };
}

function redact(text: string, token: string | undefined): string {
  if (token === undefined || token === "") {
    return text;
  }
  return text.split(token).join("[REDACTED]");
}

function contentText(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      texts.push((item as { text: string }).text);
    }
  }
  return texts.join("\n");
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

async function emit(
  context: EmitContext,
  event: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const line = `${JSON.stringify({
    type: "relay-fake",
    event,
    profile: PROFILE,
    sessionId: context.sessionId,
    cwd: context.cwd,
    ...data,
  })}\n`;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error) => {
      if (error) {
        rejectWrite(error);
      } else {
        resolveWrite();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export async function runFakeAgent(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.format !== "relay-fake" && parsed.format !== "fake") {
    throw new Error('Only the explicit "relay-fake" profile is supported.');
  }
  if (env.FAKE_AGENT_PROFILE !== undefined && env.FAKE_AGENT_PROFILE !== PROFILE) {
    throw new Error('FAKE_AGENT_PROFILE must be "fake" for this executable.');
  }

  const cwd = await realpath(resolve(parsed.cwd ?? process.cwd())).catch(() => {
    throw new Error("Working directory does not exist.");
  });
  const prompt = await resolvePrompt(parsed, env);
  const script = await resolveScript(parsed, env);
  const checkpointPathRaw = parsed.checkpoint ?? env.FAKE_AGENT_CHECKPOINT;
  const checkpointPath =
    checkpointPathRaw === undefined || checkpointPathRaw === ""
      ? undefined
      : resolve(process.cwd(), checkpointPathRaw);

  let resumed = false;
  let startIndex = 0;
  let checkpoint: FakeCheckpoint | undefined;
  if (parsed.resume) {
    if (checkpointPath === undefined) {
      process.stderr.write("relay-fake-agent: --resume without a checkpoint; starting fresh.\n");
    } else {
      checkpoint = await readCheckpoint(checkpointPath);
      if (checkpoint === undefined) {
        process.stderr.write("relay-fake-agent: checkpoint not found; starting fresh.\n");
      } else {
        if (checkpoint.cwd !== cwd) {
          throw new Error(
            `Resume checkpoint cwd ${checkpoint.cwd} does not match --cwd ${cwd}; resume from the same working directory.`,
          );
        }
        if (parsed.session !== undefined && parsed.session !== checkpoint.sessionId) {
          throw new Error("--session conflicts with the session id in the checkpoint.");
        }
        resumed = true;
        startIndex = checkpoint.nextStepIndex;
      }
    }
  }

  const sessionId =
    checkpoint?.sessionId ?? parsed.session ?? env.FAKE_AGENT_SESSION_ID ?? `fake-${randomUUID()}`;
  const context: EmitContext = { sessionId, cwd };
  let submitted = checkpoint?.submitted ?? false;

  await emit(context, "session", {
    resumed,
    pid: process.pid,
    nextStepIndex: startIndex,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
  });

  const launch = await shimLaunch(cwd, env);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    stderr: "inherit",
  });
  const client = new Client({ name: "relay-fake-agent", version: VERSION });

  const persist = async (nextStepIndex: number): Promise<void> => {
    if (checkpointPath === undefined) {
      return;
    }
    const next: FakeCheckpoint = {
      version: 1,
      profile: "fake",
      sessionId,
      cwd,
      nextStepIndex,
      submitted,
    };
    await writeCheckpoint(checkpointPath, next);
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    await emit(context, "tools", {
      names: tools.tools.map((tool) => tool.name),
      count: tools.tools.length,
    });

    for (let index = startIndex; index < script.length; index += 1) {
      const step = script[index];
      if (step === undefined) {
        break;
      }
      switch (step.type) {
        case "say": {
          await emit(context, "say", { index, text: step.text });
          break;
        }
        case "tool":
        case "submit": {
          const name = step.type === "submit" ? "submit_result" : step.name;
          const args = step.type === "submit" ? step.output : step.args;
          const result = await client.callTool({ name, arguments: args });
          const isError = isErrorResult(result);
          const text = redact(contentText(result), env.RELAY_EXEC_TOKEN);
          if (name === "submit_result" && !isError) {
            submitted = true;
          }
          if (step.type === "submit") {
            await emit(context, "submit_result", {
              index,
              accepted: !isError,
              isError,
              text,
            });
          } else {
            await emit(context, "tool_result", {
              index,
              name,
              isError,
              text,
            });
          }
          break;
        }
        case "submit-from-inputs": {
          const args = resolveSubmitFromInputs(prompt, step.path, step.fallback);
          const result = await client.callTool({ name: "submit_result", arguments: args });
          const isError = isErrorResult(result);
          const text = redact(contentText(result), env.RELAY_EXEC_TOKEN);
          if (!isError) {
            submitted = true;
          }
          await emit(context, "submit_result", {
            index,
            accepted: !isError,
            isError,
            text,
          });
          break;
        }
        case "sleep": {
          await sleep(step.ms);
          await emit(context, "sleep", { index, ms: step.ms });
          break;
        }
        case "crash": {
          await persist(index);
          await emit(context, "crash", { index, code: step.code });
          process.exit(step.code);
        }
      }
      await persist(index + 1);
    }

    await emit(context, "end", {
      submitted,
      nextStepIndex: script.length,
      steps: script.length,
    });
    await client.close();
    return 0;
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : "unknown fake agent error",
      env.RELAY_EXEC_TOKEN,
    );
    try {
      await emit(context, "error", { message });
    } catch {
      // stdout may already be closed; stderr below is the fallback.
    }
    process.stderr.write(`relay-fake-agent: ${message}\n`);
    try {
      await client.close();
    } catch {
      // Ignore close failures after a transport error.
    }
    return 3;
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runFakeAgent(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown startup error";
      const token = process.env.RELAY_EXEC_TOKEN;
      process.stderr.write(`relay-fake-agent: ${redact(message, token)}\n`);
      process.exitCode = 1;
    },
  );
}
