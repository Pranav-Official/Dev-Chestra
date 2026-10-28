import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
import { createDecisionClient, resetDecisionSemaphores } from "../src/client.js";
import type { DecisionRequest } from "../src/types.js";

const ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};

function booleanReq(provider: DecisionRequest["provider"]): DecisionRequest {
  return {
    provider,
    state: "hello",
    question: { kind: "boolean", instructions: "Is it ready?" },
  };
}

let standin: StandinHandle;

beforeAll(async () => {
  standin = await startStandin();
});

afterAll(async () => {
  await standin.close();
});

describe("decision integration via loopback stand-in", () => {
  it("posts the golden jev body and normalizes the bare answer", async () => {
    standin.clear();
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(result.ok).toBe(true);
    const recorded = standin.requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.path).toBe("/v1/systemone");
    expect(recorded[0]?.headers.authorization).toBe("Bearer test-typesafe-key");
    expect(JSON.parse(recorded[0]?.bodyText ?? "")).toEqual({
      model: "jev-latest",
      state: "hello",
      questions: { q0: { type: "noul", instructions: "Is it ready?" } },
    });
    if (result.ok) {
      expect(result.value.output).toMatchObject({
        kind: "boolean",
        value: true,
        probability: 0.75,
        confidence: 0.75,
        confidenceSource: "derived",
        model: "jev-latest",
      });
    }
  });

  it("parses Cloudflare-wrapped answers and keeps the preset model in the path", async () => {
    standin.clear();
    const client = createDecisionClient("cloudflare-clef", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(
      {
        provider: "cloudflare-clef",
        model: "clef-2",
        state: "s",
        question: { kind: "boolean", instructions: "Ready?" },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const recorded = standin.requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.path).toBe(
      "/client/v4/accounts/test-cf-account/ai/run/@cf/cloudflare/clef",
    );
    expect(JSON.parse(recorded[0]?.bodyText ?? "").model).toBe("clef-2");
  });

  it("answers choice and score questions end to end", async () => {
    standin.clear();
    const client = createDecisionClient("cloudflare-clef-flash", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const choice = await client.ask(
      {
        provider: "cloudflare-clef-flash",
        state: "s",
        question: {
          kind: "choice",
          instructions: "Pick.",
          options: [{ value: "a" }, { value: "b", description: "Second" }],
        },
      },
      new AbortController().signal,
    );
    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.value.output.value).toBe("a");
      expect(choice.value.output.probabilities).toEqual({ a: 0.7, b: 0.3 });
    }
    const recorded = standin.lastRequest();
    expect(JSON.parse(recorded?.bodyText ?? "").questions).toEqual({
      q0: { type: "choice", instructions: "Pick.", criteria: { a: "a", b: "Second" } },
    });

    const score = await client.ask(
      {
        provider: "cloudflare-clef-flash",
        state: "s",
        question: {
          kind: "score",
          instructions: "Rate.",
          levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
        },
      },
      new AbortController().signal,
    );
    expect(score.ok).toBe(true);
    if (score.ok) {
      expect(score.value.output.value).toBe("mid");
      expect(score.value.output.probabilities).toEqual({ low: 0.2, mid: 0.6, high: 0.2 });
    }
  });

  it("surfaces refusals as null values, not transport errors", async () => {
    standin.clear();
    standin.setNext(["refusal-missing", "refusal-wrongtype"]);
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    for (let i = 0; i < 2; i += 1) {
      const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output.value).toBeNull();
        expect(result.value.output.confidence).toBeNull();
        expect(result.value.output.refusal).toBeDefined();
      }
    }
  });

  it("retries a 429 with Retry-After then succeeds", async () => {
    standin.clear();
    standin.setNext(["ratelimit"]);
    const sleeps: number[] = [];
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(standin.requests()).toHaveLength(2);
    expect(sleeps).toEqual([0]);
  });

  it("retries 5xx twice then succeeds", async () => {
    standin.clear();
    standin.setNext(["error-500", "error-500"]);
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(standin.requests()).toHaveLength(3);
  });

  it("maps slow, redirect, oversized, malformed and leaky failures without key material", async () => {
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });

    standin.clear();
    // F7b: a client-side timeout is never retried, so one slow attempt fails.
    standin.setNext(["slow"]);
    const slow = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      timeoutMs: 100,
      sleep: async () => undefined,
    });
    const timedOut = await slow.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.error.message).toMatch(/timed out/);
      expect(timedOut.error.message).not.toContain("test-typesafe-key");
    }
    expect(standin.requests()).toHaveLength(1);
    // Abandoned slow handlers still sleep server-side; drain before the next test.
    await standin.drain();

    standin.clear();
    standin.setNext(["redirect"]);
    const redirected = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(redirected.ok).toBe(false);
    if (!redirected.ok) {
      expect(redirected.error.message).toMatch(/redirect/i);
    }
    expect(standin.requests()).toHaveLength(1);

    for (const scenario of ["oversized", "malformed", "echo-key"] as const) {
      standin.clear();
      standin.setNext([scenario]);
      const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain("test-typesafe-key");
        expect(result.error.message).not.toContain("test-cf-token");
      }
    }
    standin.clear();
    standin.setNext(["echo-key"]);
    const leaked = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    if (!leaked.ok) {
      expect(leaked.error.message).toContain("[redacted]");
    }
  });

  it("times out a stalled body without retrying and releases the slot", async () => {
    resetDecisionSemaphores();
    standin.clear();
    standin.setNext(Array.from({ length: 8 }, () => "stall"));
    const stalled = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      timeoutMs: 100,
      sleep: async () => undefined,
    });
    const started = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        stalled.ask(booleanReq("typesafe-jev"), new AbortController().signal),
      ),
    );
    // The timeout stays active mid-body: all 8 fail fast instead of hanging.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcomes.every((r) => !r.ok)).toBe(true);
    if (!outcomes[0]?.ok) {
      expect(outcomes[0]?.error.message).toMatch(/timed out/);
    }
    // F7b: no retry after a client-side timeout, even mid-body.
    expect(standin.requests()).toHaveLength(8);
    // Every slot is released: a later question is answered, not queued forever.
    standin.clear();
    const live = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const next = await live.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(next.ok).toBe(true);
    resetDecisionSemaphores();
  });

  it("aborts a dripping body promptly and releases the slot", async () => {
    resetDecisionSemaphores();
    standin.clear();
    standin.setNext([{ scenario: "drip", delayMs: 50 }]);
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      timeoutMs: 10_000,
      sleep: async () => undefined,
    });
    const controller = new AbortController();
    const pending = client.ask(booleanReq("typesafe-jev"), controller.signal);
    // Wait until the server is actually dripping, so the abort lands mid-body.
    for (let i = 0; i < 200 && standin.requests().length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(standin.requests()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    controller.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_CANCELLED");
    }
    expect(standin.requests()).toHaveLength(1);
    await standin.drain();
    resetDecisionSemaphores();
  });

  it("rejects bad credentials with a key-free error", async () => {
    standin.clear();
    const client = createDecisionClient("typesafe-jev", {
      env: { ...ENV, TYPESAFE_API_KEY: "wrong-key" },
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(booleanReq("typesafe-jev"), new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.message).not.toContain("wrong-key");
    }
  });

  it("never hits the network for local limit violations", async () => {
    standin.clear();
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(
      {
        provider: "typesafe-jev",
        state: "s",
        question: {
          kind: "choice",
          instructions: "x",
          options: Array.from({ length: 256 }, (_, i) => ({ value: `v${i}` })),
        },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_VALIDATION");
    }
    expect(standin.requests()).toHaveLength(0);
  });

  it("caps concurrency at 8 against the live stand-in", async () => {
    resetDecisionSemaphores();
    standin.clear();
    standin.resetPeak();
    await standin.drain();
    standin.setNext(Array.from({ length: 12 }, () => ({ scenario: "slow", delayMs: 60 })));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        client.ask(booleanReq("typesafe-jev"), new AbortController().signal),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(standin.maxActive()).toBeLessThanOrEqual(8);
    resetDecisionSemaphores();
  });

  it("refuses a malformed Cloudflare account id locally without leaking it", async () => {
    standin.clear();
    const evil = "../../user/tokens/verify";
    const client = createDecisionClient("cloudflare-clef", {
      env: { ...ENV, CLOUDFLARE_ACCOUNT_ID: evil },
      dotenvPath: null,
      baseUrlOverride: standin.origin,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    expect(client.availability()).toEqual({ ready: false, missing: ["CLOUDFLARE_ACCOUNT_ID"] });
    const result = await client.ask(booleanReq("cloudflare-clef"), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(standin.requests()).toHaveLength(0);
    if (!result.ok) {
      expect(result.error.message).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(result.error.message).not.toContain(evil);
      expect(result.error.message).not.toContain("test-cf-token");
    }
  });
});
