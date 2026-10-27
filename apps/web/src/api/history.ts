import { ApiProtocolError, type EventPageResponse } from "@relay/api";
import type { EventEnvelope } from "@relay/core";

export const MAX_HISTORY_PAGES = 200;

/**
 * Page the complete event history at or below a snapshot watermark. A partial
 * prefix is never returned: callers only see success once the server reports
 * hasMore=false, or a protocol error that the UI can surface honestly.
 */
export async function collectHistory(
  loadPage: (after: number) => Promise<EventPageResponse>,
  watermark: number,
  maxPages: number = MAX_HISTORY_PAGES,
): Promise<EventEnvelope[]> {
  if (watermark <= 0) return [];
  const events: EventEnvelope[] = [];
  let after = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await loadPage(after);
    events.push(...result.events);
    if (!result.hasMore) return events;
    if (result.nextAfter <= after) {
      throw new ApiProtocolError(
        "invalid-response",
        "Event history pagination made no progress while hasMore is true",
      );
    }
    after = result.nextAfter;
  }
  throw new ApiProtocolError(
    "invalid-response",
    `Event history exceeds the bounded ${maxPages * 500}-event replay window`,
  );
}
