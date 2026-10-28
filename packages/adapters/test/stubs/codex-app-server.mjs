#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const scenarioPath = process.env.STUB_SCENARIO;
const logPath = process.env.STUB_LOG;

function log(entry) {
  if (logPath === undefined || logPath === "") return;
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

let scenario = {};
try {
  scenario = scenarioPath === undefined ? {} : JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch {
  scenario = { exitImmediately: true };
}

log({
  t: "spawn",
  pid: process.pid,
  argv: process.argv.slice(2),
  env: {
    HOME: process.env.HOME ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    UNRELATED_SECRET: process.env.UNRELATED_SECRET ?? null,
    DEVCHESTRA_LEAK_SENTINEL: process.env.DEVCHESTRA_LEAK_SENTINEL ?? null,
    STUB_SCENARIO: process.env.STUB_SCENARIO ?? null,
  },
});

if (scenario.exitImmediately === true) process.exit(2);

if (scenario.descendant === true) {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    {
      stdio: "ignore",
    },
  );
  log({ t: "descendant", pid: child.pid ?? null });
  child.unref();
}

if (typeof scenario.stderr === "string" && scenario.stderr !== "") {
  process.stderr.write(scenario.stderr);
}
if (typeof scenario.stdoutOversize === "number" && scenario.stdoutOversize > 0) {
  process.stdout.write(`${"x".repeat(scenario.stdoutOversize)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log({ t: "bad-client-json" });
        index = buffer.indexOf("\n");
        continue;
      }
      log({
        t: "recv",
        method: message.method ?? null,
        id: message.id ?? null,
        params: message.params ?? null,
      });
      handle(message);
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  log({ t: "stdin-end" });
  setTimeout(() => process.exit(0), 50);
});

function send(message) {
  if (scenario.fragmentUtf8 === true) {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    let split = -1;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] >= 0xc0) {
        split = i + 1;
        break;
      }
    }
    if (split > 0 && split < line.length) {
      process.stdout.write(line.subarray(0, split));
      setTimeout(() => process.stdout.write(line.subarray(split)), 5);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function later(fn) {
  const delay = typeof scenario.delayMs === "number" ? scenario.delayMs : 0;
  if (delay > 0) setTimeout(fn, delay);
  else fn();
}

function handle(message) {
  if (message.method === "initialize") {
    if (scenario.exitDuringInit === true) {
      process.exit(0);
    }
    if (scenario.initError !== undefined) {
      later(() => send({ jsonrpc: "2.0", id: message.id, error: scenario.initError }));
      return;
    }
    if (scenario.malformed === "initialize") {
      later(() => send({ jsonrpc: "2.0", id: message.id, result: "not-an-object" }));
      return;
    }
    const result = scenario.initResult ?? { userAgent: scenario.version ?? "codex-cli/9.9.9" };
    later(() => {
      send({ jsonrpc: "2.0", id: message.id, result });
      if (scenario.serverRequest === true) {
        send({ jsonrpc: "2.0", id: 99, method: "account/login/start", params: {} });
      }
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method !== "model/list") return;

  if (scenario.noResponse === true) {
    const count = typeof scenario.notifications === "number" ? scenario.notifications : 0;
    const delay =
      typeof scenario.notificationDelayMs === "number" ? scenario.notificationDelayMs : 50;
    let sent = 0;
    const timer = setInterval(() => {
      send({ jsonrpc: "2.0", method: "account/updated", params: { n: sent } });
      sent += 1;
      if (sent >= count) clearInterval(timer);
    }, delay);
    return;
  }
  if (scenario.listError !== undefined) {
    later(() => send({ jsonrpc: "2.0", id: message.id, error: scenario.listError }));
    return;
  }
  if (scenario.malformed === "page") {
    later(() => send({ jsonrpc: "2.0", id: message.id, result: { data: "not-an-array" } }));
    return;
  }
  if (scenario.malformed === "json") {
    later(() => process.stdout.write("{not-json\n"));
    return;
  }

  const cursor = message.params?.cursor;
  const index = cursor === undefined ? 0 : Number(String(cursor).replace(/\D/g, ""));
  const page = scenario.pages?.[index] ?? { data: [], nextCursor: null };
  later(() => {
    send({ jsonrpc: "2.0", id: message.id, result: page });
    if (page.nextCursor === null && scenario.exitAfterLastPage === true) {
      setTimeout(() => process.exit(0), 10);
    }
  });
}
