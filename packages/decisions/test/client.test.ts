import { RelayError } from "@relay/core";
import { describe, expect, it } from "vitest";
import {
  createDecisionClient,
  createDecisionService,
  resetDecisionSemaphores,
} from "../src/client.js";
import type { DecisionRequest } from "../src/types.js";

const ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};

const BOOLEAN_REQ: DecisionRequest = {
  provider: "typesafe-jev",
  state: "hello",
  question: { kind: "boolean", instructions: "Is it ready?" },
};

type FetchInput = Parameters<typeof fetch>[0];

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (call: Call, calls: Call[]) => Promise<Response>): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: FetchInput, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    // Mirror real fetch: reject when the caller aborts mid-flight.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
      handler(call, calls).then(resolve, reject);
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return headers === undefined
    ? new Response(JSON.stringify(payload), { status })
    : new Response(JSON.stringify(payload), { status, headers });
}

function okPayload() {
  return {
    model: "jev-latest",
    answers: { q0: { type: "noul", noul: 0.8 } },
    usage: { input_tokens: 12, output_tokens: 5 },
  };
}

describe("decision client ask", () => {
  it("posts the exact wire body with bearer auth and parses the answer", async () => {
    const { calls, fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-typesafe-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: "jev-latest",
      state: "hello",
      questions: { q0: { type: "noul", instructions: "Is it ready?" } },
    });
    if (result.ok) {
      expect(result.value.output).toMatchObject({
        kind: "boolean",
        value: true,
        probability: 0.8,
        confidence: 0.8,
        confidenceSource: "derived",
        model: "jev-latest",
      });
      expect(result.value.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
      expect(typeof result.value.latencyMs).toBe("number");
      expect(JSON.stringify(result.value)).not.toContain("test-typesafe-key");
    }
  });

  it("substitutes the Cloudflare account id and keeps the preset model in the path", async () => {
    const { calls, fetchImpl } = stubFetch(async () =>
      jsonResponse({ answers: { q0: { noul: 0.1 } } }),
    );
    const client = createDecisionClient("cloudflare-clef", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
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
    const call = calls[0] as Call;
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-cf-account/ai/run/@cf/cloudflare/clef",
    );
    expect(JSON.parse(call.init.body as string).model).toBe("clef-2");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer test-cf-token");
  });

  it("keeps the preset path under a loopback base-URL override", async () => {
    const { calls, fetchImpl } = stubFetch(async () =>
      jsonResponse({ answers: { q0: { noul: 1 } } }),
    );
    const client = createDecisionClient("cloudflare-clef-flash", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      baseUrlOverride: "http://127.0.0.1:9",
    });
    const result = await client.ask(
      {
        provider: "cloudflare-clef-flash",
        state: "s",
        question: { kind: "boolean", instructions: "Ready?" },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect((calls[0] as Call).url).toBe(
      "http://127.0.0.1:9/client/v4/accounts/test-cf-account/ai/run/@cf/cloudflare/clef-flash",
    );
  });

  it("fails closed on missing secrets without touching the network", async () => {
    const { calls, fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    const client = createDecisionClient("typesafe-jev", {
      env: {},
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.message).toContain("TYPESAFE_API_KEY");
      expect(result.error.message).not.toContain("test-typesafe-key");
    }
  });

  it("fails local limits before the network", async () => {
    const { calls, fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const bad: DecisionRequest = {
      provider: "typesafe-jev",
      state: "s",
      question: {
        kind: "choice",
        instructions: "x",
        options: Array.from({ length: 256 }, (_, i) => ({ value: `v${i}` })),
      },
    };
    const result = await client.ask(bad, new AbortController().signal);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_VALIDATION");
    }
    const mismatch = await client.ask(
      { ...BOOLEAN_REQ, provider: "cloudflare-clef" },
      new AbortController().signal,
    );
    expect(mismatch.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses non-loopback http and non-loopback overrides without network use", async () => {
    const { calls, fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    for (const baseUrlOverride of ["http://example.com", "https://example.com"]) {
      const client = createDecisionClient("typesafe-jev", {
        env: ENV,
        dotenvPath: null,
        fetchImpl,
        jitterRatio: 0,
        baseUrlOverride,
      });
      const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("E_VALIDATION");
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("retries 5xx twice with the 500/1500 ms schedule", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { calls, fetchImpl } = stubFetch(async () => {
      n += 1;
      return n < 3 ? new Response("boom", { status: 500 }) : jsonResponse(okPayload());
    });
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1500]);
  });

  it("honors Retry-After, else waits 1 s then 3 s on 429", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { calls, fetchImpl } = stubFetch(async () => {
      n += 1;
      if (n === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      return n === 2 ? new Response("slow down", { status: 429 }) : jsonResponse(okPayload());
    });
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([0, 3000]);
  });

  it("gives up after 2 retries on persistent 5xx", async () => {
    const { calls, fetchImpl } = stubFetch(async () => new Response("down", { status: 503 }));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      sleep: async () => undefined,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("does not retry 4xx and truncates plus redacts the provider message", async () => {
    const longMessage = `bad request using test-typesafe-key ${"x".repeat(2000)}`;
    const { calls, fetchImpl } = stubFetch(async () =>
      jsonResponse({ error: { message: longMessage } }, 400),
    );
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.message).not.toContain("test-typesafe-key");
      expect(result.error.message).toContain("[redacted]");
      const afterPrefix = result.error.message.split(": ").slice(1).join(": ");
      expect(afterPrefix.length).toBeLessThanOrEqual(500);
    }
  });

  it("treats redirect rejections and 3xx as refused without retry", async () => {
    const { calls, fetchImpl } = stubFetch(async () => {
      // Same shape undici produces for `redirect: "error"`.
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!result.ok) {
      expect(result.error.message).toMatch(/redirect/i);
    }

    const moved = stubFetch(async () => new Response("", { status: 302 }));
    const movedClient = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl: moved.fetchImpl,
      jitterRatio: 0,
    });
    const movedResult = await movedClient.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(moved.calls).toHaveLength(1);
    expect(movedResult.ok).toBe(false);
  });

  it("times out slow providers", async () => {
    const { calls, fetchImpl } = stubFetch(() => new Promise<Response>(() => undefined));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      timeoutMs: 40,
      sleep: async () => undefined,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(false);
    // F7b: a client-side timeout is never retried (each attempt may bill again).
    expect(calls).toHaveLength(1);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.message).toMatch(/timed out/);
    }
  });

  it("fails fast on a Retry-After above the 10 s cap without sleeping", async () => {
    const sleeps: number[] = [];
    const { calls, fetchImpl } = stubFetch(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "86400" } }),
    );
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PROVIDER");
      expect(result.error.message).toContain("typesafe-jev");
      expect(result.error.message).toContain("86400000");
    }
  });

  it("cuts a retry sleep short on abort", async () => {
    // Retry-After 5 s is under the 10 s cap, so the client really sleeps.
    const { calls, fetchImpl } = stubFetch(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }),
    );
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
      sleep: () => new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    const pending = client.ask(BOOLEAN_REQ, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!result.ok) {
      expect(result.error.code).toBe("E_CANCELLED");
    }
  });

  it("rejects queued waiters on abort without breaking the slot queue", async () => {
    resetDecisionSemaphores();
    const releaseAll: Array<() => void> = [];
    const { fetchImpl } = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          releaseAll.push(() => resolve(jsonResponse(okPayload())));
        }),
    );
    const askWith = (signal: AbortSignal) =>
      createDecisionClient("typesafe-jev", {
        env: ENV,
        dotenvPath: null,
        fetchImpl,
        jitterRatio: 0,
      }).ask(BOOLEAN_REQ, signal);
    const holders = Array.from({ length: 8 }, () => askWith(new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 25));
    // An already-aborted signal never enters the queue.
    const preAborted = new AbortController();
    preAborted.abort();
    const refused = await askWith(preAborted.signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("E_CANCELLED");
    }
    // An abort while queued rejects promptly and removes the waiter.
    const midWait = new AbortController();
    const queued = askWith(midWait.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    midWait.abort();
    const queuedResult = await queued;
    expect(queuedResult.ok).toBe(false);
    if (!queuedResult.ok) {
      expect(queuedResult.error.code).toBe("E_CANCELLED");
    }
    while (releaseAll.length > 0) {
      (releaseAll.shift() as () => void)();
    }
    const results = await Promise.all(holders);
    expect(results.every((r) => r.ok)).toBe(true);
    resetDecisionSemaphores();
  });

  it("enforces the response size cap and JSON-only bodies", async () => {
    const capped = stubFetch(async () => new Response(`{"a":"${"y".repeat(500)}"}`));
    const cappedClient = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl: capped.fetchImpl,
      jitterRatio: 0,
      maxResponseBytes: 100,
    });
    const cappedResult = await cappedClient.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(cappedResult.ok).toBe(false);
    if (!cappedResult.ok) {
      expect(cappedResult.error.message).toMatch(/byte cap/);
      expect(cappedResult.error.message).not.toContain("test-typesafe-key");
    }

    const malformed = stubFetch(async () => new Response("not-json{{{"));
    const malformedClient = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl: malformed.fetchImpl,
      jitterRatio: 0,
    });
    const malformedResult = await malformedClient.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) {
      expect(malformedResult.error.message).toMatch(/invalid JSON/);
    }
  });

  it("maps an aborted signal to E_CANCELLED without network use", async () => {
    const { calls, fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await client.ask(BOOLEAN_REQ, controller.signal);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_CANCELLED");
    }
  });

  it("caps concurrency at 8 per provider", async () => {
    resetDecisionSemaphores();
    let active = 0;
    let peak = 0;
    const releaseAll: Array<() => void> = [];
    const { fetchImpl } = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releaseAll.push(() => {
            active -= 1;
            resolve(jsonResponse(okPayload()));
          });
        }),
    );
    const client = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const pending = Array.from({ length: 12 }, () =>
      client.ask(BOOLEAN_REQ, new AbortController().signal),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(peak).toBeLessThanOrEqual(8);
    while (releaseAll.length > 0) {
      const release = releaseAll.shift() as () => void;
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const results = await Promise.all(pending);
    expect(peak).toBe(8);
    expect(results.every((r) => r.ok)).toBe(true);
    resetDecisionSemaphores();
  });

  it("reports availability and probes reachability without leaking keys", async () => {
    const ready = createDecisionClient("cloudflare-clef", { env: ENV, dotenvPath: null });
    expect(ready.availability()).toEqual({ ready: true, missing: [] });
    const missing = createDecisionClient("cloudflare-clef", { env: {}, dotenvPath: null });
    expect(missing.availability()).toEqual({
      ready: false,
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
    });

    const { fetchImpl } = stubFetch(async () => jsonResponse({ answers: { q0: { noul: 0.9 } } }));
    const probing = createDecisionClient("typesafe-jev", {
      env: ENV,
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const report = await probing.test(new AbortController().signal);
    expect(report.ok).toBe(true);
    expect(report.provider).toBe("typesafe-jev");
    expect(JSON.stringify(report)).not.toContain("test-typesafe-key");

    const failing = createDecisionClient("typesafe-jev", {
      env: {},
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const failed = await failing.test(new AbortController().signal);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("TYPESAFE_API_KEY");
    expect(failed.error).not.toContain("test-typesafe-key");

    expect(
      createDecisionService({ env: ENV, dotenvPath: null }).client("typesafe-jev"),
    ).toBeDefined();
  });
});

describe("error codes", () => {
  it("uses only catalogued codes without inventing new ones", async () => {
    const { fetchImpl } = stubFetch(async () => jsonResponse(okPayload()));
    const client = createDecisionClient("typesafe-jev", {
      env: {},
      dotenvPath: null,
      fetchImpl,
      jitterRatio: 0,
    });
    const result = await client.ask(BOOLEAN_REQ, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RelayError);
      expect(result.error.code).toBe("E_PROVIDER");
    }
  });
});
