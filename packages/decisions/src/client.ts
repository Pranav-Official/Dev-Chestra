import type { Result } from "@relay/core";
import { err, ok, RelayError } from "@relay/core";
import type { DecisionProviderId } from "@relay/schema";
import { DECISION_PROVIDERS, isDecisionProviderId } from "@relay/schema";
import type { SecretMap } from "./http.js";
import { parseJsonBody, postDecisionJson } from "./http.js";
import { DECISION_PRESETS, resolvePresetUrl } from "./presets.js";
import type { EnvLike } from "./secrets.js";
import { loadDecisionSecrets, missingSecretNames, redactSecrets } from "./secrets.js";
import type {
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
  DecisionService,
  ResponseShapeSummary,
  TestReport,
} from "./types.js";
import { buildDecisionBody, parseDecisionPayload, summarizeResponseShape } from "./wire.js";

/** At most 8 concurrent calls per provider (contract §7). */
export const MAX_CONCURRENT_PER_PROVIDER = 8;

export interface DecisionClientOptions {
  env?: EnvLike | undefined;
  dotenvPath?: string | null | undefined;
  /**
   * Test-only origin override (e.g. the loopback stand-in). Must be a
   * loopback origin; never read from config or env, so real traffic cannot
   * be redirected to plain HTTP.
   */
  baseUrlOverride?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  jitterRatio?: number | undefined;
  maxResponseBytes?: number | undefined;
}

interface Waiter {
  wake: () => void;
  cancelled: boolean;
}

interface Semaphore {
  active: number;
  waiting: Waiter[];
}

const semaphores = new Map<DecisionProviderId, Semaphore>();

function semaphoreFor(provider: DecisionProviderId): Semaphore {
  let sem = semaphores.get(provider);
  if (sem === undefined) {
    sem = { active: 0, waiting: [] };
    semaphores.set(provider, sem);
  }
  return sem;
}

/**
 * Run `fn` while holding one of the 8 per-provider slots. Callers waiting for
 * a slot reject immediately with E_CANCELLED when their signal aborts (F1);
 * the waiter is removed from the queue so a later release cannot leak it.
 */
async function withSlot<T>(
  provider: DecisionProviderId,
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const sem = semaphoreFor(provider);
  if (signal?.aborted === true) {
    throw new RelayError("E_CANCELLED", "Decision request was cancelled.");
  }
  // Recheck after every wake-up: several released waiters may resume in the
  // same microtask drain, and only the first may take the freed slot.
  while (sem.active >= MAX_CONCURRENT_PER_PROVIDER) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { wake: () => resolve(), cancelled: false };
      const onAbort = (): void => {
        waiter.cancelled = true;
        const index = sem.waiting.indexOf(waiter);
        if (index >= 0) {
          sem.waiting.splice(index, 1);
        }
        reject(new RelayError("E_CANCELLED", "Decision request was cancelled."));
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        const wake = waiter.wake;
        waiter.wake = (): void => {
          signal.removeEventListener("abort", onAbort);
          wake();
        };
      }
      sem.waiting.push(waiter);
    });
  }
  sem.active += 1;
  try {
    return await fn();
  } finally {
    sem.active -= 1;
    let next = sem.waiting.shift();
    while (next?.cancelled === true) {
      next = sem.waiting.shift();
    }
    next?.wake();
  }
}

/** Reset the per-provider semaphores. Test-only escape hatch. */
export function resetDecisionSemaphores(): void {
  semaphores.clear();
}

function secretFor(secrets: SecretMap, provider: DecisionProviderId): string {
  if (provider === "typesafe-jev") {
    return secrets.TYPESAFE_API_KEY as string;
  }
  return secrets.CLOUDFLARE_AUTH_TOKEN as string;
}

/**
 * Resolve the request URL. The account id is substituted into Cloudflare
 * preset paths; a test override replaces the origin only, keeping the path
 * (so the URL path always carries the preset model).
 */
export function resolveRequestUrl(
  provider: DecisionProviderId,
  accountId: string | undefined,
  baseUrlOverride: string | undefined,
  secrets: SecretMap,
): { url: string; allowLoopbackHttp: boolean } {
  const preset = DECISION_PRESETS[provider];
  const path = resolvePresetUrl(preset, accountId ?? "");
  if (baseUrlOverride === undefined) {
    return { url: path, allowLoopbackHttp: false };
  }
  let origin: URL;
  try {
    origin = new URL(baseUrlOverride);
  } catch {
    throw new RelayError(
      "E_VALIDATION",
      `Invalid decision base URL override ${redactSecrets(baseUrlOverride, secrets)}.`,
    );
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new RelayError("E_VALIDATION", "Decision base URL override must be http(s).");
  }
  if (
    origin.hostname !== "127.0.0.1" &&
    origin.hostname !== "::1" &&
    origin.hostname !== "localhost"
  ) {
    throw new RelayError("E_VALIDATION", "Decision base URL override must be loopback.");
  }
  return { url: new URL(new URL(path).pathname, origin).toString(), allowLoopbackHttp: true };
}

export function createDecisionClient(
  provider: DecisionProviderId,
  options: DecisionClientOptions = {},
): DecisionClient {
  if (!isDecisionProviderId(provider)) {
    throw new RelayError("E_VALIDATION", `Unknown decision provider ${JSON.stringify(provider)}.`);
  }
  const preset = DECISION_PRESETS[provider];

  function readSecrets(): SecretMap {
    const { env, dotenvPath } = options;
    return loadDecisionSecrets({ env, dotenvPath });
  }

  function availability(): { ready: boolean; missing: string[] } {
    const missing = missingSecretNames(readSecrets(), preset.requiredEnv);
    return { ready: missing.length === 0, missing: [...missing] };
  }

  async function ask(
    req: DecisionRequest,
    signal: AbortSignal,
  ): Promise<Result<DecisionResponse, RelayError>> {
    if (req.provider !== provider) {
      return err(
        new RelayError(
          "E_VALIDATION",
          `Decision client for ${provider} cannot ask ${String(req.provider)}.`,
        ),
      );
    }
    let bodyJson: string;
    try {
      bodyJson = JSON.stringify(buildDecisionBody(req, preset));
    } catch (error) {
      return err(
        error instanceof RelayError
          ? error
          : new RelayError("E_VALIDATION", "Invalid decision request."),
      );
    }
    const secrets = readSecrets();
    const missing = missingSecretNames(secrets, preset.requiredEnv);
    if (missing.length > 0) {
      return err(
        new RelayError(
          "E_PROVIDER",
          `Missing or invalid decision secret(s): ${missing.join(", ")}. Set them in the environment or .env.`,
        ),
      );
    }
    let url: string;
    let allowLoopbackHttp: boolean;
    try {
      ({ url, allowLoopbackHttp } = resolveRequestUrl(
        provider,
        secrets.CLOUDFLARE_ACCOUNT_ID,
        options.baseUrlOverride,
        secrets,
      ));
    } catch (error) {
      return err(
        error instanceof RelayError
          ? error
          : new RelayError("E_VALIDATION", "Invalid decision request."),
      );
    }
    const timeoutMs = options.timeoutMs ?? preset.timeoutMs;
    const started = Date.now();
    try {
      const text = await withSlot(
        provider,
        () =>
          postDecisionJson(
            url,
            bodyJson,
            secretFor(secrets, provider),
            {
              timeoutMs,
              secrets,
              fetchImpl: options.fetchImpl,
              sleep: options.sleep,
              jitterRatio: options.jitterRatio,
              maxResponseBytes: options.maxResponseBytes,
              signal,
              provider,
            },
            allowLoopbackHttp,
          ),
        signal,
      );
      const payload = parseJsonBody(text, secrets);
      const parsed = parseDecisionPayload({
        payload,
        question: req.question,
        modelFallback: preset.bodyModel,
      });
      const shape: ResponseShapeSummary = summarizeResponseShape(payload);
      const response: DecisionResponse = {
        output: parsed.output,
        latencyMs: Date.now() - started,
        shape,
      };
      if (parsed.usage !== undefined) {
        response.usage = parsed.usage;
      }
      return ok(response);
    } catch (error) {
      if (error instanceof RelayError) {
        error.message = redactSecrets(error.message, secrets);
        return err(error);
      }
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      return err(
        new RelayError("E_PROVIDER", `Decision request failed: ${message}`, { retryable: true }),
      );
    }
  }

  async function test(signal: AbortSignal): Promise<TestReport> {
    const started = Date.now();
    const model = preset.bodyModel;
    const result = await ask(
      {
        provider,
        state: "ping",
        question: {
          kind: "boolean",
          instructions: "Reply with your probability that the answer is yes.",
        },
      },
      signal,
    );
    if (result.ok) {
      return {
        ok: true,
        provider,
        model,
        latencyMs: Date.now() - started,
        resolvedModel: result.value.output.model,
        shape: result.value.shape,
      };
    }
    return {
      ok: false,
      provider,
      model,
      latencyMs: Date.now() - started,
      error: redactSecrets(result.error.message, readSecrets()),
    };
  }

  return { ask, availability, test };
}

export function createDecisionService(options: DecisionClientOptions = {}): DecisionService {
  const clients = new Map<DecisionProviderId, DecisionClient>();
  return {
    client(provider: DecisionProviderId): DecisionClient {
      let client = clients.get(provider);
      if (client === undefined) {
        client = createDecisionClient(provider, options);
        clients.set(provider, client);
      }
      return client;
    },
  };
}

/** Every provider id, for availability listing. */
export function decisionProviders(): DecisionProviderId[] {
  return [...DECISION_PROVIDERS];
}
