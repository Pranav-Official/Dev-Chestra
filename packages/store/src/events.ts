import { type EventDraft, type EventEnvelope, type RunId, reduce } from "@devchestra/core";
import {
  lastEventTs,
  loadView,
  MAX_EVENT_PAYLOAD_BYTES,
  reconcile,
  requireRun,
  saveView,
} from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import { fail } from "./util.js";

/** Inserts events and updates the shared-core projection in the caller's transaction. */
export function appendEvents(
  runtime: Runtime,
  runId: RunId,
  drafts: readonly EventDraft[],
): EventEnvelope[] {
  if (drafts.length === 0) return [];
  requireRun(runtime, runId);
  const state = { view: loadView(runtime, runId), lastTs: lastEventTs(runtime, runId) };
  const events: EventEnvelope[] = [];

  for (const draft of drafts) {
    if (draft.runId !== runId) {
      fail("E_VALIDATION", "Event draft runId does not match the append target");
    }
    const ts = draft.ts === undefined ? now(runtime) : Date.parse(draft.ts);
    if (!Number.isFinite(ts)) fail("E_VALIDATION", `Invalid event timestamp ${draft.ts}`);
    const eventTs = Math.max(ts, state.lastTs);
    const payload = runtime.secrets.redactValue(draft.payload);
    const payloadText = JSON.stringify(payload);
    if (payloadText === undefined) fail("E_VALIDATION", "Event payload is not JSON-serializable");
    if (Buffer.byteLength(payloadText, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      fail("E_VALIDATION", "Event payload exceeds the 64 KiB cap; store it as an output ref");
    }

    const result = runtime.db
      .prepare(
        `INSERT INTO events (run_id, ts, path, type, actor, v, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, eventTs, draft.path, draft.type, draft.actor, draft.v ?? 1, payloadText);

    const envelope = {
      id: result.lastInsertRowid,
      runId,
      ts: new Date(eventTs).toISOString(),
      path: draft.path,
      type: draft.type,
      actor: draft.actor,
      v: draft.v ?? 1,
      payload,
    } as EventEnvelope;
    state.view = reduce(state.view, envelope);
    state.lastTs = eventTs;
    events.push(envelope);
    runtime.pending.push(envelope);
  }

  saveView(runtime, runId, state.view);
  reconcile(runtime, runId, state.view);
  return events;
}

export type { ListEventsOptions } from "./projection.js";
