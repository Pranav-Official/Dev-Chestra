import type { JsonValue } from "@relay/core";
import { RelayError } from "@relay/core";
import type { DecisionPreset } from "./presets.js";
import type {
  DecisionOutput,
  DecisionQuestion,
  DecisionRequest,
  DecisionUsage,
  ResponseShapeSummary,
} from "./types.js";

/** Local limits checked before anything reaches the network (contract §7). */
export const MAX_STATE_BYTES = 64 * 1024;
export const MIN_CHOICE_OPTIONS = 1;
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/** Contract §1: node model override pattern. */
export const MODEL_OVERRIDE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidModelOverride(value: string): boolean {
  return MODEL_OVERRIDE_PATTERN.test(value);
}

export type WireQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DecisionWireBody {
  model: string;
  state: string | JsonValue;
  questions: { q0: WireQuestion };
}

/** Resolve the body `model`: preset default, or a valid override. */
export function resolveBodyModel(preset: DecisionPreset, override?: string): string {
  if (override === undefined) {
    return preset.bodyModel;
  }
  if (!isValidModelOverride(override)) {
    throw new RelayError(
      "E_VALIDATION",
      `Invalid model override ${JSON.stringify(override)}: must match ${String(MODEL_OVERRIDE_PATTERN)}.`,
    );
  }
  return override;
}

function stateSizeBytes(state: string | JsonValue): number {
  if (typeof state === "string") {
    return Buffer.byteLength(state, "utf8");
  }
  let json: string;
  try {
    json = JSON.stringify(state) ?? "null";
  } catch {
    throw new RelayError("E_VALIDATION", "Decision state is not JSON-serializable.");
  }
  return Buffer.byteLength(json, "utf8");
}

function checkLocalLimits(question: DecisionQuestion, state: string | JsonValue): void {
  if (question.kind === "choice") {
    const n = question.options.length;
    if (n < MIN_CHOICE_OPTIONS || n > MAX_CHOICE_OPTIONS) {
      throw new RelayError(
        "E_VALIDATION",
        `Decision choice options must be ${MIN_CHOICE_OPTIONS}..${MAX_CHOICE_OPTIONS}, got ${n}.`,
      );
    }
  }
  if (question.kind === "score") {
    const n = question.levels.length;
    if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) {
      throw new RelayError(
        "E_VALIDATION",
        `Decision score levels must be ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS}, got ${n}.`,
      );
    }
  }
  const size = stateSizeBytes(state);
  if (size > MAX_STATE_BYTES) {
    throw new RelayError(
      "E_VALIDATION",
      `Decision state is ${size} bytes, above the ${MAX_STATE_BYTES} byte cap.`,
    );
  }
}

/**
 * Build the intersection request body (contract §1). Throws `E_VALIDATION`
 * before any network use when local limits or the model pattern fail.
 */
export function buildDecisionBody(req: DecisionRequest, preset: DecisionPreset): DecisionWireBody {
  checkLocalLimits(req.question, req.state);
  const model = resolveBodyModel(preset, req.model);
  const q = req.question;
  if (q.kind === "boolean") {
    return {
      model,
      state: req.state,
      questions: { q0: { type: "noul", instructions: q.instructions } },
    };
  }
  if (q.kind === "choice") {
    const criteria: Record<string, string> = {};
    for (const option of q.options) {
      criteria[option.value] = option.description ?? option.value;
    }
    return {
      model,
      state: req.state,
      questions: { q0: { type: "choice", instructions: q.instructions, criteria } },
    };
  }
  return {
    model,
    state: req.state,
    questions: {
      q0: {
        type: "score",
        instructions: q.instructions,
        criteria: q.levels.map((level) => level.label),
      },
    },
  };
}

// --- Response parsing ------------------------------------------------------
// The official REST response schema is unverified, so parsing is data-driven:
// each field is read from the first matching candidate name, and both bare
// payloads and Cloudflare `{ result }`-wrapped payloads are accepted.

const ANSWER_CONTAINER_KEYS = ["answers", "answer", "outputs", "output"];
const NOUL_KEYS = ["noul", "pYes", "p_yes", "yesProbability", "probability", "p"];
const CHOICE_KEYS = ["choice", "selected", "option", "label"];
const SCORE_KEYS = ["score", "rating", "level", "scoreValue"];
const PROBABILITY_MAP_KEYS = ["probabilities", "probs", "distribution"];
const CONFIDENCE_KEYS = ["confidence", "conf"];
const MODEL_KEYS = ["model", "resolvedModel", "modelName"];
const USAGE_CONTAINER_KEYS = ["usage", "tokenUsage", "tokens"];
const USAGE_INPUT_KEYS = ["input_tokens", "inputTokens", "input", "prompt_tokens"];
const USAGE_OUTPUT_KEYS = ["output_tokens", "outputTokens", "output", "completion_tokens"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function firstFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function firstRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function readProbabilities(answer: Record<string, unknown>): Record<string, number> | undefined {
  const map = firstRecord(answer, PROBABILITY_MAP_KEYS);
  if (map === undefined) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function maxProbability(probs: Record<string, number> | undefined): number | undefined {
  if (probs === undefined) {
    return undefined;
  }
  const values = Object.values(probs);
  return values.length === 0 ? undefined : Math.max(...values);
}

function providerConfidence(answer: Record<string, unknown>): number | undefined {
  return firstFiniteNumber(answer, CONFIDENCE_KEYS);
}

function clamp01(p: number): number {
  return Math.min(1, Math.max(0, p));
}

function refusal(kind: DecisionOutput["kind"], model: string, reason: string): DecisionOutput {
  return {
    kind,
    value: null,
    confidence: null,
    confidenceSource: null,
    refusal: { reason },
    model,
  };
}

export interface ParseDecisionPayloadArgs {
  payload: unknown;
  question: DecisionQuestion;
  modelFallback: string;
}

export interface ParsedDecisionPayload {
  output: DecisionOutput;
  usage?: DecisionUsage;
}

function withUsage(
  output: DecisionOutput,
  usage: DecisionUsage | undefined,
): ParsedDecisionPayload {
  return usage === undefined ? { output } : { output, usage };
}

function readUsage(inner: Record<string, unknown>): DecisionUsage | undefined {
  const container = firstRecord(inner, USAGE_CONTAINER_KEYS);
  if (container === undefined) {
    return undefined;
  }
  const inputTokens = firstFiniteNumber(container, USAGE_INPUT_KEYS);
  const outputTokens = firstFiniteNumber(container, USAGE_OUTPUT_KEYS);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens) };
}

/**
 * Parse a provider response into the normalized §4 answer. Accepts bare and
 * `{ result }`-wrapped payloads. A missing `q0` answer, or one of the wrong
 * type, is a provider refusal (value null), never a transport error.
 */
export function parseDecisionPayload(args: ParseDecisionPayloadArgs): ParsedDecisionPayload {
  const { question, modelFallback } = args;
  const top = isRecord(args.payload) ? args.payload : {};
  const inner =
    isRecord(top.result) && top.result !== top ? (top.result as Record<string, unknown>) : top;
  const model = firstString(inner, MODEL_KEYS) ?? firstString(top, MODEL_KEYS) ?? modelFallback;
  const usage = readUsage(inner) ?? readUsage(top);

  const container = firstRecord(inner, ANSWER_CONTAINER_KEYS);
  const answer = container !== undefined && isRecord(container.q0) ? container.q0 : undefined;
  if (answer === undefined) {
    return withUsage(refusal(questionKindOf(question), model, "missing answer for q0"), usage);
  }
  const declaredType = typeof answer.type === "string" ? answer.type : undefined;
  if (question.kind === "boolean") {
    if (
      (declaredType !== undefined && declaredType !== "noul") ||
      firstFiniteNumber(answer, NOUL_KEYS) === undefined
    ) {
      return withUsage(refusal("boolean", model, "wrong answer type for boolean question"), usage);
    }
    const p = clamp01(firstFiniteNumber(answer, NOUL_KEYS) as number);
    const output: DecisionOutput = {
      kind: "boolean",
      value: p >= 0.5,
      probability: p,
      confidence: Math.max(p, 1 - p),
      confidenceSource: "derived",
      model,
    };
    return withUsage(output, usage);
  }
  if (question.kind === "choice") {
    const choice = firstString(answer, CHOICE_KEYS);
    if ((declaredType !== undefined && declaredType !== "choice") || choice === undefined) {
      return withUsage(refusal("choice", model, "wrong answer type for choice question"), usage);
    }
    const probs = readProbabilities(answer);
    const fromProvider = providerConfidence(answer);
    const fromDerived = maxProbability(probs);
    const output: DecisionOutput = {
      kind: "choice",
      value: choice,
      confidence: fromProvider ?? fromDerived ?? null,
      confidenceSource:
        fromProvider !== undefined ? "provider" : fromDerived !== undefined ? "derived" : null,
      model,
    };
    if (probs !== undefined) {
      output.probabilities = probs;
    }
    return withUsage(output, usage);
  }
  const score = firstFiniteNumber(answer, SCORE_KEYS);
  if ((declaredType !== undefined && declaredType !== "score") || score === undefined) {
    return withUsage(refusal("score", model, "wrong answer type for score question"), usage);
  }
  const labels = question.levels.map((level) => level.label);
  const index = Math.min(labels.length - 1, Math.max(0, Math.round(score)));
  const rawProbs = readProbabilities(answer);
  let probabilities: Record<string, number> | undefined;
  if (rawProbs !== undefined) {
    probabilities = {};
    labels.forEach((label, i) => {
      const p = rawProbs[String(i)] ?? rawProbs[label];
      if (p !== undefined) {
        (probabilities as Record<string, number>)[label] = p;
      }
    });
  }
  const fromProvider = providerConfidence(answer);
  const fromDerived = maxProbability(probabilities);
  const output: DecisionOutput = {
    kind: "score",
    value: labels[index] as string,
    score,
    confidence: fromProvider ?? fromDerived ?? null,
    confidenceSource:
      fromProvider !== undefined ? "provider" : fromDerived !== undefined ? "derived" : null,
    model,
  };
  if (probabilities !== undefined) {
    output.probabilities = probabilities;
  }
  return withUsage(output, usage);
}

function questionKindOf(question: DecisionQuestion): DecisionOutput["kind"] {
  return question.kind === "boolean" ? "boolean" : question.kind;
}

// --- Redacted response shape -------------------------------------------------
// Key names and value types only: never values, never secret material. Both
// counts and name lengths are capped so a hostile body cannot bloat logs.

/** At most this many key names per list in a shape summary. */
export const MAX_SHAPE_KEYS = 32;
/** Key names longer than this are truncated in a shape summary. */
export const MAX_SHAPE_KEY_CHARS = 64;

function shapeKey(key: string): string {
  return key.length > MAX_SHAPE_KEY_CHARS ? key.slice(0, MAX_SHAPE_KEY_CHARS) : key;
}

function shapeTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Summarize the raw provider body for the live probe: top-level key names,
 * the answer's key names and value TYPES, whether it was `{ result }`
 * wrapped, and whether confidence/probabilities/usage were present.
 */
export function summarizeResponseShape(payload: unknown): ResponseShapeSummary {
  const top = isRecord(payload) ? payload : {};
  const wrapped = isRecord(top.result) && top.result !== top;
  const inner = wrapped ? (top.result as Record<string, unknown>) : top;
  const container = firstRecord(inner, ANSWER_CONTAINER_KEYS);
  const answer =
    container !== undefined && isRecord(container.q0)
      ? (container.q0 as Record<string, unknown>)
      : undefined;
  const answerValueTypes: Record<string, string> = {};
  if (answer !== undefined) {
    for (const key of Object.keys(answer).slice(0, MAX_SHAPE_KEYS)) {
      answerValueTypes[shapeKey(key)] = shapeTypeOf(answer[key]);
    }
  }
  return {
    wrappedInResult: wrapped,
    topLevelKeys: Object.keys(top).slice(0, MAX_SHAPE_KEYS).map(shapeKey),
    answerKeys: Object.keys(answerValueTypes),
    answerValueTypes,
    hasConfidence: answer !== undefined && providerConfidence(answer) !== undefined,
    hasProbabilities:
      answer !== undefined && firstRecord(answer, PROBABILITY_MAP_KEYS) !== undefined,
    hasUsage: readUsage(inner) !== undefined || readUsage(top) !== undefined,
  };
}
