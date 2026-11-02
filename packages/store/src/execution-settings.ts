import type { Runtime } from "./runtime.js";
import { fail, parseJson } from "./util.js";

const EXECUTION_KEY = "settings:execution";
const WEBHOOK_KEY = "settings:webhooks";
const PUBLIC_BASE_URL_MAX = 2048;

/** Global limits over top-level runs. Child workflow runs use their lineage's slot. */
export interface ExecutionSettings {
  maxConcurrentRuns: number;
  maxQueueDepth: number;
}

export const EXECUTION_LIMITS = {
  maxConcurrentRuns: { min: 1, max: 32, fallback: 2 },
  maxQueueDepth: { min: 10, max: 1000, fallback: 100 },
} as const;

export interface WebhookSettings {
  /** Origin shown in copyable webhook URLs when the server is reached through a tunnel. */
  publicBaseUrl: string | null;
}

function inRange(value: unknown, bounds: { min: number; max: number }): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= bounds.min &&
    (value as number) <= bounds.max
  );
}

function readKv(runtime: Runtime, key: string): unknown {
  const row = runtime.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) return undefined;
  try {
    return parseJson<unknown>(row.value);
  } catch {
    // A corrupt settings row must not stop the engine. Callers fall back to defaults.
    return undefined;
  }
}

function writeKv(runtime: Runtime, key: string, value: unknown): void {
  runtime.db
    .prepare(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

export function getExecutionSettings(runtime: Runtime): ExecutionSettings {
  const stored = readKv(runtime, EXECUTION_KEY) as Partial<
    Record<keyof ExecutionSettings, unknown>
  >;
  const pick = (key: keyof ExecutionSettings): number => {
    const value = stored?.[key];
    return inRange(value, EXECUTION_LIMITS[key]) ? value : EXECUTION_LIMITS[key].fallback;
  };
  return { maxConcurrentRuns: pick("maxConcurrentRuns"), maxQueueDepth: pick("maxQueueDepth") };
}

export function setExecutionSettings(
  runtime: Runtime,
  input: ExecutionSettings,
): ExecutionSettings {
  for (const key of Object.keys(EXECUTION_LIMITS) as (keyof ExecutionSettings)[]) {
    const bounds = EXECUTION_LIMITS[key];
    if (!inRange(input[key], bounds)) {
      fail("E_VALIDATION", `${key} must be a whole number from ${bounds.min} to ${bounds.max}`, {
        field: key,
      });
    }
  }
  const next = { maxConcurrentRuns: input.maxConcurrentRuns, maxQueueDepth: input.maxQueueDepth };
  writeKv(runtime, EXECUTION_KEY, next);
  return next;
}

export function getWebhookSettings(runtime: Runtime): WebhookSettings {
  const stored = readKv(runtime, WEBHOOK_KEY) as Partial<WebhookSettings> | undefined;
  const publicBaseUrl = typeof stored?.publicBaseUrl === "string" ? stored.publicBaseUrl : null;
  return { publicBaseUrl };
}

/**
 * Accepts an http(s) origin with an optional path prefix. Credentials, query
 * strings and fragments are rejected so the value is safe to print.
 */
export function setWebhookSettings(runtime: Runtime, input: WebhookSettings): WebhookSettings {
  if (input.publicBaseUrl === null) {
    writeKv(runtime, WEBHOOK_KEY, { publicBaseUrl: null });
    return { publicBaseUrl: null };
  }
  const raw = input.publicBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("E_VALIDATION", "publicBaseUrl must be an absolute http or https URL", {
      field: "publicBaseUrl",
    });
  }
  if (
    raw.length > PUBLIC_BASE_URL_MAX ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail(
      "E_VALIDATION",
      "publicBaseUrl must be an http or https URL without credentials, query or fragment",
      {
        field: "publicBaseUrl",
      },
    );
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  writeKv(runtime, WEBHOOK_KEY, { publicBaseUrl: normalized });
  return { publicBaseUrl: normalized };
}
