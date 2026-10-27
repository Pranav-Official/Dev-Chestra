import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const scenarioPath = process.env.STUB_SCENARIO;
const logPath = process.env.STUB_LOG;
if (scenarioPath === undefined || logPath === undefined) {
  process.stderr.write("STUB_SCENARIO and STUB_LOG are required\n");
  process.exit(2);
}

const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

log({
  t: "start",
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    HOME: process.env.HOME ?? null,
    PATH: process.env.PATH ?? null,
    UNRELATED_SECRET: process.env.UNRELATED_SECRET ?? null,
    RELAY_LEAK_SENTINEL: process.env.RELAY_LEAK_SENTINEL ?? null,
    STUB_SCENARIO: process.env.STUB_SCENARIO ?? null,
    STUB_LOG: process.env.STUB_LOG ?? null,
  },
});

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function models() {
  if ("models" in scenario) return scenario.models;
  return [
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Synthetic alias row",
    },
    {
      value: "claude-explicit-1",
      displayName: "Explicit model",
      description: "Synthetic explicit row",
    },
  ];
}

function initialization() {
  const init = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    account: { email: "stub@example.invalid", subscriptionType: "stub" },
  };
  if (scenario.noVersion !== true) {
    init.claude_code_version = typeof scenario.version === "string" ? scenario.version : "2.1.296";
  }
  if (scenario.noModels !== true) init.models = models();
  return init;
}

function violation(reason, frame) {
  log({ t: "violation", reason, frame });
  process.exit(reason === "type:user" ? 43 : 44);
}

const responseFor = (frame) => ({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: frame.request_id,
    response: initialization(),
  },
});

function onInitialize(frame) {
  const mode = typeof scenario.mode === "string" ? scenario.mode : "ok";
  if (mode === "noReply") return;
  if (mode === "exit") {
    process.stderr.write("synthetic old CLI failure\n");
    process.exit(3);
  }
  if (mode === "error") {
    reply({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: frame.request_id,
        error: typeof scenario.error === "string" ? scenario.error : "synthetic failure",
      },
    });
    return;
  }
  if (mode === "canUseTool") {
    process.stdout.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: "tool-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "true" } },
      })}\n`,
    );
    setTimeout(() => reply(responseFor(frame)), 100);
    return;
  }
  if (mode === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    log({ t: "descendant", pid: child.pid ?? null });
    return;
  }
  if (mode === "oversizeStdout") {
    process.stdout.write("x".repeat(scenario.bytes ?? 2 * 1024 * 1024));
    return;
  }
  if (mode === "oversizeStderr") {
    process.stderr.write("s".repeat(scenario.bytes ?? 128 * 1024));
    return;
  }
  if (mode === "lateReply") {
    setTimeout(() => reply(responseFor(frame)), scenario.delayMs ?? 500);
    return;
  }

  reply(responseFor(frame));
  if (mode === "exitAfterReply") setTimeout(() => process.exit(0), 100);
}

function isWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function takeFrame(buffer) {
  let start = 0;
  while (start < buffer.length && isWhitespace(buffer[start])) start += 1;
  if (start >= buffer.length) return null;
  if (buffer[start] !== "{") return { invalid: true };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (end < buffer.length && isWhitespace(buffer[end])) end += 1;
        return { json: buffer.slice(start, index + 1), rest: buffer.slice(end) };
      }
    }
  }
  return null;
}

let buffer = "";
let initialized = false;

function handleFrame(frame) {
  log({ t: "recv", frame });
  if (frame.type === "user") violation("type:user", frame);
  if (frame.type !== "control_request") violation(`unexpected ${String(frame.type)}`, frame);
  if (frame.request?.subtype !== "initialize") {
    violation(`control:${String(frame.request?.subtype)}`, frame);
  }
  if (initialized) violation("duplicate initialize", frame);
  initialized = true;
  onInitialize(frame);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (buffer.length > 2 * 1024 * 1024) violation("stdin oversize", null);
  for (;;) {
    const taken = takeFrame(buffer);
    if (taken === null) break;
    if (taken.invalid === true) violation("non-json stdin", null);
    buffer = taken.rest;
    let frame;
    try {
      frame = JSON.parse(taken.json);
    } catch {
      violation("non-json stdin", null);
    }
    handleFrame(frame);
  }
});

process.stdin.on("end", () => {
  log({ t: "stdin_closed" });
  process.exit(0);
});

process.on("SIGTERM", () => {
  log({ t: "sigterm" });
  process.exit(0);
});
