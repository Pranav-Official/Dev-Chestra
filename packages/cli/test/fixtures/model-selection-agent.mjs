#!/usr/bin/env node
// Test-only stand-in for `codex` and `claude`. It captures the actual argv that
// DevChestra invoked, then submits through the real MCP shim. No provider is called.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function fail(message) {
  process.stderr.write(`model-selection-stub: ${message}\n`);
  process.exit(2);
}

function captureDir() {
  const dir = process.env.DEVCHESTRA_TEST_CAPTURE_DIR;
  if (dir === undefined || dir === "") fail("DEVCHESTRA_TEST_CAPTURE_DIR missing");
  return dir;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function resolveShim() {
  const entry = process.env.DEVCHESTRA_MCP_SHIM_ENTRY;
  if (entry !== undefined && entry !== "") {
    return { command: process.execPath, args: [entry], env: { ...process.env } };
  }
  const index = process.argv.indexOf("--mcp-config");
  const configPath = index === -1 ? undefined : process.argv[index + 1];
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
  const client = new Client({ name: "model-selection", version: "0.1.0" });
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
  } catch (error) {
    fail(`MCP submit failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function emit(profile) {
  const session = `model-selection-${process.pid}`;
  if (profile === "claude-code") {
    process.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`,
    );
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

async function main() {
  const profile = process.env.DEVCHESTRA_TEST_PROFILE;
  if (profile !== "codex" && profile !== "claude-code") fail("DEVCHESTRA_TEST_PROFILE missing");
  const argv = process.argv.slice(2);
  const stdin = await readStdin();
  const dir = captureDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `agent-${profile}-${process.pid}.json`),
    JSON.stringify({
      profile,
      argv,
      cwd: process.cwd(),
      home: process.env.HOME ?? null,
      codexHome: process.env.CODEX_HOME ?? null,
      stdinBytes: Buffer.byteLength(stdin),
      modelArg: argv.includes("-m")
        ? argv[argv.indexOf("-m") + 1]
        : argv.includes("--model")
          ? argv[argv.indexOf("--model") + 1]
          : null,
    }),
    { mode: 0o600 },
  );
  await submit();
  emit(profile);
  process.exitCode = 0;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
