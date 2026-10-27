import { emptyRunView } from "@relay/core";
import { describe, expect, it } from "vitest";
import {
  ApiClient,
  gateTestRequestSchema,
  gateTestResultSchema,
  normalizedWorkflowSchema,
  runViewSchema,
} from "../src/index.js";

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

const GATE = {
  id: "triage",
  type: "gate" as const,
  name: "Triage",
  branches: [
    { id: "high", when: "score >= 0.8" },
    { id: "low", otherwise: true as const },
  ],
};

describe("gate test API", () => {
  it("posts a stateless gate preview and returns the shared decision", async () => {
    const result = {
      branch: "high",
      evaluated: [{ branch: "high", matched: true }],
    };
    const { client, calls } = makeClient(() => response(result));
    await expect(client.testGate("p1", { gate: GATE, scope: { score: 0.9 } })).resolves.toEqual(
      result,
    );
    const call = calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    expect(call.init.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/api/projects/p1/gates/test");
    expect(new Headers(call.init.headers).get("X-Relay-Csrf")).toBe("1");
    expect(JSON.parse(String(call.init.body))).toEqual({ gate: GATE, scope: { score: 0.9 } });
  });

  it("accepts a failed preview with a null branch and error", () => {
    const parsed = gateTestResultSchema.safeParse({
      branch: null,
      evaluated: [{ branch: "high", matched: false, error: "when must be a boolean" }],
      error: { code: "E_EXPR", message: "when must be a boolean" },
    });
    expect(parsed.success).toBe(true);
  });

  it("requires exactly one otherwise, last, and a when on every other branch", () => {
    const base = { id: "g", type: "gate", name: "G" };
    expect(
      gateTestRequestSchema.safeParse({
        gate: { ...base, branches: [{ id: "a", when: "x" }] },
        scope: {},
      }).success,
    ).toBe(false);
    expect(
      gateTestRequestSchema.safeParse({
        gate: {
          ...base,
          branches: [
            { id: "a", otherwise: true },
            { id: "b", when: "x" },
          ],
        },
        scope: {},
      }).success,
    ).toBe(false);
    expect(
      gateTestRequestSchema.safeParse({
        gate: {
          ...base,
          branches: [
            { id: "a", when: "x" },
            { id: "a", otherwise: true },
          ],
        },
        scope: {},
      }).success,
    ).toBe(false);
    expect(
      gateTestRequestSchema.safeParse({
        gate: {
          ...base,
          branches: [
            { id: "a", when: "x" },
            { id: "b", otherwise: true },
          ],
        },
        scope: {},
      }).success,
    ).toBe(true);
  });

  it("rejects non-gate types, unknown fields and oversized scopes", () => {
    const base = { id: "g", type: "gate", name: "G", branches: [{ id: "a", otherwise: true }] };
    expect(
      gateTestRequestSchema.safeParse({ gate: { ...base, type: "agent" }, scope: {} }).success,
    ).toBe(false);
    expect(
      gateTestRequestSchema.safeParse({ gate: { ...base, extra: true }, scope: {} }).success,
    ).toBe(false);
    expect(
      gateTestRequestSchema.safeParse({
        gate: base,
        scope: { blob: "x".repeat(33 * 1024) },
      }).success,
    ).toBe(false);
  });

  it("parses run-view errors whose error.logged details were omitted", () => {
    const view = emptyRunView();
    view.errors.push({
      eventId: 1,
      ts: new Date(0).toISOString(),
      path: "" as never,
      code: "E_JOIN_CONFLICT",
      message: "conflict",
      details: undefined,
    });
    expect(runViewSchema.safeParse(view).success).toBe(true);
  });

  it("mirrors six normalized node types including gate and join", () => {
    const snapshot = {
      schemaVersion: 1,
      id: "routing",
      name: "Routing",
      graph: {
        nodes: [
          { id: "start", type: "start", name: "Start", supervise: "default", env: [], params: [] },
          {
            id: "gate",
            type: "gate",
            name: "Gate",
            supervise: "default",
            env: [],
            branches: [
              { id: "yes", when: "go" },
              { id: "no", otherwise: true },
            ],
          },
          {
            id: "join",
            type: "join",
            name: "Join",
            supervise: "default",
            env: [],
            mode: "all",
            inputs: ["yes", "no"],
          },
          {
            id: "end",
            type: "end",
            name: "End",
            supervise: "default",
            env: [],
            status: "success",
            result: "{}",
          },
        ],
        edges: [
          { id: "e1", from: "start", to: "gate" },
          { id: "e2", from: "gate.yes", to: "join.yes" },
          { id: "e3", from: "gate.no", to: "join.no" },
          { id: "e4", from: "join", to: "end" },
        ],
      },
    };
    const parsed = normalizedWorkflowSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
