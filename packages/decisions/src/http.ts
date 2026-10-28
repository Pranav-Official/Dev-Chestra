import { DevChestraError } from "@devchestra/core";
import type { DecisionSecretName } from "./secrets.js";
import { redactSecrets } from "./secrets.js";

/** Response body cap (contract §7). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Retry delays in milliseconds (contract §7). */
export const RETRY_429_DELAYS_MS = [1000, 3000];
export const RETRY_NETWORK_DELAYS_MS = [500, 1500];
export const MAX_RETRIES = 2;

/** A honored Retry-After above this fails fast instead of sleeping (F1). */
export const MAX_RETRY_AFTER_MS = 10_000;

/** Node timers at or above 2^31 ms fire after ~1 ms; clamp every timer (F1). */
export const MAX_TIMER_MS = 2_147_483_647;

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
  /** Provider id, used only to name the provider in error messages. */
  provider?: string | undefined;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampTimerMs(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_TIMER_MS;
  return Math.min(MAX_TIMER_MS, Math.max(0, Math.round(ms)));
}

function cancelledError(): DevChestraError {
  return new DevChestraError("E_CANCELLED", "Decision request was cancelled.");
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

function providerError(secrets: SecretMap, message: string, retryable: boolean): DevChestraError {
  return new DevChestraError("E_PROVIDER", redactSecrets(message, secrets), { retryable });
}

function validationError(secrets: SecretMap, message: string): DevChestraError {
  return new DevChestraError("E_VALIDATION", redactSecrets(message, secrets));
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
    throw new DevChestraError("E_VALIDATION", `Invalid decision URL ${JSON.stringify(url)}.`);
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && allowLoopbackHttp && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed;
  }
  throw new DevChestraError(
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
  signal: AbortSignal | undefined,
): Promise<void> {
  // An abort during a retry sleep rejects immediately with the same
  // E_CANCELLED the rest of the client uses, instead of holding a slot (F1).
  if (signal?.aborted === true) throw cancelledError();
  const jitter = jitterRatio <= 0 ? 0 : baseMs * jitterRatio * (Math.random() * 2 - 1);
  const ms = clampTimerMs(baseMs + jitter);
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  let onAbort: () => void = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = (): void => {
        reject(cancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(() => resolve(), reject);
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface FetchedResponse {
  response: Response;
  /**
   * Clears the still-armed per-call timeout and detaches the abort listener.
   * The timeout stays active until the body has been fully read (F2), so the
   * caller must invoke this once the body is done (read, cancelled, or failed).
   */
  release: () => void;
  /** True once the per-call timeout has fired, in the headers or body phase. */
  timedOut: () => boolean;
}

interface SingleAttempt {
  response?: FetchedResponse;
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
  }, clampTimerMs(timeoutMs));
  const onAbort = (): void => {
    controller.abort();
  };
  const cleanup = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      cleanup();
      return { aborted: true };
    }
    externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
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
  } catch (error) {
    cleanup();
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
  }
  // Success: the timer and abort listener stay armed across the body read.
  return { response: { response, release: cleanup, timedOut: () => timedOut } };
}

/** What the body reader needs to tell an abort apart from a timeout (F2). */
export interface BodyReadWatch {
  externalSignal?: AbortSignal | undefined;
  timedOut?: (() => boolean) | undefined;
  timeoutMs?: number | undefined;
}

function mapBodyReadError(
  error: unknown,
  secrets: SecretMap,
  watch: BodyReadWatch | undefined,
): DevChestraError {
  if (watch?.externalSignal?.aborted === true) return cancelledError();
  if (watch?.timedOut?.() === true) {
    return providerError(
      secrets,
      `Decision request timed out after ${String(watch.timeoutMs ?? "?")} ms.`,
      true,
    );
  }
  if (error instanceof DevChestraError) return error;
  const detail = error instanceof Error ? error.message : "?";
  return providerError(secrets, `Decision provider broke the response body: ${detail}`, true);
}

/**
 * Read a response body as text, enforcing the byte cap. The per-call timeout
 * and the external abort signal stay active until the body has been fully
 * read (F2): pass the attempt's watch so a stall or drip mid-body rejects
 * instead of hanging with the slot held.
 */
export async function readCappedText(
  response: Response,
  secrets: SecretMap,
  maxBytes: number,
  watch?: BodyReadWatch | undefined,
): Promise<string> {
  // Read through closures: a repeated `watch?.externalSignal?.aborted === true`
  // check would be narrowed away as impossible after the first one.
  const isAborted = (): boolean => watch?.externalSignal?.aborted === true;
  const isTimedOut = (): boolean => watch?.timedOut?.() === true;
  if (isAborted()) throw cancelledError();
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
  }
  if (response.body === null) {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw mapBodyReadError(error, secrets, watch);
    }
    if (isAborted()) throw cancelledError();
    if (isTimedOut()) {
      throw providerError(
        secrets,
        `Decision request timed out after ${String(watch?.timeoutMs ?? "?")} ms.`,
        true,
      );
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw mapBodyReadError(error, secrets, watch);
    }
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw providerError(secrets, `Decision response exceeds the ${maxBytes} byte cap.`, false);
    }
    chunks.push(next.value);
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
  watch?: BodyReadWatch | undefined,
): Promise<never> {
  let text = "";
  try {
    text = await readCappedText(response, secrets, maxBytes, watch);
  } catch (error) {
    if (error instanceof DevChestraError) {
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

  // Discard (cancel, do not fully read) a body we are not going to parse so a
  // retry or failure does not leave the transfer hanging (F2).
  async function discardBody(fetched: FetchedResponse): Promise<void> {
    try {
      await fetched.response.body?.cancel();
    } catch {
      // Already closed or errored; nothing to do.
    } finally {
      fetched.release();
    }
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
      throw cancelledError();
    }
    if (outcome.redirect === true) {
      throw providerError(
        secrets,
        "Decision request was redirected; redirects are refused.",
        false,
      );
    }
    if (outcome.timeout === true) {
      // Client-side timeouts are never retried: each attempt may already have
      // been billed, and a retry would bill again (F7b).
      throw providerError(
        secrets,
        `Decision request timed out after ${String(options.timeoutMs)} ms.`,
        true,
      );
    }
    if (outcome.networkError !== undefined) {
      if (attempt < MAX_RETRIES) {
        const delays = RETRY_NETWORK_DELAYS_MS[attempt] as number;
        await applyDelay(sleep, delays, jitterRatio, options.signal);
        continue;
      }
      const detail = outcome.networkError instanceof Error ? outcome.networkError.message : "?";
      throw providerError(secrets, `Decision provider is not reachable: ${detail}`, true);
    }
    const fetched = outcome.response as FetchedResponse;
    const response = fetched.response;
    const watch: BodyReadWatch = {
      externalSignal: options.signal,
      timedOut: fetched.timedOut,
      timeoutMs: options.timeoutMs,
    };
    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
          const providerName = options.provider ?? "unknown provider";
          await discardBody(fetched);
          throw providerError(
            secrets,
            `Decision provider ${providerName} asked to wait ${String(Math.round(retryAfter))} ms (Retry-After), above the ${String(MAX_RETRY_AFTER_MS)} ms cap; failing fast without retry.`,
            true,
          );
        }
        const fallback = RETRY_429_DELAYS_MS[attempt] as number;
        try {
          await applyDelay(sleep, retryAfter ?? fallback, jitterRatio, options.signal);
        } catch (error) {
          await discardBody(fetched);
          throw error;
        }
        await discardBody(fetched);
        continue;
      }
      try {
        await terminalFailure(
          response,
          secrets,
          maxBytes,
          "Decision provider rate limited",
          true,
          watch,
        );
      } finally {
        fetched.release();
      }
    }
    if (response.status >= 500 && response.status <= 599) {
      if (attempt < MAX_RETRIES) {
        const delays = RETRY_NETWORK_DELAYS_MS[attempt] as number;
        try {
          await applyDelay(sleep, delays, jitterRatio, options.signal);
        } catch (error) {
          await discardBody(fetched);
          throw error;
        }
        await discardBody(fetched);
        continue;
      }
      try {
        await terminalFailure(
          response,
          secrets,
          maxBytes,
          `Decision provider failed with status ${String(response.status)}`,
          true,
          watch,
        );
      } finally {
        fetched.release();
      }
    }
    if (response.status >= 300 && response.status <= 399) {
      await discardBody(fetched);
      throw providerError(
        secrets,
        `Decision request was redirected (status ${String(response.status)}); redirects are refused.`,
        false,
      );
    }
    if (!response.ok) {
      try {
        await terminalFailure(
          response,
          secrets,
          maxBytes,
          `Decision provider rejected the request (status ${String(response.status)})`,
          false,
          watch,
        );
      } finally {
        fetched.release();
      }
    }
    try {
      return await readCappedText(response, secrets, maxBytes, watch);
    } finally {
      fetched.release();
    }
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
