#!/usr/bin/env node
// Hermetic opencode stand-in for adapter tests. Handles --version,
// models [--verbose] and run --format json from STUB_SCENARIO.
// Never touches the network, global config, or the session database.
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

const argv = process.argv.slice(2);
log({
  t: "spawn",
  pid: process.pid,
  argv,
  env: {
    HOME: process.env.HOME ?? null,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,
    UNRELATED_SECRET: process.env.UNRELATED_SECRET ?? null,
    STUB_SCENARIO: process.env.STUB_SCENARIO ?? null,
  },
});

if (scenario.exitImmediately === true) process.exit(2);
if (typeof scenario.stderr === "string" && scenario.stderr !== "") {
  process.stderr.write(scenario.stderr);
}

const [command, ...rest] = argv;
if (command === "--version") {
  process.stdout.write(`${scenario.version ?? "1.19.4"}\n`);
  process.exit(scenario.exitCode ?? 0);
}
if (command === "models") {
  const verbose = rest.includes("--verbose");
  // No magic default output: error-path scenarios stay empty.
  const lines = verbose ? (scenario.verbose ?? []) : (scenario.models ?? []);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exit(scenario.exitCode ?? 0);
}
if (command === "run") {
  const events = scenario.events ?? [
    '{"type":"step_start","timestamp":1,"sessionID":"ses_standin0000000000000001","part":{"id":"prt_1","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"ses_standin0000000000000001","part":{"id":"prt_2","type":"text","text":"ok"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"ses_standin0000000000000001","part":{"id":"prt_3","type":"step-finish","reason":"stop","cost":0,"tokens":{"input":10,"output":2}}}',
  ];
  for (const event of events) process.stdout.write(`${event}\n`);
  process.exit(scenario.exitCode ?? 0);
}
process.stderr.write(`standin: unknown command ${command ?? ""}\n`);
process.exit(scenario.exitCode ?? 2);
