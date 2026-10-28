import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
import { createDecisionClient } from "../src/client.js";
import type { DecisionRequest } from "../src/types.js";
import { summarizeResponseShape } from "../src/wire.js";

const ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};
const NEEDLES = ["test-typesafe-key", "test-cf-token", "test-cf-account"];

let standin: StandinHandle;

beforeAll(async () => {
  standin = await startStandin();
});

afterAll(async () => {
  await standin.close();
});

function clientFor(provider: DecisionRequest["provider"]): ReturnType<typeof createDecisionClient> {
  return createDecisionClient(provider, {
    env: ENV,
    dotenvPath: null,
    baseUrlOverride: standin.origin,
    jitterRatio: 0,
    sleep: async () => undefined,
  });
}

describe("response shape summary against the stand-in", () => {
  it("summarizes a bare Jev answer without confidence", async () => {
    standin.clear();
    const report = await clientFor("typesafe-jev").test(new AbortController().signal);
    expect(report.ok).toBe(true);
    expect(report.resolvedModel).toBe("jev-latest");
    expect(report.shape).toMatchObject({
      wrappedInResult: false,
      hasConfidence: false,
      hasProbabilities: false,
      hasUsage: true,
    });
    expect(report.shape?.topLevelKeys).toEqual(expect.arrayContaining(["model", "answers"]));
    expect(report.shape?.answerKeys).toEqual(expect.arrayContaining(["type", "noul"]));
    expect(report.shape?.answerValueTypes).toMatchObject({ type: "string", noul: "number" });
    expect(JSON.stringify(report)).not.toContain("0.75");
    for (const needle of NEEDLES) {
      expect(JSON.stringify(report)).not.toContain(needle);
    }
  });

  it("summarizes a Cloudflare-wrapped answer", async () => {
    standin.clear();
    const report = await clientFor("cloudflare-clef").test(new AbortController().signal);
    expect(report.ok).toBe(true);
    expect(report.shape).toMatchObject({
      wrappedInResult: true,
      hasConfidence: false,
      hasUsage: true,
    });
    expect(report.shape?.topLevelKeys).toEqual(
      expect.arrayContaining(["result", "success", "errors", "messages"]),
    );
    expect(report.shape?.answerKeys).toEqual(expect.arrayContaining(["type", "noul"]));
  });

  it("reports probabilities without provider confidence for a choice answer", async () => {
    standin.clear();
    const client = clientFor("typesafe-jev");
    const result = await client.ask(
      {
        provider: "typesafe-jev",
        state: "hello",
        question: {
          kind: "choice",
          instructions: "Pick one.",
          options: [{ value: "a" }, { value: "b" }],
        },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output.confidenceSource).toBe("derived");
      expect(result.value.shape).toMatchObject({
        wrappedInResult: false,
        hasConfidence: false,
        hasProbabilities: true,
      });
      expect(result.value.shape?.answerValueTypes).toMatchObject({
        type: "string",
        choice: "string",
        probabilities: "object",
      });
    }
  });
});

describe("summarizeResponseShape bounds", () => {
  it("caps key counts and lengths and reports types only", () => {
    const answer: Record<string, unknown> = { type: "noul", noul: 0.5, extra: null, tags: [1] };
    const top: Record<string, unknown> = { model: "m", answers: { q0: answer } };
    for (let i = 0; i < 40; i += 1) {
      top[`k${i}`] = i;
    }
    const longKey = `x${"y".repeat(100)}`;
    top[longKey] = "secret-value";
    const shape = summarizeResponseShape({ ...top });
    expect(shape.topLevelKeys.length).toBeLessThanOrEqual(32);
    for (const key of shape.topLevelKeys) {
      expect(key.length).toBeLessThanOrEqual(64);
    }
    expect(shape.answerValueTypes).toMatchObject({
      type: "string",
      noul: "number",
      extra: "null",
      tags: "array",
    });
    expect(JSON.stringify(shape)).not.toContain("secret-value");
  });

  it("handles refusal and garbage bodies without values", () => {
    expect(summarizeResponseShape({ model: "m", answers: {} })).toMatchObject({
      wrappedInResult: false,
      answerKeys: [],
      hasConfidence: false,
      hasProbabilities: false,
      hasUsage: false,
    });
    expect(summarizeResponseShape(null).topLevelKeys).toEqual([]);
    expect(summarizeResponseShape("nope").answerKeys).toEqual([]);
  });
});
