import { describe, expect, it } from "vitest";
import {
  ApiClient,
  decisionProvidersResponseSchema,
  decisionTestRequestSchema,
  decisionTestResultSchema,
  eventEnvelopeSchema,
  execViewSchema,
  normalizedWorkflowSchema,
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

const TEST_BODY = {
  provider: "typesafe-jev" as const,
  state: '{"topic":"x"}',
  instructions: "Is this urgent?",
  mode: { kind: "boolean" as const },
};

describe("decision API", () => {
  it("lists decision providers and probes one question", async () => {
    const providers = [
      { id: "typesafe-jev", label: "Jev (TypeSafe AI)", ready: true, missing: [] },
      {
        id: "cloudflare-clef",
        label: "Clef (Cloudflare)",
        ready: false,
        missing: ["CLOUDFLARE_AUTH_TOKEN"],
      },
    ];
    const result = {
      output: {
        kind: "boolean",
        value: true,
        probability: 0.8,
        confidence: 0.8,
        confidenceSource: "derived",
        model: "jev-latest",
      },
      routing: { branch: "true", reason: "matched" },
      latencyMs: 42,
    };
    const { client, calls } = makeClient((call) =>
      response(new URL(call.url).pathname === "/api/decision-providers" ? providers : result),
    );
    await expect(client.listDecisionProviders()).resolves.toEqual(providers);
    await expect(client.testDecision("p1", TEST_BODY)).resolves.toEqual(result);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/decision-providers");
    const probe = calls[1];
    if (probe === undefined) throw new Error("fetch was not called");
    expect(probe.init.method).toBe("POST");
    expect(new URL(probe.url).pathname).toBe("/api/projects/p1/decisions/test");
    expect(new Headers(probe.init.headers).get("X-Relay-Csrf")).toBe("1");
  });

  it("validates provider ids and the 64 KiB state cap", () => {
    expect(decisionProvidersResponseSchema.safeParse([]).success).toBe(true);
    expect(
      decisionProvidersResponseSchema.safeParse([{ id: "nope", ready: true, missing: [] }]).success,
    ).toBe(false);
    expect(decisionTestRequestSchema.safeParse(TEST_BODY).success).toBe(true);
    expect(decisionTestRequestSchema.safeParse({ ...TEST_BODY, provider: "nope" }).success).toBe(
      false,
    );
    expect(
      decisionTestRequestSchema.safeParse({ ...TEST_BODY, state: "x".repeat(65 * 1024) }).success,
    ).toBe(false);
    expect(
      decisionTestResultSchema.safeParse({
        output: {
          kind: "choice",
          value: "a",
          confidence: null,
          confidenceSource: null,
          model: "clef",
        },
        routing: { branch: "uncertain", reason: "low_confidence" },
        latencyMs: 1,
      }).success,
    ).toBe(true);
  });

  it("parses extended decision events and the ExecView.decision field", () => {
    const requested = {
      id: 1,
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ts: new Date(0).toISOString(),
      path: "",
      actor: "engine",
      type: "decision.requested",
      v: 1,
      payload: {
        provider: "typesafe-jev",
        model: "jev-latest",
        questionIds: ["q0"],
        attempt: 1,
        generation: 1,
      },
    };
    expect(eventEnvelopeSchema.safeParse(requested).success).toBe(true);
    // Legacy answer without output still parses.
    const legacy = {
      ...requested,
      id: 2,
      type: "decision.answered",
      payload: { answers: [], latencyMs: 5 },
    };
    expect(eventEnvelopeSchema.safeParse(legacy).success).toBe(true);
    const answered = {
      ...requested,
      id: 3,
      type: "decision.answered",
      payload: {
        output: {
          kind: "score",
          value: "high",
          score: 1.8,
          confidence: null,
          confidenceSource: null,
          model: "clef",
        },
        routing: { branch: "top", reason: "matched" },
        usage: { inputTokens: 10, outputTokens: 5 },
        attempt: 1,
        generation: 1,
      },
    };
    expect(eventEnvelopeSchema.safeParse(answered).success).toBe(true);
    // ExecView accepts the decision projection (and legacy views without it).
    const base = {
      path: "",
      nodeId: "d",
      status: "succeeded",
      attempt: 1,
      generation: 1,
      kind: "decision",
      requiresAcceptedResult: false,
      acceptedResult: null,
      recordedOutput: null,
      processSpawned: null,
      processStopped: null,
      workspaceFinalized: null,
      validationAttempts: 0,
      crashAttempts: 0,
      mode: null,
      cli: null,
      sessionId: null,
      sessionCwd: null,
      model: null,
      resolvedConfigHash: null,
      inputsHash: null,
      startedAt: null,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      attemptTokensIn: 0,
      attemptTokensOut: 0,
      attemptCostUsd: 0,
      workspaceDir: null,
      branch: null,
      workspaceCommitted: null,
      lastValidationErrors: [],
      lastTranscript: null,
      lastError: null,
      gateDecision: null,
      joinResolution: null,
    };
    expect(execViewSchema.safeParse(base).success).toBe(true);
    expect(
      execViewSchema.safeParse({
        ...base,
        decision: {
          output: {
            kind: "boolean",
            value: true,
            probability: 0.9,
            confidence: 0.9,
            confidenceSource: "derived",
            model: "jev-latest",
          },
          routing: { branch: "true", reason: "matched" },
          eventId: 9,
        },
      }).success,
    ).toBe(true);
    // Normalized decision node validates in the workflow snapshot union.
    expect(
      normalizedWorkflowSchema.safeParse({
        schemaVersion: 1,
        id: "w",
        name: "W",
        graph: {
          nodes: [
            {
              id: "d",
              name: "D",
              supervise: "default",
              env: [],
              type: "decision",
              provider: "typesafe-jev",
              state: "x",
              instructions: "pick",
              mode: { kind: "boolean" },
              onError: "fail",
            },
          ],
          edges: [],
        },
      }).success,
    ).toBe(true);
  });
});
