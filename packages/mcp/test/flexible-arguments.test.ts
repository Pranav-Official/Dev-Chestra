import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { sendJson, spawnRawShim, startTestGateway, type TestGateway } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
});

interface RawSession {
  sendLine: (line: string) => void;
  waitForId: (id: number) => Promise<Record<string, unknown>>;
  stderr: () => string;
  close: () => Promise<void>;
}

function parseFrames(stdout: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      frames.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // A trailing chunk may still be mid-line while polling.
    }
  }
  return frames;
}

async function startRawSession(env: NodeJS.ProcessEnv): Promise<RawSession> {
  const child: ChildProcessWithoutNullStreams = spawnRawShim(env);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const session: RawSession = {
    sendLine: (line: string): void => {
      child.stdin.write(`${line}\n`);
    },
    waitForId: async (id: number): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const frame = parseFrames(stdout).find((candidate) => candidate.id === id);
        if (frame !== undefined) {
          return frame;
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for JSON-RPC id ${id}. stderr: ${stderr}`);
    },
    stderr: (): string => stderr,
    close: async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = once(child, "exit").then(() => undefined);
      child.kill("SIGKILL");
      await exited;
    },
  };
  cleanups.push(session.close);

  session.sendLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "flexible-arguments-test", version: "1" },
      },
    }),
  );
  await session.waitForId(1);
  session.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return session;
}

async function setupGateway(handler: Parameters<typeof startTestGateway>[0]): Promise<TestGateway> {
  const gateway = await startTestGateway(handler);
  cleanups.push(gateway.close);
  return gateway;
}

function isToolCallPost(request: { method: string }): boolean {
  return request.method === "POST";
}

async function waitForToolCall(gateway: TestGateway): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (gateway.requests.some(isToolCallPost)) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for the shim to forward a tools/call request.");
}

describe("raw tools/call argument passthrough", () => {
  it("preserves own __proto__, constructor/prototype and nested JSON exactly through real stdio", async () => {
    const gateway = await setupGateway((_request, response) => {
      sendJson(response, 200, { content: [{ type: "text", text: "ok" }], isError: false });
    });
    const session = await startRawSession({
      RELAY_EXEC_TOKEN: gateway.token,
      RELAY_GATEWAY_URL: gateway.url,
      RELAY_TOOLSET: "agent",
    });

    const rawArguments =
      '{"a":1,"__proto__":{"x":1},"constructor":{"prototype":{"c":1}},"prototype":{"p":2},"nested":{"constructor":{"prototype":{"y":2}},"arr":[null,false,0,"",{"__proto__":{"z":3}}]},"normal":{"keep":true}}';
    const expectedBody = `{"name":"submit_result","arguments":${rawArguments}}`;

    gateway.requests.length = 0;
    session.sendLine(
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"submit_result","arguments":${rawArguments}}}`,
    );
    const response = await session.waitForId(2);
    expect(response.error).toBeUndefined();

    await waitForToolCall(gateway);
    const call = gateway.requests.find(isToolCallPost);
    expect(call?.body).toBe(expectedBody);

    const forwarded = JSON.parse(call?.body ?? "{}") as {
      arguments: Record<string, unknown> & {
        nested: Record<string, unknown> & { arr: Array<Record<string, unknown>> };
      };
    };
    expect(JSON.stringify(forwarded.arguments)).toBe(rawArguments);
    expect(Object.hasOwn(forwarded.arguments, "__proto__")).toBe(true);
    expect(Object.hasOwn(forwarded.arguments, "constructor")).toBe(true);
    expect(Object.hasOwn(forwarded.arguments, "prototype")).toBe(true);
    expect(Object.hasOwn(forwarded.arguments.nested, "constructor")).toBe(true);
    expect(Object.hasOwn(forwarded.arguments.nested.arr[4] ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(forwarded.arguments)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(forwarded.arguments.nested)).toBe(Object.prototype);
    expect(({} as { x?: unknown }).x).toBeUndefined();
    expect(({} as { z?: unknown }).z).toBeUndefined();
    expect(session.stderr()).not.toContain(gateway.token);
  });

  it("rejects malformed names and non-object arguments before the gateway", async () => {
    const gateway = await setupGateway((_request, response) => {
      sendJson(response, 200, { content: [{ type: "text", text: "ok" }], isError: false });
    });
    const session = await startRawSession({
      RELAY_EXEC_TOKEN: gateway.token,
      RELAY_GATEWAY_URL: gateway.url,
      RELAY_TOOLSET: "agent",
    });

    const malformed: Array<{ id: number; params: string }> = [
      { id: 2, params: '{"name":123,"arguments":{}}' },
      { id: 3, params: '{"name":"submit_result","arguments":[1,2]}' },
      { id: 4, params: '{"name":"submit_result","arguments":"string"}' },
      { id: 5, params: '{"name":"submit_result","arguments":null}' },
      { id: 6, params: '{"name":"submit_result","arguments":true}' },
      { id: 7, params: '{"arguments":{}}' },
      { id: 8, params: '{"name":null,"arguments":{}}' },
      { id: 9, params: "{}" },
      { id: 10, params: '{"name":"submit_result","arguments":{},"task":{"ttl":"not-a-number"}}' },
    ];

    for (const frame of malformed) {
      session.sendLine(
        `{"jsonrpc":"2.0","id":${frame.id},"method":"tools/call","params":${frame.params}}`,
      );
    }
    for (const frame of malformed) {
      const response = await session.waitForId(frame.id);
      expect(response.result).toBeUndefined();
      expect(typeof response.error).toBe("object");
    }
    await delay(50);
    expect(gateway.requests.filter(isToolCallPost)).toHaveLength(0);

    session.sendLine(
      '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"submit_result","arguments":{"a":1}}}',
    );
    const accepted = await session.waitForId(12);
    expect(accepted.error).toBeUndefined();
    await waitForToolCall(gateway);
    expect(gateway.requests.filter(isToolCallPost)).toHaveLength(1);
    expect(session.stderr()).not.toContain(gateway.token);
  });
});
