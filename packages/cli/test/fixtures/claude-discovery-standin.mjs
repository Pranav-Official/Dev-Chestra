#!/usr/bin/env node
// Test-only trusted `claude` stand-in for Claude model discovery acceptance.
//
// It is spawned by the REAL published @anthropic-ai/claude-agent-sdk through
// pathToClaudeCodeExecutable. In SDK metadata mode it captures every stdin
// frame and fails closed (non-zero) on anything except one initialize
// control_request; it never calls a provider. In workflow mode it captures the
// real Claude invocation, submits through the real DevChestra MCP shim and emits
// ordinary stream-json output. No user auth, config or provider is touched.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function fail(message, code = 2) {
  process.stderr.write(`claude-discovery-standin: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  let qaDir = process.env.CLAUDE_CODE_QA_DIR ?? "";
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--qa-dir") {
      qaDir = argv[index + 1] ?? "";
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  if (qaDir === "") fail("--qa-dir (or CLAUDE_CODE_QA_DIR) is required");
  return { qaDir, rest };
}

const { qaDir, rest } = parseArgs(process.argv.slice(2));
const EVENTS = join(qaDir, "events.ndjson");
const CONTROL = join(qaDir, "control.json");

function log(entry) {
  try {
    mkdirSync(qaDir, { recursive: true, mode: 0o700 });
    appendFileSync(
      EVENTS,
      `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`,
    );
  } catch {
    // Evidence only; never fail the CLI because evidence could not be written.
  }
}

function control() {
  try {
    return JSON.parse(readFileSync(CONTROL, "utf8"));
  } catch {
    return {};
  }
}

function argValue(name) {
  const index = rest.indexOf(name);
  return index === -1 ? null : (rest[index + 1] ?? null);
}

function modelArg() {
  return argValue("--model") ?? argValue("-m");
}

function version() {
  return "2.1.310";
}

function nonceOf(value) {
  const raw = value?.nonce;
  return typeof raw === "string" && raw !== "" ? raw : "default";
}

function modelsFor(nonce) {
  return [
    {
      value: `claude-qa-${nonce}`,
      resolvedModel: `resolved-${nonce}`,
      displayName: `QA Claude ${nonce}`,
      description: `Dynamic metadata row ${nonce}`,
    },
    {
      value: `claude-qa-${nonce}-punctuation.v2`,
      displayName: `QA Punct ${nonce}`,
      description: "Punctuation and dotted suffix",
    },
    {
      value: `claude-qa-${nonce}-unicode-é`,
      displayName: `QA Unicode ${nonce}`,
      description: "Unicode identifier",
    },
  ];
}

function initialization(value) {
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: modelsFor(nonceOf(value)),
    account: { email: "qa@example.invalid", subscriptionType: "qa" },
    claude_code_version: version(),
  };
}

function reply(id, response) {
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    })}\n`,
  );
}

function replyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: id, error: message },
    })}\n`,
  );
}

async function sdkMetadata() {
  const value = control();
  const mode = typeof value.mode === "string" ? value.mode : "ok";
  log({
    kind: "spawn",
    mode: "sdk-discovery",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    sdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION ?? null,
    nonce: nonceOf(value),
  });
  if (mode === "exit") {
    process.stderr.write("synthetic old CLI failure\n");
    log({ kind: "exit", mode: "sdk-discovery", code: 3 });
    process.exit(3);
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log({ kind: "protocol-violation", reason: "non-json stdin", line: line.slice(0, 200) });
      process.exit(43);
    }
    log({ kind: "stdin-frame", frame });
    if (frame.type === "user" || frame.type === "prompt" || frame.type === "turn") {
      log({ kind: "protocol-violation", reason: `forbidden frame ${String(frame.type)}`, frame });
      process.exit(44);
    }
    if (frame.type !== "control_request" || frame.request?.subtype !== "initialize") {
      log({
        kind: "protocol-violation",
        reason: `unexpected frame ${String(frame.type)}/${String(frame.request?.subtype)}`,
        frame,
      });
      process.exit(45);
    }
    if (initialized) {
      log({ kind: "protocol-violation", reason: "duplicate initialize", frame });
      process.exit(46);
    }
    initialized = true;
    if (mode === "hang") {
      log({ kind: "initialize-received-no-reply" });
      continue;
    }
    if (mode === "error" || mode === "authRequired") {
      replyError(
        frame.request_id,
        mode === "authRequired" ? "authentication required" : "synthetic compatibility failure",
      );
      continue;
    }
    const init = initialization(value);
    if (mode === "malformed") init.models = "not-an-array";
    reply(frame.request_id, init);
    log({ kind: "initialize-replied", modelCount: Array.isArray(init.models) ? init.models.length : 0 });
  }
  log({ kind: "stdin-closed", mode: "sdk-discovery" });
  log({ kind: "exit", mode: "sdk-discovery", code: 0 });
  process.exit(0);
}

function resolveShim() {
  const entry = process.env.DEVCHESTRA_MCP_SHIM_ENTRY;
  if (entry !== undefined && entry !== "") {
    return { command: process.execPath, args: [entry], env: { ...process.env } };
  }
  const index = rest.indexOf("--mcp-config");
  const configPath = index === -1 ? undefined : rest[index + 1];
  if (configPath === undefined) fail("MCP shim configuration missing");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    fail("MCP config is not readable JSON");
  }
  const server = config?.mcpServers?.devchestra;
  if (
    typeof server?.command !== "string" ||
    !Array.isArray(server.args) ||
    server.args.some((arg) => typeof arg !== "string")
  ) {
    fail("MCP config devchestra server is invalid");
  }
  return {
    command: server.command,
    args: server.args,
    env: { ...process.env, ...(server.env ?? {}) },
  };
}

async function submit() {
  const requireFromFakeAgent = createRequire(join(REPO_ROOT, "tools/fake-agent/package.json"));
  const { Client } = requireFromFakeAgent("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = requireFromFakeAgent(
    "@modelcontextprotocol/sdk/client/stdio.js",
  );
  const shim = resolveShim();
  const client = new Client({ name: "claude-discovery-standin", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: shim.command,
    args: shim.args,
    cwd: process.cwd(),
    env: shim.env,
    stderr: "ignore",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "submit_result", arguments: { ok: true } });
    if (result.isError === true) fail("submit_result was rejected");
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function executeWorkflow() {
  if (rest.includes("--version") || rest.includes("-V")) {
    log({ kind: "spawn", mode: "version", argv: rest, cwd: process.cwd() });
    process.stdout.write(`${version()}\n`);
    log({ kind: "exit", mode: "version", code: 0 });
    process.exit(0);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const stdin = Buffer.concat(chunks).toString("utf8");
  const forbiddenFrame = /"type"\s*:\s*"(?:user|prompt|turn|tool_call|login|config)"/u.test(stdin);
  log({
    kind: "spawn",
    mode: "exec",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    model: modelArg(),
    stdin,
    stdinBytes: Buffer.byteLength(stdin),
    forbiddenFrame,
  });
  if (forbiddenFrame) fail("discovery/protocol frame reached the workflow process", 47);
  await submit();
  const session = `claude-discovery-${process.pid}`;
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`);
  process.stdout.write(
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "submitted" }] } })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", session_id: session, result: "submitted", is_error: false })}\n`,
  );
  log({ kind: "exit", mode: "exec", code: 0 });
}

const sdkMode =
  rest.includes("--input-format") && rest[rest.indexOf("--input-format") + 1] === "stream-json";

if (sdkMode) {
  sdkMetadata().catch((error) => {
    fail(error instanceof Error ? error.message : String(error), 48);
  });
} else {
  executeWorkflow().catch((error) => {
    fail(error instanceof Error ? error.message : String(error), 49);
  });
}
