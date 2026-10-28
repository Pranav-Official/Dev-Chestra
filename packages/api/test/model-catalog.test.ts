import { describe, expect, it } from "vitest";
import {
  ApiClient,
  type CatalogCli,
  type CliModelCatalog,
  cliModelCatalogSchema,
  cliModelItemSchema,
} from "../src/index.js";

const TOKEN = "a".repeat(43);

interface Call {
  url: string;
  init: RequestInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Relay-Api": "1" },
  });
}

function makeClient(body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response(body);
  }) as unknown as typeof fetch;
  return {
    client: new ApiClient({ baseUrl: "http://127.0.0.1:4821", fetch: fetchImpl }),
    calls,
  };
}

function catalog(overrides: Partial<CliModelCatalog> = {}): CliModelCatalog {
  return {
    cli: "codex",
    projectId: "proj/one",
    status: "ready",
    scope: "relay-runtime",
    source: "codex-app-server",
    cliVersion: "0.164.0",
    items: [
      {
        id: "gpt-5-codex",
        label: "GPT-5 Codex",
        provider: "openai",
        description: "Codex model",
        aliases: ["gpt-5"],
        isDefault: true,
        source: "codex-app-server",
      },
    ],
    fetchedAt: 1,
    expiresAt: 2,
    truncated: false,
    customSupported: true,
    ...overrides,
  };
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

describe("model catalog schema", () => {
  it("accepts a bounded ready catalog", () => {
    expect(cliModelCatalogSchema.parse(catalog())).toEqual(catalog());
  });

  it("rejects control characters in model identifiers", () => {
    for (const id of ["a\u0000b", "a\nb", "a\u007fb"]) {
      expect(
        cliModelItemSchema.safeParse({ id, label: "x", source: "codex-app-server" }).success,
      ).toBe(false);
    }
  });

  it("enforces item and string bounds", () => {
    expect(
      cliModelItemSchema.safeParse({
        id: "x".repeat(257),
        label: "x",
        source: "codex-app-server",
      }).success,
    ).toBe(false);
    expect(
      cliModelItemSchema.safeParse({
        id: "x",
        label: "x".repeat(257),
        source: "codex-app-server",
      }).success,
    ).toBe(false);
    expect(
      cliModelItemSchema.safeParse({
        id: "x",
        label: "x",
        aliases: Array.from({ length: 33 }, () => "a"),
        source: "codex-app-server",
      }).success,
    ).toBe(false);
    expect(
      cliModelCatalogSchema.safeParse({
        ...catalog(),
        items: Array.from({ length: 1001 }, (_, index) => ({
          id: `m-${index}`,
          label: "m",
          source: "codex-app-server",
        })),
      }).success,
    ).toBe(false);
    expect(
      cliModelCatalogSchema.safeParse({ ...catalog(), message: "x".repeat(257) }).success,
    ).toBe(false);
    expect(
      cliModelCatalogSchema.safeParse({ ...catalog(), cliVersion: "x".repeat(129) }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and sources", () => {
    expect(cliModelCatalogSchema.safeParse({ ...catalog(), env: "/home/user" }).success).toBe(
      false,
    );
    expect(cliModelCatalogSchema.safeParse({ ...catalog(), source: "alias-list" }).success).toBe(
      false,
    );
    expect(
      cliModelItemSchema.safeParse({ id: "m", label: "m", source: "claude-documented-alias" })
        .success,
    ).toBe(false);
  });
});

describe("model catalog client", () => {
  it("GETs the project-scoped catalog without CSRF, body or query", async () => {
    const { client, calls } = makeClient(catalog());
    await expect(client.getCliModels("proj/one", "codex")).resolves.toEqual(catalog());
    const call = calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    expect(call.url).toBe("http://127.0.0.1:4821/api/projects/proj%2Fone/clis/codex/models");
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expect(header(call, "X-Relay-Csrf")).toBeNull();
    expect(header(call, "X-Relay-Token")).toBeNull();
  });

  it("POSTs a bodyless CSRF-protected refresh", async () => {
    const { client, calls } = makeClient(catalog({ status: "stale" }));
    await expect(client.refreshCliModels("proj-1", "codex")).resolves.toMatchObject({
      status: "stale",
    });
    const call = calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    expect(call.url).toBe("http://127.0.0.1:4821/api/projects/proj-1/clis/codex/models/refresh");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
    expect(header(call, "X-Relay-Csrf")).toBe("1");
    expect(header(call, "Content-Type")).toBe("application/json");
  });

  it("sends the CLI token when configured", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(_input), init: init ?? {} });
      return response(
        catalog({ cli: "claude-code", source: "none", status: "unsupported", items: [] }),
      );
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:4821",
      fetch: fetchImpl,
      token: TOKEN,
    });
    await client.getCliModels("proj-1", "claude-code");
    expect(header(calls[0] as Call, "X-Relay-Token")).toBe(TOKEN);
  });

  it("rejects an unknown CLI before calling fetch", async () => {
    const { client, calls } = makeClient(catalog());
    await expect(client.getCliModels("proj-1", "fake" as CatalogCli)).rejects.toBeDefined();
    await expect(
      client.refreshCliModels("proj-1", "bogus-cli" as CatalogCli),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a response catalog with an unknown source", async () => {
    const { client } = makeClient({ ...catalog(), source: "alias-list" });
    await expect(client.getCliModels("proj-1", "codex")).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "invalid-response",
    });
  });
});
