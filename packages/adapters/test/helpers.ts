import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRequest } from "../src/index.js";

export const TOKEN = "token-value-do-not-persist";
export const FIXTURES = resolve(
  fileURLToPath(new URL("../../../tools/fixtures/adapters", import.meta.url)),
);

export function fixtureJson(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES, ...parts), "utf8")) as Record<string, unknown>;
}

export function fixtureText(...parts: string[]): string {
  return readFileSync(resolve(FIXTURES, ...parts), "utf8");
}

export function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    mode: "fresh",
    prompt: "Call submit_result once.",
    cwd: "/work",
    permissions: { network: false, write: [], extraReadDirs: [] },
    limits: { timeoutMs: 5_000, maxTurns: 2 },
    mcp: {
      serverName: "relay",
      command: "/usr/bin/node",
      args: ["/abs/shim.js"],
      env: {
        RELAY_EXEC_TOKEN: TOKEN,
        RELAY_GATEWAY_URL: "http://127.0.0.1:4310",
        RELAY_TOOLSET: "agent",
      },
    },
    execDir: "/run",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/test" },
    ...overrides,
  };
}
