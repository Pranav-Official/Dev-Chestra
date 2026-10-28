import type { DecisionProviderId } from "@relay/schema";
import type { JsonValue, RelayError, Result } from "@relay/core";

// NOTE: this mirrors the `DecisionOutput` contract in section 4 of
// decision-node-contract.md. `@relay/core` does not export a DecisionOutput
// type yet; when it does, this alias must be replaced with (or checked
// assignable to) the core type at integration time. The shapes are
// intentionally identical so unification is a rename, not a migration.
export interface DecisionOutput {
  kind: "boolean" | "choice" | "score";
  value: boolean | string | null;
  probability?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence: number | null;
  confidenceSource: "provider" | "derived" | null;
  refusal?: { reason?: string };
  model: string;
}

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
