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

describe("provider-controlled bounds (F6)", () => {
  it("refuses a choice outside the declared options", () => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { type: "choice", choice: "zzz", probabilities: { zzz: 0.9 } } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(output.value).toBeNull();
    expect(output.refusal?.reason).toMatch(/unknown option/);
  });

  it("keeps only declared probability keys with values in [0,1]", () => {
    const { output } = parseDecisionPayload({
      payload: {
        answers: {
          q0: { choice: "a", probabilities: { a: 0.6, b: 1.4, evil: 0.9, neg: -0.1 } },
        },
      },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(output.value).toBe("a");
    expect(output.probabilities).toEqual({ a: 0.6 });
    expect(output.confidence).toBe(0.6);
    expect(output.confidenceSource).toBe("derived");
  });

  it("treats out-of-range or non-finite confidence as absent", () => {
    for (const confidence of [5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { output } = parseDecisionPayload({
        payload: {
          answers: { q0: { choice: "a", probabilities: { a: 0.6, b: 0.3 }, confidence } },
        },
        question: choiceQ,
        modelFallback: "m",
      });
      expect(output.confidence).toBe(0.6);
      expect(output.confidenceSource).toBe("derived");
    }
    const none = parseDecisionPayload({
      payload: { answers: { q0: { choice: "a", confidence: 5 } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(none.output.confidence).toBeNull();
    expect(none.output.confidenceSource).toBeNull();
    expect(none.output.probabilities).toBeUndefined();
  });

  it("falls back to the preset model when the provider model is empty or missing", () => {
    for (const model of ["", undefined]) {
      const { output } = parseDecisionPayload({
        payload: { model, answers: { q0: { noul: 0.8 } } },
        question: booleanQ,
        modelFallback: "jev-latest",
      });
      expect(output.model).toBe("jev-latest");
      expect(output.value).toBe(true);
    }
  });

  it("truncates provider-controlled refusal reasons to 500 chars", () => {
    const { output } = parseDecisionPayload({
      payload: { answers: { q0: { type: "choice", choice: `evil-${"x".repeat(2000)}` } } },
      question: choiceQ,
      modelFallback: "m",
    });
    expect(output.value).toBeNull();
    expect(output.refusal?.reason?.length).toBeLessThanOrEqual(500);
  });
});

describe("Cloudflare failure envelopes (F8)", () => {
  it("returns E_PROVIDER on success:false instead of a refusal", () => {
    expect(() =>
      parseDecisionPayload({
        payload: {
          result: null,
          success: false,
          errors: [{ message: "model overheated" }],
          messages: [],
        },
        question: booleanQ,
        modelFallback: "m",
      }),
    ).toThrowError(/model overheated/);
    try {
      parseDecisionPayload({
        payload: { result: null, success: false, errors: ["boom"], messages: [] },
        question: booleanQ,
        modelFallback: "m",
      });
      throw new Error("expected E_PROVIDER");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).code).toBe("E_PROVIDER");
    }
  });

  it("returns E_PROVIDER on errors without a result even when success is unset", () => {
    expect(() =>
      parseDecisionPayload({
        payload: { errors: [{ message: "bad gateway" }] },
        question: booleanQ,
        modelFallback: "m",
      }),
    ).toThrowError(/bad gateway/);
  });

  it("still parses a successful wrapped answer and truncates long error text", () => {
    const { output } = parseDecisionPayload({
      payload: {
        result: { model: "c", answers: { q0: { noul: 0.1 } } },
        success: true,
        errors: [],
        messages: [],
      },
      question: booleanQ,
      modelFallback: "m",
    });
    expect(output.value).toBe(false);
    try {
      parseDecisionPayload({
        payload: { result: null, success: false, errors: [`e-${"x".repeat(2000)}`], messages: [] },
        question: booleanQ,
        modelFallback: "m",
      });
      throw new Error("expected E_PROVIDER");
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual(500 + 100);
    }
  });
});

describe("prototype edge cases (F9)", () => {
  it("keeps a __proto__ option as an own criteria key through JSON", () => {
    const request: DecisionRequest = {
      provider: "typesafe-jev",
      state: "s",
      question: {
        kind: "choice",
        instructions: "Pick.",
        options: [{ value: "__proto__" }, { value: "a" }],
      },
    };
    const body = buildDecisionBody(request, DECISION_PRESETS["typesafe-jev"]);
    const q0 = body.questions.q0;
    if (q0.type !== "choice") throw new Error("expected a choice body");
    expect(Object.hasOwn(q0.criteria, "__proto__")).toBe(true);
    // NB: a `__proto__` literal key would set the prototype, not an own
    // property; the computed key asserts the real own-property round trip.
    expect(JSON.parse(JSON.stringify(body)).questions.q0.criteria).toEqual({
      ["__proto__"]: "__proto__",
      a: "a",
    });
  });

  it("reads a constructor-labelled score without inherited members or NaN", () => {
    const trickyQ: DecisionQuestion = {
      kind: "score",
      instructions: "Rate.",
      levels: [{ label: "constructor" }, { label: "toString" }],
    };
    const { output } = parseDecisionPayload({
      payload: {
        answers: {
          q0: {
            score: 0.2,
            probabilities: { 0: 0.7, 1: 0.2 },
            confidence: 0.7,
          },
        },
      },
      question: trickyQ,
      modelFallback: "m",
    });
    expect(output.value).toBe("constructor");
    expect(output.probabilities).toEqual({ constructor: 0.7, toString: 0.2 });
    expect(output.confidence).toBe(0.7);
    expect(Number.isNaN(output.confidence)).toBe(false);
  });

  it("ignores undeclared probability keys on objects with prototype members", () => {
    const { output } = parseDecisionPayload({
      payload: {
        answers: {
          // No declared key matches, and `constructor` must not resolve to
          // Object.prototype.constructor as a confidence candidate.
          q0: { score: 0, probabilities: { constructor: 0.5 } },
        },
      },
      question: scoreQ,
      modelFallback: "m",
    });
    expect(output.probabilities).toBeUndefined();
    expect(output.confidence).toBeNull();
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
