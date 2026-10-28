import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, ApiProtocolError, ApiTransportError } from "../src/index.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const HEALTH = { ok: true, version: "0.1.0", uptimeMs: 12, instanceId: "instance" };

interface Call {
  url: string;
  init: RequestInit;
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-DevChestra-Api": "1", ...headers },
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

function first(calls: Call[]): Call {
  const call = calls[0];
  if (call === undefined) throw new Error("fetch was not called");
  return call;
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

const executionDetail = {
  execution: {
    runId: RUN_ID,
    path: "evaluate[3]/try",
    nodeId: "try",
    status: "succeeded",
    attempt: 1,
    generation: 1,
    kind: "agent",
    validationAttempts: 0,
    validationLimit: 3,
    crashAttempts: 0,
    startedAt: 1,
    endedAt: 2,
    cli: "fake",
    sessionId: null,
    sessionCwd: null,
    model: null,
    outputId: null,
    errorCode: null,
    errorMessage: null,
    branch: null,
    lastEventId: 4,
  },
  attempts: [],
  input: null,
  output: null,
  usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "none" },
  process: null,
  workspace: null,
};

describe("ApiClient", () => {
  it("calls health with same-origin credentials and the API major header", async () => {
    const { client, calls } = makeClient(() => response(HEALTH));
    await expect(client.health()).resolves.toEqual(HEALTH);
    const call = first(calls);
    expect(call.url).toBe("http://127.0.0.1:4821/api/health");
    expect(call.init.credentials).toBe("same-origin");
    expect(header(call, "X-DevChestra-Api")).toBe("1");
    expect(header(call, "X-DevChestra-Csrf")).toBeNull();
  });

  it("encodes an execution path as one URL segment", async () => {
    const { client, calls } = makeClient(() => response(executionDetail));
    await client.getExecution(RUN_ID, "evaluate[3]/try");
    expect(first(calls).url).toBe(
      `http://127.0.0.1:4821/api/runs/${RUN_ID}/executions/evaluate%5B3%5D%2Ftry`,
    );
  });

  it("encodes event filters and pagination", async () => {
    const { client, calls } = makeClient(() =>
      response({ events: [], nextAfter: 0, hasMore: false, watermark: 0 }),
    );
    await client.listRunEvents(RUN_ID, {
      after: 5,
      upTo: 9,
      limit: 10,
      types: ["node.usage", "run.started"],
      pathPrefix: "evaluate[3]",
    });
    const url = new URL(first(calls).url);
    expect(url.pathname).toBe(`/api/runs/${RUN_ID}/events`);
    expect(url.searchParams.get("after")).toBe("5");
    expect(url.searchParams.get("upTo")).toBe("9");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("types")).toBe("node.usage,run.started");
    expect(url.searchParams.get("pathPrefix")).toBe("evaluate[3]");
    expect(url.searchParams.toString()).toContain(
      "types=node.usage%2Crun.started&pathPrefix=evaluate%5B3%5D",
    );
  });

  it("encodes run list filters and cursor pagination", async () => {
    const { client, calls } = makeClient(() => response({ items: [], nextCursor: null }));
    await client.listRuns({
      project: "orbit-web-3f9a",
      workflow: "demo",
      status: "running",
      cursor: "opaque/cursor",
      limit: 20,
    });
    const url = new URL(first(calls).url);
    expect(url.pathname).toBe("/api/runs");
    expect(url.searchParams.get("project")).toBe("orbit-web-3f9a");
    expect(url.searchParams.get("workflow")).toBe("demo");
    expect(url.searchParams.get("status")).toBe("running");
    expect(url.searchParams.get("cursor")).toBe("opaque/cursor");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("sends CSRF, JSON content type and the idempotency key on start", async () => {
    const { client, calls } = makeClient(() =>
      response({ runId: RUN_ID, duplicate: true, status: "queued" }, 202),
    );
    await client.startRun(
      "orbit-web-3f9a",
      { workflowFile: "workflows/demo.json", params: { topic: "devchestra" } },
      { idempotencyKey: "start-1" },
    );
    const call = first(calls);
    expect(call.init.method).toBe("POST");
    expect(header(call, "X-DevChestra-Csrf")).toBe("1");
    expect(header(call, "Content-Type")).toBe("application/json");
    expect(header(call, "Idempotency-Key")).toBe("start-1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      workflowFile: "workflows/demo.json",
      params: { topic: "devchestra" },
    });
  });

  it("omits Idempotency-Key when the caller omits it", async () => {
    const { client, calls } = makeClient(() =>
      response({ runId: RUN_ID, duplicate: false, status: "queued" }, 202),
    );
    await client.startRun("p", { workflowFile: "demo.json" });
    expect(header(first(calls), "Idempotency-Key")).toBeNull();
  });

  it("rejects unknown request fields before calling fetch", async () => {
    const { client, calls } = makeClient(() => response({}));
    const body = { workflowFile: "demo.json", script: "trusted-cli-only" };
    await expect(client.startRun("p", body as never)).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("sends CSRF on cancel and resume", async () => {
    const { client, calls } = makeClient(() =>
      response({ runId: RUN_ID, status: "cancelled" }, 202),
    );
    await client.cancelRun(RUN_ID);
    await client.resumeRun(RUN_ID);
    expect(header(first(calls), "X-DevChestra-Csrf")).toBe("1");
    expect(first(calls).init.method).toBe("POST");
    expect(calls).toHaveLength(2);
  });

  it("does not leak the ApiClient receiver into fetch (browser brand check)", async () => {
    const brandChecked = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(response(HEALTH));
    } as typeof fetch;
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:4821",
      fetch: brandChecked,
    });
    await expect(client.health()).resolves.toEqual(HEALTH);
  });

  it("binds the default global fetch to globalThis (browser brand check)", async () => {
    const original = globalThis.fetch;
    const brandChecked = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response(HEALTH));
    } as typeof fetch;
    globalThis.fetch = brandChecked;
    try {
      const client = new ApiClient({ baseUrl: "http://127.0.0.1:4821" });
      await expect(client.health()).resolves.toEqual(HEALTH);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the CLI token header when configured", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(_input), init: init ?? {} });
      return response(HEALTH);
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: fetchImpl,
      token: "secret",
    });
    await client.health();
    expect(header(first(calls), "X-DevChestra-Token")).toBe("secret");
  });

  it("rejects a different or missing response API major", async () => {
    const wrong = makeClient(
      () => new Response("{}", { status: 200, headers: { "X-DevChestra-Api": "2" } }),
    );
    await expect(wrong.client.health()).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "version",
    });
    const missing = makeClient(() => new Response("{}", { status: 200 }));
    await expect(missing.client.health()).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "version",
    });
  });

  it("refuses to construct a client for another major", () => {
    expect(() => new ApiClient({ apiMajor: 2 })).toThrow(ApiProtocolError);
  });

  it("maps an error body to ApiError", async () => {
    const { client } = makeClient(() =>
      response(
        { error: { code: "E_CONFLICT", message: "changed on disk", details: { etag: "x" } } },
        409,
        { "X-Request-Id": "req-1" },
      ),
    );
    await expect(client.health()).rejects.toMatchObject({
      name: "ApiError",
      code: "E_CONFLICT",
      status: 409,
      requestId: "req-1",
      details: { etag: "x" },
    });
    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
  });

  it("maps the server's E_FORBIDDEN project-path error", async () => {
    const { client } = makeClient(() =>
      response({ error: { code: "E_FORBIDDEN", message: "project path overlap" } }, 403),
    );
    await expect(client.health()).rejects.toMatchObject({
      name: "ApiError",
      code: "E_FORBIDDEN",
      status: 403,
    });
  });

  it("rejects a non-JSON error body as a protocol error", async () => {
    const { client } = makeClient(
      () => new Response("oops", { status: 500, headers: { "X-DevChestra-Api": "1" } }),
    );
    await expect(client.health()).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "invalid-response",
    });
  });

  it("rejects a success body that does not match the schema", async () => {
    const { client } = makeClient(() => response({ ok: true }));
    await expect(client.health()).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "invalid-response",
    });
  });

  it("rethrows AbortError unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", fetch: fetchImpl });
    await expect(client.health({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("wraps other fetch failures in ApiTransportError", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", fetch: fetchImpl });
    await expect(client.health()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("rejects a non-event-stream SSE response", async () => {
    const { client } = makeClient(() => response({ ok: true }));
    const stream = client.streamGlobalEvents();
    await expect(stream.next()).rejects.toMatchObject({
      name: "ApiProtocolError",
      kind: "event-stream",
    });
  });

  it("streams typed run frames", async () => {
    const envelope = {
      id: 7,
      runId: RUN_ID,
      ts: "2026-10-27T00:00:00.000Z",
      path: "",
      type: "run.started",
      actor: "engine",
      v: 1,
      payload: {},
    };
    const text =
      `event: run\nid: 7\ndata: ${JSON.stringify(envelope)}\n\n` +
      `event: overflow\ndata: {"lastEventId":7}\n\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    const { client } = makeClient(
      () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-DevChestra-Api": "1" },
        }),
    );
    const messages = [];
    for await (const message of client.streamRunEvents(RUN_ID, { after: 6 })) {
      messages.push(message);
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ event: "run", id: 7 });
    expect(messages[1]).toEqual({ event: "overflow", data: { lastEventId: 7 } });
  });
});
