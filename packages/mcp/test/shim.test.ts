import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGatewayClient, resolveLoopbackGatewayUrl } from "../src/gateway-client.js";
import { deriveCallId } from "../src/receipt.js";
import {
  connectShim,
  headerValue,
  runShimProcess,
  sendJson,
  spawnRawShim,
  startTestGateway,
  type TestGateway,
  TOOLS,
} from "./helpers.js";

function textOf(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray((result as { content?: unknown }).content)
  ) {
    return "";
  }
  return (result as { content: Array<{ type?: string; text?: string }> }).content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
});

async function setupGateway(handler: Parameters<typeof startTestGateway>[0]): Promise<TestGateway> {
  const gateway = await startTestGateway(handler);
  cleanups.push(gateway.close);
  return gateway;
}

async function setupClient(gateway: TestGateway, extraEnv: NodeJS.ProcessEnv = {}) {
  const shim = await connectShim(gateway.url, gateway.token, extraEnv);
  cleanups.push(shim.close);
  return shim;
}

describe("stdio shim against a real loopback gateway", () => {
  it("forwards tools/list and a successful tools/call without adding authority", async () => {
    let gateway: TestGateway;
    gateway = await setupGateway((request, response) => {
      if (request.method === "GET" && request.path === "/internal/agent/tools") {
        expect(headerValue(request.headers, "authorization")).toBe(`Bearer ${gateway.token}`);
        expect(headerValue(request.headers, "cookie")).toBeUndefined();
        sendJson(response, 200, { tools: TOOLS });
        return;
      }
      if (request.method === "POST" && request.path === "/internal/agent/call") {
        expect(headerValue(request.headers, "authorization")).toBe(`Bearer ${gateway.token}`);
        expect(headerValue(request.headers, "cookie")).toBeUndefined();
        const body = request.json as { name?: unknown; arguments?: unknown };
        expect(body).toEqual({ name: "submit_result", arguments: { answer: "ok" } });
        expect(headerValue(request.headers, "x-devchestra-call-id")).toMatch(
          /^shim_[A-Za-z0-9_-]{32}$/,
        );
        sendJson(response, 200, {
          content: [
            { type: "text", text: "Result accepted. You are done; do not call any other tool." },
          ],
          isError: false,
        });
        return;
      }
      sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
    });

    const shim = await setupClient(gateway);
    const listed = await shim.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["submit_result"]);

    const result = await shim.client.callTool({
      name: "submit_result",
      arguments: { answer: "ok" },
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("Result accepted");
    expect(shim.stderr()).not.toContain(gateway.token);

    const call = gateway.requests.find((request) => request.method === "POST");
    expect(call?.json).toEqual({ name: "submit_result", arguments: { answer: "ok" } });
    expect(call?.body).not.toContain("callId");
  });

  it("maps gateway validation errors intact and never marks a call successful", async () => {
    let calls = 0;
    const gateway = await setupGateway((request, response) => {
      if (request.method === "GET" && request.path === "/internal/agent/tools") {
        sendJson(response, 200, { tools: TOOLS });
        return;
      }
      if (request.method !== "POST" || request.path !== "/internal/agent/call") {
        sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
        return;
      }
      calls += 1;
      if (calls === 1) {
        sendJson(response, 200, {
          content: [
            {
              type: "text",
              text: "answer: must be a string (expected string)\nFix these and call submit_result again.",
            },
          ],
          isError: true,
        });
        return;
      }
      sendJson(response, 200, { content: "not-an-array", isError: false });
    });

    const shim = await setupClient(gateway);
    const rejected = await shim.client.callTool({
      name: "submit_result",
      arguments: { answer: 7 },
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("answer: must be a string");

    const invalid = await shim.client.callTool({
      name: "submit_result",
      arguments: { answer: "x" },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("invalid tool result");
  });

  it("reuses X-DevChestra-Call-Id across a transport retry and differs per model call", async () => {
    let calls = 0;
    const gateway = await setupGateway((request, response) => {
      if (request.method === "GET" && request.path === "/internal/agent/tools") {
        sendJson(response, 200, { tools: TOOLS });
        return;
      }
      if (request.method !== "POST" || request.path !== "/internal/agent/call") {
        sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
        return;
      }
      calls += 1;
      if (calls === 1) {
        sendJson(response, 503, { error: { code: "E_UNAVAILABLE", message: "retry me" } });
        return;
      }
      sendJson(response, 200, { content: [{ type: "text", text: "ok" }], isError: false });
    });

    const shim = await setupClient(gateway, { DEVCHESTRA_GATEWAY_RETRIES: "1" });
    const first = await shim.client.callTool({ name: "submit_result", arguments: { n: 1 } });
    const second = await shim.client.callTool({ name: "submit_result", arguments: { n: 1 } });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);

    const callIds = gateway.requests
      .filter((request) => request.method === "POST")
      .map((request) => headerValue(request.headers, "x-devchestra-call-id"));
    expect(callIds).toHaveLength(3);
    expect(callIds[0]).toBeDefined();
    expect(callIds[0]).toBe(callIds[1]);
    expect(callIds[2]).not.toBe(callIds[0]);
  });

  it("exits safely when required env is missing and maps an unreachable gateway", async () => {
    const missing = await runShimProcess({
      DEVCHESTRA_EXEC_TOKEN: "",
      DEVCHESTRA_GATEWAY_URL: "http://127.0.0.1:1",
      DEVCHESTRA_TOOLSET: "agent",
    });
    expect(missing.code).not.toBe(0);
    expect(missing.stdout.trim()).toBe("");
    expect(missing.stderr).toContain("DEVCHESTRA_EXEC_TOKEN");

    const closed = await startTestGateway(() => undefined);
    const closedUrl = closed.url;
    const closedToken = closed.token;
    await closed.close();

    const unreachable = await connectShim(closedUrl, closedToken, { DEVCHESTRA_MCP_DEBUG: "1" });
    cleanups.push(unreachable.close);
    const result = await unreachable.client.callTool({ name: "submit_result", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("DevChestra is not reachable. Stop and report this.");
    expect(unreachable.stderr()).not.toContain(closedToken);
  });

  it("keeps stdout protocol-clean while debug logging goes to stderr", async () => {
    const gateway = await setupGateway((_request, response) => {
      sendJson(response, 200, { tools: TOOLS });
    });
    const child = spawnRawShim({
      DEVCHESTRA_EXEC_TOKEN: gateway.token,
      DEVCHESTRA_GATEWAY_URL: gateway.url,
      DEVCHESTRA_TOOLSET: "agent",
      DEVCHESTRA_MCP_DEBUG: "1",
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const parseStdout = (): Array<Record<string, unknown>> => {
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
    };

    const waitForId = async (id: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (parseStdout().some((frame) => frame.id === id)) {
          return;
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for JSON-RPC id ${id}`);
    };

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "raw-test", version: "1" },
        },
      })}\n`,
    );
    await waitForId(1);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    await waitForId(2);

    child.stdin.end();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);

    const frames = parseStdout();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe("2.0");
    }
    expect(stderr).toContain("tools/list");
    expect(stderr).not.toContain(gateway.token);
  });
});

describe("receipt identity", () => {
  it("distinguishes numeric and string JSON-RPC ids and is stable per shim instance", () => {
    expect(deriveCallId("instance-a", 1)).not.toBe(deriveCallId("instance-a", "1"));
    expect(deriveCallId("instance-a", 1)).toBe(deriveCallId("instance-a", 1));
    expect(deriveCallId("instance-a", 1)).not.toBe(deriveCallId("instance-b", 1));
  });

  it("proves the real SDK supplies a typed request id to handlers", async () => {
    const seen: Array<string | number> = [];
    const server = new Server({ name: "probe", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      seen.push(extra.requestId);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "probe-client", version: "0.0.0" });
    await client.connect(clientTransport);
    await client.callTool({ name: "x", arguments: {} });
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("number");
    await client.close();
    await server.close();
  });
});

describe("gateway URL and client limits", () => {
  it("accepts loopback literals, rewrites safe localhost, and rejects unsafe URLs", async () => {
    expect((await resolveLoopbackGatewayUrl("http://127.0.0.1:1234")).hostname).toBe("127.0.0.1");
    expect((await resolveLoopbackGatewayUrl("http://[::1]:1234")).hostname).toBe("[::1]");

    const local = await resolveLoopbackGatewayUrl("http://localhost:1234/gateway", async () => [
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(local.hostname).toBe("127.0.0.1");
    expect(local.pathname).toBe("/gateway/");

    const remoteLookup = async () => [{ address: "192.0.2.10", family: 4 }];
    await expect(
      resolveLoopbackGatewayUrl("http://localhost:1234", remoteLookup),
    ).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(resolveLoopbackGatewayUrl("https://127.0.0.1:1234")).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    await expect(resolveLoopbackGatewayUrl("http://example.com:1234")).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    await expect(
      resolveLoopbackGatewayUrl("http://user:pass@127.0.0.1:1234"),
    ).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    await expect(resolveLoopbackGatewayUrl("http://127.0.0.1:1234?x=1")).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    await expect(resolveLoopbackGatewayUrl("http://127.0.0.1:1234#x")).rejects.toMatchObject({
      code: "E_CONFIG",
    });
  });

  it("refuses to follow redirects with the bearer token", async () => {
    const gateway = await setupGateway((_request, response) => {
      response.writeHead(302, { location: "http://example.com/steal" });
      response.end();
    });
    const client = await createAgentGatewayClient({
      gatewayUrl: gateway.url,
      token: gateway.token,
      toolset: "agent",
      retries: 0,
    });
    await expect(client.listTools()).rejects.toMatchObject({ code: "E_GATEWAY_UNAVAILABLE" });
  });

  it("times out, aborts, and enforces response/request limits", async () => {
    const slow = await setupGateway(async (request, response) => {
      if (request.method !== "POST" || request.path !== "/internal/agent/call") {
        sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
        return;
      }
      await delay(250);
      sendJson(response, 200, { content: [{ type: "text", text: "late" }], isError: false });
    });

    const timedClient = await createAgentGatewayClient({
      gatewayUrl: slow.url,
      token: slow.token,
      toolset: "agent",
      submitTimeoutMs: 40,
      retries: 0,
    });
    await expect(
      timedClient.callTool({ name: "submit_result", arguments: {}, callId: "call-timeout" }),
    ).rejects.toMatchObject({ code: "E_TIMEOUT" });

    const abortClient = await createAgentGatewayClient({
      gatewayUrl: slow.url,
      token: slow.token,
      toolset: "agent",
      defaultTimeoutMs: 5_000,
      retries: 0,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(
      abortClient.callTool(
        { name: "submit_result", arguments: {}, callId: "call-abort" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "E_ABORTED" });

    const big = await setupGateway((request, response) => {
      if (request.method !== "POST" || request.path !== "/internal/agent/call") {
        sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
        return;
      }
      sendJson(response, 200, {
        content: [{ type: "text", text: "x".repeat(200) }],
        isError: false,
      });
    });
    const smallResponseClient = await createAgentGatewayClient({
      gatewayUrl: big.url,
      token: big.token,
      toolset: "agent",
      maxResponseBytes: 32,
      retries: 0,
    });
    await expect(
      smallResponseClient.callTool({ name: "submit_result", arguments: {}, callId: "call-big" }),
    ).rejects.toMatchObject({ code: "E_RESPONSE_TOO_LARGE" });

    const smallRequestClient = await createAgentGatewayClient({
      gatewayUrl: big.url,
      token: big.token,
      toolset: "agent",
      maxRequestBytes: 8,
      retries: 0,
    });
    const tooLarge = await smallRequestClient.callTool({
      name: "submit_result",
      arguments: { answer: "too long" },
      callId: "call-request-big",
    });
    expect(tooLarge.isError).toBe(true);
    expect(textOf(tooLarge)).toContain("size limit");
  });

  it("preserves gateway error codes while redacting the token", async () => {
    let token = "";
    const gateway = await setupGateway((request, response) => {
      if (request.method !== "POST" || request.path !== "/internal/agent/call") {
        sendJson(response, 404, { error: { code: "E_NOT_FOUND", message: "unexpected route" } });
        return;
      }
      sendJson(response, 401, {
        error: { code: "E_AUTH", message: `bad token ${token}` },
      });
    });
    token = gateway.token;
    const client = await createAgentGatewayClient({
      gatewayUrl: gateway.url,
      token: gateway.token,
      toolset: "agent",
      retries: 0,
    });
    const result = await client.callTool({
      name: "submit_result",
      arguments: {},
      callId: "call-auth",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("E_AUTH");
    expect(textOf(result)).not.toContain(gateway.token);
    expect(textOf(result)).toContain("[REDACTED]");
  });
});
