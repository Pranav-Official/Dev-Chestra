import { describe, expect, it } from "vitest";
import type { DecisionOutputLike } from "../src/decision-route.js";
import {
  type DecisionMode,
  type DecisionNode,
  decisionHandles,
  routeDecision,
} from "../src/index.js";

const booleanMode: DecisionMode = { kind: "boolean" };
const customBoolean: DecisionMode = { kind: "boolean", trueAt: 0.7, falseAt: 0.3 };

const choiceMode: DecisionMode = {
  kind: "choice",
  options: [{ value: "a" }, { value: "b" }, { value: "c" }],
  branches: [
    { id: "first", values: ["a", "b"] },
    { id: "second", values: ["c"] },
  ],
};

const confidentChoice: DecisionMode = { ...choiceMode, minConfidence: 0.6 };

const scoreMode: DecisionMode = {
  kind: "score",
  levels: [{ label: "low" }, { label: "mid" }, { label: "high" }],
  bands: [
    { id: "top", atLeast: 1.5 },
    { id: "floor", atLeast: null },
  ],
};

const confidentScore: DecisionMode = { ...scoreMode, minConfidence: 0.6 };

function out(
  partial: Partial<DecisionOutputLike> & Pick<DecisionOutputLike, "kind" | "value">,
): DecisionOutputLike {
  return { confidence: null, ...partial };
}

interface Row {
  name: string;
  mode: DecisionMode;
  output: DecisionOutputLike;
  branch: string | null;
  reason: "matched" | "low_confidence" | "refused";
}

const rows: Row[] = [
  // refusals
  {
    name: "refusal flag routes uncertain even with a value",
    mode: booleanMode,
    output: out({ kind: "boolean", value: true, probability: 0.9, refusal: {} }),
    branch: "uncertain",
    reason: "refused",
  },
  {
    name: "null value routes uncertain",
    mode: choiceMode,
    output: out({ kind: "choice", value: null }),
    branch: "uncertain",
    reason: "refused",
  },
  // boolean
  {
    name: "boolean p exactly 0.5 matches true (check true first)",
    mode: booleanMode,
    output: out({ kind: "boolean", value: true, probability: 0.5 }),
    branch: "true",
    reason: "matched",
  },
  {
    name: "boolean p above trueAt matches true",
    mode: customBoolean,
    output: out({ kind: "boolean", value: true, probability: 0.8 }),
    branch: "true",
    reason: "matched",
  },
  {
    name: "boolean p exactly trueAt matches true",
    mode: customBoolean,
    output: out({ kind: "boolean", value: true, probability: 0.7 }),
    branch: "true",
    reason: "matched",
  },
  {
    name: "boolean p exactly falseAt matches false",
    mode: customBoolean,
    output: out({ kind: "boolean", value: false, probability: 0.3 }),
    branch: "false",
    reason: "matched",
  },
  {
    name: "boolean p between thresholds is uncertain",
    mode: customBoolean,
    output: out({ kind: "boolean", value: false, probability: 0.5 }),
    branch: "uncertain",
    reason: "low_confidence",
  },
  {
    name: "boolean p 0 matches false at default thresholds",
    mode: booleanMode,
    output: out({ kind: "boolean", value: false, probability: 0 }),
    branch: "false",
    reason: "matched",
  },
  // choice
  {
    name: "choice value routes to its branch",
    mode: choiceMode,
    output: out({ kind: "choice", value: "b" }),
    branch: "first",
    reason: "matched",
  },
  {
    name: "choice unknown value refuses",
    mode: choiceMode,
    output: out({ kind: "choice", value: "zzz" }),
    branch: "uncertain",
    reason: "refused",
  },
  {
    name: "choice confidence above min matches",
    mode: confidentChoice,
    output: out({ kind: "choice", value: "c", confidence: 0.9 }),
    branch: "second",
    reason: "matched",
  },
  {
    name: "choice confidence below min is low_confidence",
    mode: confidentChoice,
    output: out({ kind: "choice", value: "c", confidence: 0.2 }),
    branch: "uncertain",
    reason: "low_confidence",
  },
  {
    name: "choice null confidence with minConfidence is low_confidence",
    mode: confidentChoice,
    output: out({ kind: "choice", value: "a", confidence: null, probabilities: {} }),
    branch: "uncertain",
    reason: "low_confidence",
  },
  {
    name: "choice derived confidence from max probability matches",
    mode: confidentChoice,
    output: out({
      kind: "choice",
      value: "a",
      confidence: null,
      probabilities: { a: 0.8, b: 0.1, c: 0.1 },
    }),
    branch: "first",
    reason: "matched",
  },
  // score
  {
    name: "score above band atLeast matches first band",
    mode: scoreMode,
    output: out({ kind: "score", value: "high", score: 1.8 }),
    branch: "top",
    reason: "matched",
  },
  {
    name: "score exactly atLeast matches that band",
    mode: scoreMode,
    output: out({ kind: "score", value: "mid", score: 1.5 }),
    branch: "top",
    reason: "matched",
  },
  {
    name: "score below atLeast falls to floor",
    mode: scoreMode,
    output: out({ kind: "score", value: "low", score: 0.2 }),
    branch: "floor",
    reason: "matched",
  },
  {
    name: "score confidence below min is low_confidence",
    mode: confidentScore,
    output: out({ kind: "score", value: "high", score: 1.9, confidence: 0.1 }),
    branch: "uncertain",
    reason: "low_confidence",
  },
  {
    name: "score null confidence with minConfidence is low_confidence",
    mode: confidentScore,
    output: out({ kind: "score", value: "high", score: 1.9, confidence: null }),
    branch: "uncertain",
    reason: "low_confidence",
  },
];

describe("routeDecision", () => {
  for (const row of rows) {
    it(row.name, () => {
      expect(routeDecision(row.mode, row.output)).toEqual({
        branch: row.branch,
        reason: row.reason,
      });
    });
  }
});

function decisionNode(mode: DecisionMode): DecisionNode {
  return {
    id: "d",
    type: "decision",
    name: "D",
    provider: "typesafe-jev",
    state: "hello",
    instructions: "pick one",
    mode,
    onError: "fail",
  };
}

describe("decisionHandles", () => {
  it("lists boolean handles", () => {
    expect(decisionHandles(decisionNode(booleanMode))).toEqual(["true", "false", "uncertain"]);
  });
  it("lists choice branch handles plus uncertain", () => {
    expect(decisionHandles(decisionNode(choiceMode))).toEqual(["first", "second", "uncertain"]);
  });
  it("lists score band handles plus uncertain", () => {
    expect(decisionHandles(decisionNode(scoreMode))).toEqual(["top", "floor", "uncertain"]);
  });
});
