#!/usr/bin/env node
// Standin for the pi CLI: answers --version and --list-models from
// STUB_SCENARIO_JSON, logs spawns to STUB_LOG. Never touches the network.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.STUB_LOG !== undefined && process.env.STUB_LOG !== "") {
  appendFileSync(
    process.env.STUB_LOG,
    `${JSON.stringify({
      t: "spawn",
      argv: args,
      env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null },
    })}\n`,
  );
}

let scenario = {};
try {
  scenario = JSON.parse(process.env.STUB_SCENARIO_JSON ?? "{}");
} catch {
  process.exit(2);
}

if (scenario.delayMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
}

if (args.includes("--version")) {
  process.stdout.write(scenario.version ?? "pi 1.4.0\n");
  process.exit(0);
}

if (args.includes("--list-models")) {
  if (typeof scenario.stderr === "string") process.stderr.write(scenario.stderr);
  process.stdout.write(
    scenario.table ??
      "provider     model                 context  max-out  thinking  images\nopencode-go  kimi-k3               1.0M     131.1K   yes       yes   \n",
  );
  process.exit(scenario.exitCode ?? 0);
}

process.stderr.write("stub: unexpected argv\n");
process.exit(2);
