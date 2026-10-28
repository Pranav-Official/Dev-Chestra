import { RelayError } from "@relay/core";
import type { DecisionSecretName } from "./secrets.js";
import { redactSecrets } from "./secrets.js";

/** Response body cap (contract §7). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Retry delays in milliseconds (contract §7). */
export const RETRY_429_DELAYS_MS = [1000, 3000];
export const RETRY_NETWORK_DELAYS_MS = [500, 1500];
export const MAX_RETRIES = 2;

export type SecretMap = Partial<Record<DecisionSecretName, string>>;

export interface DecisionHttpOptions {
  timeoutMs: number;
  secrets: SecretMap;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Fractional jitter applied to retry delays; 0 disables. Defaults to 0.2. */
  jitterRatio?: number | undefined;
  maxResponseBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A `redirect: "error"` refusal surfaces as a TypeError whose message or cause names the redirect. */
function isRedirectError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (/redirect/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function providerError(secrets: SecretMap, message: string, retryable: boolean): RelayError {
  return new RelayError("E_PROVIDER", redactSecrets(message, secrets), { retryable });
}

function validationError(secrets: SecretMap, message: string): RelayError {
  return new RelayError("E_VALIDATION", redactSecrets(message, secrets));
}

/**
 * Enforce https-only. Loopback `http://` is allowed only when the caller
 * passes `allowLoopbackHttp` (set solely from the injected test base-URL
 * override, never from config or env).
 */
export function assertAllowedUrl(url: string, allowLoopbackHttp: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RelayError("E_VALIDATION", `Invalid decision URL ${JSON.stringify(url)}.`);
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && allowLoopbackHttp && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed;
  }
  throw new RelayError(
    "E_VALIDATION",
    `Refusing non-HTTPS decision URL for host ${JSON.stringify(parsed.host)}.`,
  );
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed !== "" && /^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
}

async function applyDelay(
  sleep: (ms: number) => Promise<void>,
  baseMs: number,
  jitterRatio: number,
): Promise<void> {
  const jitter = jitterRatio <= 0 ? 0 : baseMs * jitterRatio * (Math.random() * 2 - 1);
  await sleep(Math.max(0, Math.round(baseMs + jitter)));
}

interface SingleAttempt {
  response?: Response;
  timeout?: true;
  aborted?: true;
  networkError?: unknown;
  redirect?: true;
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  bodyJson: string,
  apiKey: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<SingleAttempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    controller.abort();
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return { aborted: true };
    }
    externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: bodyJson,
      redirect: "error",
      signal: controller.signal,
    });
    return { response };
  } catch (error) {
    if (externalSignal?.aborted === true) {
      return { aborted: true };
    }
    if (timedOut) {
      return { timeout: true };
    }
    if (isRedirectError(error)) {
      return { redirect: true };
    }
    return { networkError: error };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/** Read a response body as text, enforcing the byte cap. */
export async function readCappedText(
  response: Response,
  secrets: SecretMap,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
  }
  if (response.body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function providerMessageFromText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "empty error body";
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      if (typeof nested === "string" && nested !== "") {
        return nested;
      }
      if (typeof nested === "object" && nested !== null) {
        const message = (nested as Record<string, unknown>).message;
        if (typeof message === "string" && message !== "") {
          return message;
        }
      }
      const message = record.message;
      if (typeof message === "string" && message !== "") {
        return message;
      }
    }
  } catch {
    // Fall through to raw text.
  }
  return trimmed;
}

async function terminalFailure(
  response: Response,
  secrets: SecretMap,
  maxBytes: number,
  prefix: string,
  retryable: boolean,
): Promise<never> {
  let text = "";
  try {
    text = await readCappedText(response, secrets, maxBytes);
  } catch (error) {
    if (error instanceof RelayError) {
      throw error;
    }
    throw providerError(secrets, `${prefix}: unreadable error body.`, retryable);
  }
  const message = redactSecrets(providerMessageFromText(text), secrets).slice(0, 500);
  throw providerError(secrets, `${prefix}: ${message}`, retryable);
}

/**
 * POST the decision body with timeout/abort, `redirect: "error"`, https
 * enforcement, a response size cap, and the §7 retry schedule. Returns the
 * response text; the caller parses JSON. Every error is key-redacted.
 */
export async function postDecisionJson(
  url: string,
  bodyJson: string,
  apiKey: string,
  options: DecisionHttpOptions,
  allowLoopbackHttp: boolean,
): Promise<string> {
  const { secrets } = options;
  assertAllowedUrl(url, allowLoopbackHttp);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw validationError(secrets, `Invalid decision timeout ${String(options.timeoutMs)}.`);
  }

  for (let attempt = 0; ; attempt += 1) {
    const outcome = await fetchOnce(
      fetchImpl,
      url,
      bodyJson,
      apiKey,
      options.timeoutMs,
      options.signal,
    );
    if (outcome.aborted === true) {
      throw new RelayError("E_CANCELLED", "Decision request was cancelled.");
    }
    if (outcome.redirect === true) {
      throw providerError(
        secrets,
        "Decision request was redirected; redirects are refused.",
        false,
      );
    }
    if (outcome.timeout === true) {
      if (attempt < MAX_RETRIES) {
        const delays = RETRY_NETWORK_DELAYS_MS[attempt] as number;
        await applyDelay(sleep, delays, jitterRatio);
        continue;
      }
      throw providerError(
        secrets,
        `Decision request timed out after ${String(options.timeoutMs)} ms.`,
        true,
      );
    }
    if (outcome.networkError !== undefined) {
      if (attempt < MAX_RETRIES) {
        const delays = RETRY_NETWORK_DELAYS_MS[attempt] as number;
        await applyDelay(sleep, delays, jitterRatio);
        continue;
      }
      const detail = outcome.networkError instanceof Error ? outcome.networkError.message : "?";
      throw providerError(secrets, `Decision provider is not reachable: ${detail}`, true);
    }
    const response = outcome.response as Response;
    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const fallback = RETRY_429_DELAYS_MS[attempt] as number;
        await applyDelay(sleep, retryAfter ?? fallback, jitterRatio);
        continue;
      }
      await terminalFailure(response, secrets, maxBytes, "Decision provider rate limited", true);
    }
    if (response.status >= 500 && response.status <= 599) {
      if (attempt < MAX_RETRIES) {
        const delays = RETRY_NETWORK_DELAYS_MS[attempt] as number;
        await applyDelay(sleep, delays, jitterRatio);
        continue;
      }
      await terminalFailure(
        response,
        secrets,
        maxBytes,
        `Decision provider failed with status ${String(response.status)}`,
        true,
      );
    }
    if (response.status >= 300 && response.status <= 399) {
      throw providerError(
        secrets,
        `Decision request was redirected (status ${String(response.status)}); redirects are refused.`,
        false,
      );
    }
    if (!response.ok) {
      await terminalFailure(
        response,
        secrets,
        maxBytes,
        `Decision provider rejected the request (status ${String(response.status)})`,
        false,
      );
    }
    return readCappedText(response, secrets, maxBytes);
  }
}

/** Parse a JSON response body; malformed JSON is an `E_PROVIDER` error. */
export function parseJsonBody(text: string, secrets: SecretMap): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerError(secrets, "Decision provider returned invalid JSON.", false);
  }
}
