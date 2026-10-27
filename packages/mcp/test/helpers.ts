import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentToolDescriptor } from "../src/types.js";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SHIM_TS = fileURLToPath(new URL("../src/bin/shim.ts", import.meta.url));

export interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export type TestGatewayHandler = (
  request: CapturedRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface TestGateway {
  url: string;
  token: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export async function startTestGateway(handler: TestGatewayHandler): Promise<TestGateway> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const captured: CapturedRequest = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body,
        json,
      };
      requests.push(captured);
      Promise.resolve(handler(captured, response)).catch(() => {
        if (!response.writableEnded) {
          sendJson(response, 500, { error: { code: "E_TEST", message: "test handler failed" } });
        }
      });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test gateway did not bind a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    token: `test-token-${randomUUID()}`,
    requests,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
    },
  };
}

export const TOOLS: AgentToolDescriptor[] = [
  {
    name: "submit_result",
    description: "Submit the node result",
    inputSchema: { type: "object", properties: { answer: { type: "string" } } },
  },
];

export interface ConnectedShim {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

export async function connectShim(
  gatewayUrl: string,
  token: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ConnectedShim> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", SHIM_TS],
    cwd: PACKAGE_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      RELAY_EXEC_TOKEN: token,
      RELAY_GATEWAY_URL: gatewayUrl,
      RELAY_TOOLSET: "agent",
      ...Object.fromEntries(
        Object.entries(extraEnv).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
    stderr: "pipe",
    maxBufferSize: 2 * 1024 * 1024,
  });

  let stderrText = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrText += String(chunk);
  });

  const client = new Client({ name: "relay-mcp-test", version: "0.0.0" });
  await client.connect(transport);

  return {
    client,
    stderr: () => stderrText,
    close: async (): Promise<void> => {
      await client.close().catch(() => undefined);
    },
  };
}

export async function runShimProcess(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", SHIM_TS], {
    cwd: PACKAGE_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 10_000);
  const [code] = (await once(child, "exit")) as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export function spawnRawShim(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", SHIM_TS], {
    cwd: PACKAGE_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
