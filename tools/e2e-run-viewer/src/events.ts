import type { EventEnvelope } from "@devchestra/core";
import { type DevChestraHttp, fieldString, type HttpResult } from "./http.js";

export interface EventPage {
  items: EventEnvelope[];
  nextAfter: number | null;
  hasMore: boolean;
  watermark: number;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

export function parseEventPage(result: HttpResult): EventPage {
  if (result.status !== 200) {
    throw new Error(
      `events returned ${String(result.status)}: ${JSON.stringify(result.body).slice(0, 300)}`,
    );
  }
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error("events response is not an object");
  }
  const body = result.body as Record<string, unknown>;
  const rawItems = body.items ?? body.events;
  if (!Array.isArray(rawItems)) throw new Error("events response is missing items[]");
  const watermark = integer(body.watermark, "events.watermark");
  const nextAfter = body.nextAfter === null ? null : integer(body.nextAfter, "events.nextAfter");
  if (typeof body.hasMore !== "boolean") throw new Error("events.hasMore must be boolean");
  const items = rawItems.map((item): EventEnvelope => {
    if (typeof item !== "object" || item === null) throw new Error("event item is not an object");
    const event = item as Record<string, unknown>;
    return event as unknown as EventEnvelope;
  });
  return { items, nextAfter, hasMore: body.hasMore, watermark };
}

export async function fetchEventPage(
  http: DevChestraHttp,
  runId: string,
  query: { after?: number; limit?: number; types?: string; pathPrefix?: string; upTo?: number },
): Promise<EventPage> {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.types !== undefined) params.set("types", query.types);
  if (query.pathPrefix !== undefined) params.set("pathPrefix", query.pathPrefix);
  if (query.upTo !== undefined) params.set("upTo", String(query.upTo));
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}/events${suffix}`);
  return parseEventPage(result);
}

export interface FullEvents {
  events: EventEnvelope[];
  watermark: number;
  pages: number;
}

export async function fetchAllEvents(
  http: DevChestraHttp,
  runId: string,
  options: { limit?: number; upTo?: number } = {},
): Promise<FullEvents> {
  const limit = options.limit ?? 500;
  const events: EventEnvelope[] = [];
  let after = 0;
  let pages = 0;
  let watermark = 0;
  for (;;) {
    const page = await fetchEventPage(http, runId, {
      after,
      limit,
      ...(options.upTo === undefined ? {} : { upTo: options.upTo }),
    });
    pages += 1;
    watermark = page.watermark;
    events.push(...page.items);
    if (!page.hasMore) break;
    if (page.nextAfter === null) throw new Error("events.hasMore is true but nextAfter is null");
    if (page.nextAfter <= after) throw new Error("event pagination cursor did not advance");
    after = page.nextAfter;
    if (pages > 500) throw new Error("event pagination did not terminate");
  }
  return { events, watermark, pages };
}

export async function waitForRun(
  http: DevChestraHttp,
  runId: string,
  predicate: (body: Record<string, unknown>) => boolean,
  timeoutMs = 60_000,
  label = "run condition",
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}`);
    if (result.status !== 200) {
      throw new Error(`GET run returned ${String(result.status)}`);
    }
    if (typeof result.body !== "object" || result.body === null) {
      throw new Error("GET run response is not an object");
    }
    const body = result.body as Record<string, unknown>;
    if (predicate(body)) return body;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

export function runStatus(body: Record<string, unknown>): string {
  const status =
    fieldString(body, ["run", "status"]) ?? fieldString(body, ["view", "status"]) ?? null;
  if (status === null) throw new Error("run response has no status");
  return status;
}

export function runIdOf(body: Record<string, unknown>): string {
  const runId = body.runId;
  if (typeof runId !== "string" || runId === "") throw new Error("response has no runId");
  return runId;
}
