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
export interface TestReport {
  ok: boolean;
  provider: DecisionProviderId;
  model: string;
  latencyMs: number;
  error?: string;
}
