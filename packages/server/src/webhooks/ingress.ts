import { WEBHOOK_DELIVERY_ID_HEADERS } from "@devchestra/api";
import { WEBHOOK_HEADER_ALLOWLIST } from "@devchestra/schema";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { browserError } from "../browser/browser-error.js";
import { applySecurityHeaders } from "../browser/security.js";
import { DevChestraError, devchestraErrorCode, errorBody } from "../errors.js";
import { readRawBody, WEBHOOK_BODY_MAX_BYTES } from "./body.js";
import { HOOK_ID_PATTERN } from "./secrets.js";
import type { WebhookService } from "./service.js";

const QUEUE_FULL_RETRY_AFTER_SECONDS = "30";

export interface WebhookIngressDeps {
  /** Null when no webhook ports are composed: every hook is then unknown. */
  readonly service: WebhookService | null;
  readonly validate: (name: string, value: unknown) => void;
}

/**
 * Public delivery route. It carries no session, CSRF, Host or Origin check, so it
 * must be mounted before the application's `*` guards: a handler that answers
 * without calling `next()` keeps those guards from running.
 */
export function mountWebhookIngress(app: Hono, deps: WebhookIngressDeps): void {
  app.post("/webhooks/:hookId", async (c) => {
    const service = deps.service;
    const hookId = c.req.param("hookId");
    const runtime =
      service !== null && HOOK_ID_PATTERN.test(hookId) ? service.runtimeFor(hookId) : null;
    if (service === null || runtime === null) {
      return reply(c, 404, errorBody("E_NOT_FOUND", "Not found."));
    }
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBody(c, { maxBytes: WEBHOOK_BODY_MAX_BYTES });
    } catch (error) {
      return failure(c, error);
    }
    const headers = Object.fromEntries(
      WEBHOOK_HEADER_ALLOWLIST.map((name) => [name, c.req.header(name)]),
    );
    try {
      const outcome = await service.deliver(runtime, {
        rawBody,
        authorization: c.req.header("authorization"),
        signatures: [c.req.header("x-hub-signature-256"), c.req.header("x-devchestra-signature")],
        deliveryId: firstDeliveryId(c),
        headers,
      });
      deps.validate("WebhookDeliveryResponse", outcome.body);
      return reply(c, outcome.status, outcome.body);
    } catch (error) {
      return failure(c, error);
    }
  });
}

function firstDeliveryId(c: Context): string | undefined {
  for (const name of WEBHOOK_DELIVERY_ID_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function reply(
  c: Context,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const response = c.json(body, status as ContentfulStatusCode);
  applySecurityHeaders(response.headers, c.req.path);
  // The security helper only marks /api/ responses; run IDs here are never cacheable.
  response.headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/**
 * Converts a delivery failure to its wire response. Specific refusals keep their
 * details; other coded refusals go through the API error table. Uncoded failures
 * are re-thrown to the app's error handler.
 */
function failure(c: Context, error: unknown): Response {
  if (error instanceof DevChestraError) {
    const extra =
      error.code === "E_QUEUE_FULL" ? { "Retry-After": QUEUE_FULL_RETRY_AFTER_SECONDS } : {};
    return reply(c, error.status, errorBody(error.code, error.message, error.details), extra);
  }
  if (devchestraErrorCode(error) === null) throw error;
  const mapped = browserError(error);
  return reply(c, mapped.status, { error: { code: mapped.code, message: mapped.message } });
}
