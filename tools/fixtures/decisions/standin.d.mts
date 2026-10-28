export type ScenarioEntry =
  | string
  | { scenario: string; retryAfter?: string | undefined; delayMs?: number | undefined };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  bodyText: string;
  body: unknown;
}

export interface StandinOptions {
  tokens?: { jev?: string | undefined; cf?: string | undefined; accountId?: string | undefined } | undefined;
}

export interface StandinHandle {
  origin: string;
  requests(): RecordedRequest[];
  lastRequest(): RecordedRequest | undefined;
  setNext(next: ScenarioEntry[]): void;
  clear(): void;
  maxActive(): number;
  resetPeak(): void;
  drain(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function startStandin(options?: StandinOptions): Promise<StandinHandle>;
