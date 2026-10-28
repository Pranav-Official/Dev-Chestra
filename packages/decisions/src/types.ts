import type { DecisionOutput, JsonValue, RelayError, Result } from "@relay/core";
import type { DecisionProviderId } from "@relay/schema";

/** The normalized answer is owned by `@relay/core` (events); re-exported so the
 * client result and the stored event payload are the same type. */
export type { DecisionOutput } from "@relay/core";

export type DecisionQuestion =
  | { kind: "boolean"; instructions: string }
  | {
      kind: "choice";
      instructions: string;
      options: { value: string; description?: string }[];
    }
  | {
      kind: "score";
      instructions: string;
      levels: { label: string; description?: string }[];
    };

export interface DecisionRequest {
  provider: DecisionProviderId;
  model?: string;
  state: string | JsonValue;
  question: DecisionQuestion;
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResponse {
  output: DecisionOutput;
  usage?: DecisionUsage;
  latencyMs: number;
  /** Redacted shape of the raw provider body (key names and value types only). */
  shape: ResponseShapeSummary;
}

export interface DecisionClient {
  ask(req: DecisionRequest, signal: AbortSignal): Promise<Result<DecisionResponse, RelayError>>;
  availability(): { ready: boolean; missing: string[] };
  test(signal: AbortSignal): Promise<TestReport>;
}

export interface DecisionService {
  client(provider: DecisionProviderId): DecisionClient;
}

// Reachability probe result. Never carries key material, only names on failure.
// `shape` is a redacted summary of the raw provider body (key names and value
// types only, bounded); it lets the owner confirm the unverified wire
// assumptions without ever printing values or keys.
export interface TestReport {
  ok: boolean;
  provider: DecisionProviderId;
  model: string;
  latencyMs: number;
  /** Resolved model from the probe answer; present only on success. */
  resolvedModel?: string;
  /** Redacted response shape; present only on success. */
  shape?: ResponseShapeSummary;
  error?: string;
}

/**
 * Redacted summary of one raw provider response body. Key NAMES and value
 * TYPES only — never values, never secret material. Counts and name lengths
 * are bounded so a hostile body cannot bloat logs.
 */
export interface ResponseShapeSummary {
  /** True when the body was Cloudflare-wrapped (`{ result, ... }`). */
  wrappedInResult: boolean;
  /** Top-level key names of the raw body. */
  topLevelKeys: string[];
  /** Key names of the `answers.q0` answer object (`[]` on refusal). */
  answerKeys: string[];
  /** `answers.q0` key name -> value type (`"null"`, `"array"`, or `typeof`). */
  answerValueTypes: Record<string, string>;
  hasConfidence: boolean;
  hasProbabilities: boolean;
  hasUsage: boolean;
}
