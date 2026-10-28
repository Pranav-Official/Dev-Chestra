import { RelayError } from "@relay/core";
import { describe, expect, it } from "vitest";
import { DECISION_PRESETS } from "../src/presets.js";
import type { DecisionQuestion, DecisionRequest } from "../src/types.js";
import { buildDecisionBody, isValidModelOverride, parseDecisionPayload } from "../src/wire.js";

const booleanQ: DecisionQuestion = { kind: "boolean", instructions: "Is it ready?" };
const choiceQ: DecisionQuestion = {
  kind: "choice",
  instructions: "Pick one.",
  options: [{ value: "a", description: "First" }, { value: "b" }],
};
const scoreQ: DecisionQuestion = {
  kind: "score",
  instructions: "Rate it.",
  levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
};

describe("request body goldens", () => {
  it("builds the noul body for typesafe-jev", () => {
    expect(
      buildDecisionBody(
        { provider: "typesafe-jev", state: "hello", question: booleanQ },
        DECISION_PRESETS["typesafe-jev"],
      ),
    ).toEqual({
      model: "jev-latest",
      state: "hello",
      questions: { q0: { type: "noul", instructions: "Is it ready?" } },
    });
  });

  it("builds the choice body with description fallback", () => {
    expect(
      buildDecisionBody(
        { provider: "cloudflare-clef", state: { step: 1 }, question: choiceQ },
        DECISION_PRESETS["cloudflare-clef"],
      ),
    ).toEqual({
      model: "clef",
      state: { step: 1 },
      questions: {
        q0: { type: "choice", instructions: "Pick one.", criteria: { a: "First", b: "b" } },
      },
    });
  });

  it("builds the score body as an ordered label array", () => {
    expect(
      buildDecisionBody(
        { provider: "cloudflare-clef-flash", state: "s", question: scoreQ },
        DECISION_PRESETS["cloudflare-clef-flash"],
      ),
    ).toEqual({
      model: "clef-flash",
      state: "s",
      questions: {
        q0: { type: "score", instructions: "Rate it.", criteria: ["low", "mid", "high"] },
      },
    });
  });

  it("applies a valid model override to the body only", () => {
    const body = buildDecisionBody(
      { provider: "cloudflare-clef", model: "clef-2", state: "s", question: booleanQ },
      DECISION_PRESETS["cloudflare-clef"],
    );
    expect(body.model).toBe("clef-2");
    expect(isValidModelOverride("clef-2")).toBe(true);
    expect(isValidModelOverride("bad model!")).toBe(false);
    expect(() =>
      buildDecisionBody(
        { provider: "typesafe-jev", model: "../evil", state: "s", question: booleanQ },
        DECISION_PRESETS["typesafe-jev"],
      ),
    ).toThrowError(RelayError);
  });
});

describe("boolean normalization", () => {
  it("parses a bare noul answer", () => {
    const { output, usage } = parseDecisionPayload({
      payload: {
        model: "jev-latest",
        answers: { q0: { type: "noul", noul: 0.75 } },
        usage: { input_tokens: 12, output_tokens: 5 },
      },
      question: booleanQ,
      modelFallback: "jev-latest",
    });
    expect(output).toEqual({
      kind: "boolean",
      value: true,
      probability: 0.75,
      confidence: 0.75,
      confidenceSource: "derived",
      model: "jev-latest",
    });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it.each([
    [0.5, true, 0.5],
    [0.51, true, 0.51],
    [0.49, false, 0.51],
    [0, false, 1],
    [1, true, 1],
  ])("threshold p=%s -> value %s confidence %s", (p, value, confidence) => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { noul: p } } },
      question: booleanQ,
      modelFallback: "m",
    });
    expect(output.value).toBe(value);
    expect(output.confidence).toBeCloseTo(confidence, 10);
    expect(output.confidenceSource).toBe("derived");
  });

  it("accepts wrapped payloads and candidate field names", () => {
    const { output, usage } = parseDecisionPayload({
      payload: {
        result: { resolvedModel: "clef", answers: { q0: { pYes: 0.2 } } },
        success: true,
        errors: [],
        messages: [],
      },
      question: booleanQ,
      modelFallback: "clef",
    });
    expect(output.value).toBe(false);
    expect(output.probability).toBe(0.2);
    expect(output.model).toBe("clef");
    expect(usage).toBeUndefined();
  });
});

describe("choice normalization", () => {
  it("prefers provider confidence, else derives from probabilities", () => {
    const withProvider = parseDecisionPayload({
      payload: {
        answers: {
          q0: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.3 }, confidence: 0.9 },
        },
      },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(withProvider.output.confidence).toBe(0.9);
    expect(withProvider.output.confidenceSource).toBe("provider");

    const derived = parseDecisionPayload({
      payload: { answers: { q0: { choice: "b", probabilities: { a: 0.6, b: 0.3 } } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(derived.output).toMatchObject({
      kind: "choice",
      value: "b",
      confidence: 0.6,
      confidenceSource: "derived",
    });

    const none = parseDecisionPayload({
      payload: { answers: { q0: { selected: "a" } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(none.output.confidence).toBeNull();
    expect(none.output.confidenceSource).toBeNull();
    expect(none.output.probabilities).toBeUndefined();
  });

  it("keeps rounded probabilities exactly as sent", () => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { choice: "a", probabilities: { a: 0.33, b: 0.33 } } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(output.probabilities).toEqual({ a: 0.33, b: 0.33 });
    expect(output.confidence).toBe(0.33);
  });
});

describe("score normalization", () => {
  it("rounds the fractional score to a label and maps index probabilities", () => {
    const { output } = parseDecisionPayload({
      payload: {
        model: "clef",
        answers: {
          q0: { type: "score", score: 1.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.65 } },
        },
      },
      question: scoreQ,
      modelFallback: "clef",
    });
    expect(output.value).toBe("high");
    expect(output.score).toBe(1.6);
    expect(output.probabilities).toEqual({ low: 0.1, mid: 0.2, high: 0.65 });
    expect(output.confidence).toBe(0.65);
    expect(output.confidenceSource).toBe("derived");
  });

  it.each([
    [9.2, "high"],
    [1.5, "high"],
    [1.4, "mid"],
    [-0.7, "low"],
  ])("clamps score %s to label %s", (score, label) => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { rating: score, confidence: 0.4 } } },
      question: scoreQ,
      modelFallback: "m",
    });
    expect(output.value).toBe(label);
    expect(output.score).toBe(score);
    expect(output.confidence).toBe(0.4);
    expect(output.confidenceSource).toBe("provider");
  });

  it("yields null confidence without provider confidence or probabilities", () => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { score: 0 } } },
      question: scoreQ,
      modelFallback: "m",
    });
    expect(output.value).toBe("low");
    expect(output.confidence).toBeNull();
    expect(output.confidenceSource).toBeNull();
  });
});

describe("refusals", () => {
  it("refuses a missing q0 answer", () => {
    for (const payload of [{ answers: {} }, { model: "m" }, {}]) {
      const { output } = parseDecisionPayload({
        payload,
        question: booleanQ,
        modelFallback: "m",
      });
      expect(output).toMatchObject({
        kind: "boolean",
        value: null,
        confidence: null,
        confidenceSource: null,
      });
      expect(output.refusal?.reason).toMatch(/missing answer/);
    }
  });

  it("refuses a wrong-typed answer", () => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { type: "choice", choice: "a" } } },
      question: booleanQ,
      modelFallback: "m",
    });
    expect(output.value).toBeNull();
    expect(output.refusal?.reason).toMatch(/wrong answer type/);
  });
});

describe("local limits", () => {
  const jev = DECISION_PRESETS["typesafe-jev"];
  function expectValidation(fn: () => unknown): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).code).toBe("E_VALIDATION");
      return;
    }
    throw new Error("expected E_VALIDATION");
  }

  it("rejects option and level counts outside the allowed range", () => {
    const none: DecisionQuestion = { kind: "choice", instructions: "x", options: [] };
    expectValidation(() =>
      buildDecisionBody({ provider: "typesafe-jev", state: "s", question: none }, jev),
    );
    const many: DecisionQuestion = {
      kind: "choice",
      instructions: "x",
      options: Array.from({ length: 256 }, (_, i) => ({ value: `v${i}` })),
    };
    expectValidation(() =>
      buildDecisionBody({ provider: "typesafe-jev", state: "s", question: many }, jev),
    );
    const one: DecisionQuestion = { kind: "score", instructions: "x", levels: [{ label: "a" }] };
    expectValidation(() =>
      buildDecisionBody({ provider: "typesafe-jev", state: "s", question: one }, jev),
    );
    const eleven: DecisionQuestion = {
      kind: "score",
      instructions: "x",
      levels: Array.from({ length: 11 }, (_, i) => ({ label: `l${i}` })),
    };
    expectValidation(() =>
      buildDecisionBody({ provider: "typesafe-jev", state: "s", question: eleven }, jev),
    );
  });

  it("accepts boundary counts and rejects oversized state", () => {
    const maxOptions: DecisionQuestion = {
      kind: "choice",
      instructions: "x",
      options: Array.from({ length: 255 }, (_, i) => ({ value: `v${i}` })),
    };
    expect(
      buildDecisionBody({ provider: "typesafe-jev", state: "s", question: maxOptions }, jev).model,
    ).toBe("jev-latest");
    expectValidation(() =>
      buildDecisionBody(
        { provider: "typesafe-jev", state: "x".repeat(64 * 1024 + 1), question: booleanQ },
        jev,
      ),
    );
    expectValidation(() =>
      buildDecisionBody(
        {
          provider: "typesafe-jev",
          state: { n: 1n } as unknown as DecisionRequest["state"],
          question: booleanQ,
        },
        jev,
      ),
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectValidation(() =>
      buildDecisionBody(
        {
          provider: "typesafe-jev",
          state: circular as unknown as DecisionRequest["state"],
          question: booleanQ,
        },
        jev,
      ),
    );
  });
});
