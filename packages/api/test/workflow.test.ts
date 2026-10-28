import type { WorkflowFile } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import {
  ApiClient,
  createWorkflowRequestSchema,
  workflowDocumentResponseSchema,
} from "../src/index.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const WORKFLOW: WorkflowFile = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  graph: {
    nodes: [
      { id: "start", type: "start", name: "Inputs", params: [] },
      {
        id: "end",
        type: "end",
        name: "Done",
        status: "success",
        result: '{ "ok": true }',
      },
    ],
    edges: [{ id: "e1", from: "start", to: "end" }],
  },
};

const VALIDATION = {
  ok: true,
  errors: [],
  warnings: [],
  requires: {
    clis: ["fake"],
    networkNodes: [],
    shellCommands: [],
    projectWriteNodes: [],
    worktreeNodes: [],
    providers: [],
    envVars: [],
    irreversibleApprovals: [],
    budget: {},
  },
};

const DOCUMENT = {
  workflow: WORKFLOW,
  text: `${JSON.stringify(WORKFLOW, null, 2)}\n`,
  etag: "abc123",
  relativeFile: ".devchestra/workflows/demo.json",
  validation: VALIDATION,
};

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

describe("workflow API client", () => {
  it("lists workflows with pagination", async () => {
    const { client, calls } = makeClient(() => response({ items: [], nextCursor: null }));
    await client.listWorkflows("p1", { cursor: "c/1", limit: 20 });
    const call = first(calls);
    expect(call.init.method).toBe("GET");
    const url = new URL(call.url);
    expect(url.pathname).toBe("/api/projects/p1/workflows");
    expect(url.searchParams.get("cursor")).toBe("c/1");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(header(call, "X-DevChestra-Csrf")).toBeNull();
  });

  it("creates a workflow and accepts 201", async () => {
    const { client, calls } = makeClient(() => response(DOCUMENT, 201));
    await expect(
      client.createWorkflow("p1", { name: "Demo", id: "demo", template: "blank" }),
    ).resolves.toMatchObject({ etag: "abc123" });
    const call = first(calls);
    expect(call.init.method).toBe("POST");
    expect(header(call, "X-DevChestra-Csrf")).toBe("1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      name: "Demo",
      id: "demo",
      template: "blank",
    });
  });

  it("gets a workflow document", async () => {
    const { client, calls } = makeClient(() => response(DOCUMENT, 200, { ETag: '"abc123"' }));
    const document = await client.getWorkflow("p1", "demo");
    expect(document.etag).toBe("abc123");
    expect(document.relativeFile).toBe(".devchestra/workflows/demo.json");
    expect(first(calls).url).toBe("http://127.0.0.1:4821/api/projects/p1/workflows/demo");
  });

  it("saves with a quoted If-Match and returns the new revision", async () => {
    const { client, calls } = makeClient(() => response({ ...DOCUMENT, etag: "next" }));
    await client.saveWorkflow("p1", "demo", { workflow: WORKFLOW }, "abc123");
    const call = first(calls);
    expect(call.init.method).toBe("PUT");
    expect(header(call, "If-Match")).toBe('"abc123"');
    expect(header(call, "X-DevChestra-Csrf")).toBe("1");
    expect(JSON.parse(String(call.init.body))).toEqual({ workflow: WORKFLOW });
  });

  it("deletes with If-Match and accepts an empty 204", async () => {
    const { client, calls } = makeClient(
      () => new Response(null, { status: 204, headers: { "X-DevChestra-Api": "1" } }),
    );
    await expect(client.deleteWorkflow("p1", "demo", "abc123")).resolves.toBeUndefined();
    const call = first(calls);
    expect(call.init.method).toBe("DELETE");
    expect(header(call, "If-Match")).toBe('"abc123"');
    expect(header(call, "X-DevChestra-Csrf")).toBe("1");
    expect(header(call, "Content-Type")).toBe("application/json");
    expect(call.init.body).toBeUndefined();
  });

  it("validates an unsaved draft through the wrapped endpoint", async () => {
    const { client, calls } = makeClient(() => response({ validation: VALIDATION }));
    const result = await client.validateWorkflow("p1", "demo", { workflow: WORKFLOW });
    expect(result.validation.ok).toBe(true);
    const call = first(calls);
    expect(call.url).toBe("http://127.0.0.1:4821/api/projects/p1/workflows/demo/validate");
    expect(JSON.parse(String(call.init.body))).toEqual({ workflow: WORKFLOW });
  });

  it("starts from the exact saved revision with Idempotency-Key", async () => {
    const { client, calls } = makeClient(() =>
      response({ runId: RUN_ID, duplicate: false, status: "queued" }, 202),
    );
    await client.startWorkflowRun(
      "p1",
      "demo",
      { params: { topic: "devchestra" }, etag: "abc123" },
      { idempotencyKey: "start-1" },
    );
    const call = first(calls);
    expect(call.url).toBe("http://127.0.0.1:4821/api/projects/p1/workflows/demo/runs");
    expect(header(call, "Idempotency-Key")).toBe("start-1");
    expect(header(call, "X-DevChestra-Csrf")).toBe("1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      params: { topic: "devchestra" },
      etag: "abc123",
    });
  });

  it("rejects unknown fields and malformed etags before fetch", async () => {
    const { client, calls } = makeClient(() => response(DOCUMENT));
    await expect(
      client.createWorkflow("p1", { name: "Demo", script: "run" } as never),
    ).rejects.toBeDefined();
    await expect(
      client.startWorkflowRun("p1", "demo", { etag: "abc123", provider: "paid" } as never),
    ).rejects.toBeDefined();
    await expect(
      client.saveWorkflow(
        "p1",
        "demo",
        { workflow: { ...WORKFLOW, script: "run" } as never },
        "abc123",
      ),
    ).rejects.toBeDefined();
    await expect(
      client.saveWorkflow("p1", "demo", { workflow: WORKFLOW }, 'bad"etag'),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("compiles and parses schemas without eval (strict CSP)", () => {
    const original = globalThis.Function;
    globalThis.Function = function blocked(): never {
      throw new Error("new Function is blocked by CSP");
    } as unknown as FunctionConstructor;
    try {
      expect(createWorkflowRequestSchema.safeParse({ name: "Demo" }).success).toBe(true);
      expect(workflowDocumentResponseSchema.safeParse(DOCUMENT).success).toBe(true);
    } finally {
      globalThis.Function = original;
    }
  });
});
