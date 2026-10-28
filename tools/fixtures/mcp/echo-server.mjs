#!/usr/bin/env node
// Minimal stdio MCP server for tests. Tool: fixture_echo { text } -> text.
// If FIXTURE_MCP_LOG is set, appends "start <name>" on launch and "call <name>" per tool call,
// so tests can prove whether a server was started or used.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const name = process.env.FIXTURE_MCP_NAME ?? "fixture";
const log = (line) => {
  if (process.env.FIXTURE_MCP_LOG) appendFileSync(process.env.FIXTURE_MCP_LOG, `${line}\n`);
};
log(`start ${name}`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name, version: "0.0.1" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "fixture_echo",
            description: "Echo the given text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    log(`call ${name}`);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] },
    });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
rl.on("close", () => process.exit(0));
