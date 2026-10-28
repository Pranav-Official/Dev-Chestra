#!/usr/bin/env node
import { redactToken } from "../gateway-client.js";
import { runShim } from "../shim.js";

runShim().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  const token = process.env.DEVCHESTRA_EXEC_TOKEN ?? "";
  process.stderr.write(`devchestra-mcp-shim: ${redactToken(message, token)}\n`);
  process.exitCode = 1;
});
