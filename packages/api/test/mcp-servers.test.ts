import { describe, expect, it } from "vitest";
import {
  ApiClient,
  type CliMcpServers,
  cliMcpServersSchema,
  discoveredMcpServerSchema,
} from "../src/index.js";

interface Call {
  url: string;
  init: RequestInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-DevChestra-Api": "1" },
  });
}

function makeClient(factory: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init: init ?? {} };
    calls.push(call);
    return factory(call);
  }) as unknown as typeof fetch;
  return { client: new ApiClient({ baseUrl: "http://127.0.0.1:4821", fetch: fetchImpl }), calls };
}

function body(): CliMcpServers {
  return {
    cli: "codex",
    projectId: "proj-1",
    servers: [
      {
        id: "global:github",
        name: "github",
        scope: "global",
        transport: "stdio",
        summary: "npx -y",
        source: "~/.codex/config.toml",
        status: "ready",
        hasSecrets: true,
      },
    ],
    scanned: ["~/.codex/config.toml"],
    warnings: [],
  };
}

describe("mcp-servers", () => {
  it("accepts a valid CliMcpServers payload", () => {
    expect(cliMcpServersSchema.parse(body())).toEqual(body());
  });

  it("rejects secret-shaped extras and control characters", () => {
    expect(
      cliMcpServersSchema.safeParse({ ...body(), servers: [{ ...body().servers[0], url: "x" }] })
        .success,
    ).toBe(false);
    expect(
      discoveredMcpServerSchema.safeParse({
        ...body().servers[0],
        summary: "bad\nsummary",
      }).success,
    ).toBe(false);
  });

  it("getCliMcpServers hits the mcp-servers path and validates", async () => {
    const { client, calls } = makeClient(() => response(body()));
    const result = await client.getCliMcpServers("proj-1", "codex");
    expect(result).toEqual(body());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4821/api/projects/proj-1/clis/codex/mcp-servers");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("getCliMcpServers rejects an invalid CLI before fetching", async () => {
    const { client, calls } = makeClient(() => response(body()));
    await expect(client.getCliMcpServers("proj-1", "bogus" as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("getCliMcpServers rejects a malformed payload", async () => {
    const { client } = makeClient(() => response({ ...body(), servers: "nope" }));
    await expect(client.getCliMcpServers("proj-1", "codex")).rejects.toThrow();
  });
});
