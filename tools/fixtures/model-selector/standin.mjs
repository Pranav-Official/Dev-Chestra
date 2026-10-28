#!/usr/bin/env node
// Test-only stand-in for the `codex` and `claude` executables.
// Codex mode speaks the documented app-server metadata RPC; exec mode captures
// argv/stdin and submits through the real DevChestra MCP shim. No provider is called.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

function parseArgs(argv) {
  let as = "";
  let control = HERE;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--as") {
      as = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--control") {
      control = argv[index + 1] ?? HERE;
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return { as, control, rest };
}

const { as, control, rest } = parseArgs(process.argv.slice(2));
const LOG = join(control, "standin-log.ndjson");
const CONTROL = join(control, "standin-control.json");

function log(entry) {
  try {
    appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), as, pid: process.pid, ...entry })}\n`);
  } catch {
    // Logging is evidence only; never fail the CLI because evidence failed.
  }
}

function readControl() {
  try {
    return JSON.parse(readFileSync(CONTROL, "utf8"));
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const DEFAULT_PAGES = [
  [
    {
      id: "raw-alpha",
      model: "exact-alpha",
      displayName: "Alpha Exact",
      description: "First deterministic catalog entry.",
      hidden: false,
      isDefault: true,
    },
    {
      id: "raw-beta",
      model: "Beta-Exact",
      displayName: "Beta Model",
      description: "Mixed-case identifier.",
      hidden: false,
    },
  ],
  [
    {
      id: "raw-gpt-terra",
      model: "gpt-6.1-terra",
      displayName: "Terra 6.1",
      description: "Punctuation and dotted version.",
      hidden: false,
    },
    {
      id: "raw-devchestra-punct",
      model: "devchestra-punct.model/v2",
      displayName: "Punctuation Model",
      description: "Subsequence friendly label.",
      hidden: false,
    },
  ],
  [
    {
      id: "raw-mini",
      model: "o4-mini",
      displayName: "Mini Four",
      description: "Short identifier.",
      hidden: false,
    },
    {
      id: "raw-id-vs-model",
      model: "exact-raw-model",
      displayName: "Raw Model Diff",
      description: "Raw id differs from the exact model value.",
      hidden: false,
    },
  ],
];

function pagesFor(controlValue) {
  if (Array.isArray(controlValue.pages) && controlValue.pages.length > 0) {
    return controlValue.pages;
  }
  if (typeof controlValue.pageCount === "number" && controlValue.pageCount > 0) {
    const pages = [];
    for (let page = 0; page < controlValue.pageCount; page += 1) {
      pages.push([
        {
          id: `raw-p${page}-a`,
          model: `paged-model-${page}-a`,
          displayName: `Paged ${page} A`,
          hidden: false,
        },
        {
          id: `raw-p${page}-b`,
          model: `paged-model-${page}-b`,
          displayName: `Paged ${page} B`,
          hidden: false,
        },
      ]);
    }
    return pages;
  }
  return DEFAULT_PAGES;
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function claudeSettings(controlValue) {
  const value = controlValue.claude;
  return typeof value === "object" && value !== null ? value : {};
}

function claudeNonce(controlValue) {
  const nonce = claudeSettings(controlValue).nonce;
  return typeof nonce === "string" && nonce !== "" ? nonce : "default";
}

function claudeModels(controlValue) {
  const nonce = claudeNonce(controlValue);
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

function claudeInitialize(controlValue) {
  const settings = claudeSettings(controlValue);
  const models = claudeModels(controlValue);
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: settings.fail === "malformed" ? "not-an-array" : models,
    account: { email: "qa@example.invalid", subscriptionType: "qa" },
    claude_code_version: "2.1.310",
  };
}

function controlReply(id, response) {
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    })}\n`,
  );
}

function controlReplyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: id, error: message },
    })}\n`,
  );
}

async function sdkMetadata() {
  const controlValue = readControl();
  const settings = claudeSettings(controlValue);
  const fail = typeof settings.fail === "string" ? settings.fail : "none";
  const delayMs = typeof settings.delayMs === "number" ? settings.delayMs : 0;
  log({
    kind: "spawn",
    mode: "sdk-discovery",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? null,
    nonce: claudeNonce(controlValue),
  });
  if (delayMs > 0) await sleep(delayMs);
  if (fail === "exit") {
    process.stderr.write("synthetic old Claude CLI failure\n");
    log({ kind: "exit", mode: "sdk-discovery", code: 3 });
    process.exit(3);
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
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
    if (fail === "hang") {
      log({ kind: "initialize-received-no-reply" });
      continue;
    }
    if (fail === "error" || fail === "authRequired" || fail === "methodNotFound") {
      controlReplyError(
        frame.request_id,
        fail === "authRequired"
          ? "authentication required"
          : fail === "methodNotFound"
            ? "model discovery is not supported"
            : "synthetic compatibility failure",
      );
      continue;
    }
    controlReply(frame.request_id, claudeInitialize(controlValue));
    log({ kind: "initialize-replied" });
  }
  log({ kind: "exit", mode: "sdk-discovery", code: 0 });
}

// Static catalog for `opencode models` and `pi --list-models`.
// No session, inference or provider call; stdout is the whole catalog.
async function staticModels() {
  log({
    kind: "spawn",
    mode: "list-models",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
  });
  if (rest.includes("--version")) {
    process.stdout.write(as === "pi" ? "pi-standin 1.2.3-test\n" : "opencode-standin 0.0.0-test\n");
    log({ kind: "exit", mode: "version", code: 0 });
    return;
  }
  if (as === "opencode") {
    process.stdout.write("testprovider/opencode-exact-a\ntestprovider/opencode-exact-b\n");
  } else {
    process.stdout.write(
      "PROVIDER      MODEL\ntestprovider  pi-exact-a\ntestprovider  pi-exact-b\n",
    );
  }
  log({ kind: "exit", mode: "list-models", code: 0 });
}

const isSdkMetadata =
  as === "claude" &&
  rest.includes("--input-format") &&
  rest[rest.indexOf("--input-format") + 1] === "stream-json";

async function appServer() {
  log({
    kind: "spawn",
    mode: "app-server",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
  });
  const controlValue = readControl();
  const delayMs = typeof controlValue.delayMs === "number" ? controlValue.delayMs : 0;
  const fail = typeof controlValue.fail === "string" ? controlValue.fail : "none";
  const pages = pagesFor(controlValue);
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log({ kind: "invalid-json", line: line.slice(0, 200) });
      continue;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id ?? null;
    log({ kind: "rpc", method, params: message.params ?? null });
    if (method === "initialize") {
      if (fail === "authRequired") {
        respondError(id, -32000, "authentication required");
        continue;
      }
      if (fail === "exit1") process.exit(1);
      respond(id, {
        userAgent: "codex-standin/0.0.0",
        codexHome: process.env.CODEX_HOME ?? null,
        platformFamily: "unix",
        platformOs: "linux",
      });
      continue;
    }
    if (method === "initialized") continue;
    if (method === "model/list") {
      if (delayMs > 0) await sleep(delayMs);
      if (fail === "methodNotFound") {
        respondError(id, -32601, "method not found");
        continue;
      }
      if (fail === "malformed") {
        process.stdout.write("this is not json\n");
        continue;
      }
      if (fail === "oversize") {
        process.stdout.write(`${"x".repeat(2 * 1024 * 1024)}\n`);
        continue;
      }
      if (fail === "exit1") process.exit(1);
      const rawCursor = message.params?.cursor;
      const index = typeof rawCursor === "string" ? Number(rawCursor) : 0;
      const page = pages[Number.isSafeInteger(index) ? index : 0] ?? [];
      const next = index + 1 < pages.length ? String(index + 1) : null;
      respond(id, { data: page, nextCursor: next });
      continue;
    }
    respondError(id, -32601, "method not found");
  }
  log({ kind: "exit", mode: "app-server", code: 0 });
}

function resolveShim() {
  const entry = process.env.DEVCHESTRA_MCP_SHIM_ENTRY;
  if (entry !== undefined && entry !== "") {
    return { command: process.execPath, args: [entry], env: { ...process.env } };
  }
  const index = rest.indexOf("--mcp-config");
  const configPath = index === -1 ? undefined : rest[index + 1];
  if (configPath === undefined) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  const server = config?.mcpServers?.devchestra;
  if (typeof server?.command !== "string" || !Array.isArray(server.args)) return null;
  return {
    command: server.command,
    args: server.args,
    env: { ...process.env, ...(server.env ?? {}) },
  };
}

async function submit() {
  const shim = resolveShim();
  if (shim === null) throw new Error("MCP shim configuration missing");
  const requireFromFakeAgent = createRequire(join(REPO_ROOT, "tools/fake-agent/package.json"));
  const { Client } = requireFromFakeAgent("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = requireFromFakeAgent(
    "@modelcontextprotocol/sdk/client/stdio.js",
  );
  const client = new Client({ name: "model-selector-standin", version: "0.1.0" });
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
    if (result.isError === true) throw new Error("submit_result was rejected");
  } finally {
    await client.close().catch(() => undefined);
  }
}

function emit(profile) {
  const session = `standin-${process.pid}`;
  if (profile === "claude-code") {
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`);
    process.stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "submitted" }] } })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", session_id: session, result: "submitted", is_error: false })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: session })}\n`);
  process.stdout.write(
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "submitted" } })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
  );
}

async function execAgent() {
  if (rest.includes("--version") || rest.includes("-V")) {
    log({ kind: "spawn", mode: "version", argv: rest, cwd: process.cwd() });
    process.stdout.write("0.0.0-standin\n");
    log({ kind: "exit", mode: "version", code: 0 });
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const stdin = Buffer.concat(chunks).toString("utf8");
  const modelIndex = rest.indexOf("-m");
  const claudeModelIndex = rest.indexOf("--model");
  log({
    kind: "spawn",
    mode: "exec",
    argv: rest,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? null,
    stdinBytes: Buffer.byteLength(stdin),
    stdin,
    forbiddenFrame: /"type"\s*:\s*"(?:user|prompt|turn|tool_call|login|config)"/u.test(stdin),
    model:
      modelIndex === -1
        ? claudeModelIndex === -1
          ? null
          : rest[claudeModelIndex + 1]
        : rest[modelIndex + 1],
  });
  await submit();
  emit(as === "claude" ? "claude-code" : "codex");
  log({ kind: "exit", mode: "exec", code: 0 });
}

if (as !== "codex" && as !== "claude" && as !== "opencode" && as !== "pi") {
  process.stderr.write(`standin: unknown --as ${as}\n`);
  process.exit(2);
} else if (as === "opencode" || as === "pi") {
  staticModels().catch((error) => {
    process.stderr.write(`standin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else if (isSdkMetadata) {
  sdkMetadata().catch((error) => {
    process.stderr.write(`standin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else if (as === "codex" && rest[0] === "app-server") {
  appServer().catch((error) => {
    process.stderr.write(`standin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  execAgent().catch((error) => {
    process.stderr.write(`standin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
