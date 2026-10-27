import type { EventEnvelope } from "./events.js";
import { isKnownEventType } from "./events.js";
import { reduceExecutionEvent } from "./reducer-exec.js";
import { reduceLifecycleEvent } from "./reducer-lifecycle.js";
import { withEventId } from "./reducer-support.js";
import type { RunView } from "./reducer-types.js";
import { emptyRunView } from "./reducer-types.js";

export * from "./reducer-types.js";

export function reduce(view: RunView, envelope: EventEnvelope): RunView {
  if (!Number.isSafeInteger(envelope.id) || envelope.id <= view.lastEventId) return view;
  if (envelope.v !== 1 || !isKnownEventType(envelope.type)) {
    return withEventId(view, envelope);
  }
  const type = envelope.type;
  if (type.startsWith("node.") || type.startsWith("workspace.")) {
    return reduceExecutionEvent(view, envelope);
  }
  return reduceLifecycleEvent(view, envelope);
}

export function project(events: Iterable<EventEnvelope>): RunView {
  let view = emptyRunView();
  for (const event of events) view = reduce(view, event);
  return view;
}
