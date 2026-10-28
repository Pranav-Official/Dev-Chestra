import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { isRecord } from "@relay/core";
import { RelayError } from "../errors.js";

export const SESSION_COOKIE = "relay_session";
export const SESSION_COOKIE_HEADER = `${SESSION_COOKIE}=`;

export function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  const equal = timingSafeEqual(a, b);
  return equal && left.length === right.length;
}

export function isLoopbackOriginAllowed(origin: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  if (parsed.origin !== origin) return false;
  return (
    (parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]") &&
    parsed.port === String(port)
  );
}

export function isLoopbackHostAllowed(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const media = value.split(";", 1)[0]?.trim().toLowerCase();
  return media === "application/json";
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function applySecurityHeaders(headers: Headers, path: string): void {
  headers.set("X-Relay-Api", "1");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (path.startsWith("/api/")) headers.set("Cache-Control", "no-store");
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    applySecurityHeaders(c.res.headers, c.req.path);
  };
}

export function hostGuard(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    const actualPort = port();
    if (
      host === undefined ||
      host === "" ||
      !Number.isInteger(actualPort) ||
      actualPort <= 0 ||
      !isLoopbackHostAllowed(host, actualPort)
    ) {
      return c.json({ error: { code: "E_FORBIDDEN_PATH", message: "Host is not allowed." } }, 421);
    }
    await next();
  };
}

export function originGuard(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "") {
      const actualPort = port();
      if (actualPort <= 0 || !isLoopbackOriginAllowed(origin, actualPort)) {
        return c.json(
          { error: { code: "E_FORBIDDEN_PATH", message: "Origin is not allowed." } },
          403,
        );
      }
    }
    await next();
  };
}

export function noStoreForApi(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  };
}

export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }
    if (!c.req.path.startsWith("/api/")) {
      await next();
      return;
    }
    if (c.req.header("x-relay-csrf") !== "1") {
      return c.json(
        { error: { code: "E_FORBIDDEN_PATH", message: "X-Relay-Csrf: 1 is required." } },
        403,
      );
    }
    if (!isJsonContentType(c.req.header("content-type"))) {
      return c.json(
        { error: { code: "E_FORBIDDEN_PATH", message: "Content-Type must be application/json." } },
        403,
      );
    }
    const encoding = c.req.header("content-encoding");
    if (encoding !== undefined && encoding !== "" && encoding.trim().toLowerCase() !== "identity") {
      return c.json(
        { error: { code: "E_VALIDATION", message: "Content-Encoding is not supported." } },
        400,
      );
    }
    await next();
  };
}

export interface JsonBodyOptions {
  maxBytes: number;
  timeoutMs?: number;
}

export async function readJsonObject(
  c: Context,
  options: JsonBodyOptions,
): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new RelayError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  const body = c.req.raw.body;
  if (body === null) {
    throw new RelayError("E_VALIDATION", "Request body must be a JSON object.");
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (controller.signal.aborted) {
        throw new RelayError("E_VALIDATION", "Request body was not received in time.");
      }
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RelayError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled.
    }
  }
  if (controller.signal.aborted) {
    throw new RelayError("E_VALIDATION", "Request body was not received in time.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RelayError("E_VALIDATION", "Request body must be valid UTF-8 JSON.");
  }
  if (!isRecord(parsed)) {
    throw new RelayError("E_VALIDATION", "Request body must be a JSON object.");
  }
  return parsed;
}

export function safeLogLine(method: string, route: string, status: number): string {
  return `${method} ${route} ${status}`;
}
