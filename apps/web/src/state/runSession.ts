import { type EventEnvelope, emptyRunView, type RunView, reduce } from "@relay/core";

export const CHECKPOINT_INTERVAL = 50;

export interface Checkpoint {
  /** Index into events; -1 is the empty view. */
  index: number;
  view: RunView;
}

export type SessionPhase = "loading" | "ready" | "reconnecting" | "overflow" | "error";

export interface RunSession {
  runId: string;
  phase: SessionPhase;
  head: RunView;
  /** The view shown in the UI. Null while loading or when a requested replay event is unavailable. */
  view: RunView | null;
  events: EventEnvelope[];
  checkpoints: Checkpoint[];
  /** Last event id included in the bootstrap snapshot/view. */
  watermark: number;
  /** Last applied (head) event id. Never decreases. */
  safeCursor: number;
  historyLoaded: boolean;
  historyError: string | null;
  replayAt: number | null;
  replayPending: boolean;
  replayMissing: boolean;
  offlineSince: number | null;
  error: string | null;
  errorCode: string | null;
  overflow: boolean;
}

export function createRunSession(runId: string): RunSession {
  return {
    runId,
    phase: "loading",
    head: emptyRunView(),
    view: null,
    events: [],
    checkpoints: [{ index: -1, view: emptyRunView() }],
    watermark: 0,
    safeCursor: 0,
    historyLoaded: false,
    historyError: null,
    replayAt: null,
    replayPending: false,
    replayMissing: false,
    offlineSince: null,
    error: null,
    errorCode: null,
    overflow: false,
  };
}

function sortUnique(events: readonly EventEnvelope[]): EventEnvelope[] {
  const byId = new Map<number, EventEnvelope>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

/** Merge event pages without re-applying or reordering anything. */
export function mergeHistory(session: RunSession, incoming: readonly EventEnvelope[]): RunSession {
  const ours = incoming.filter((event) => event.runId === session.runId);
  if (ours.length === 0) return session;
  const merged = sortUnique([...session.events, ...ours]);
  if (merged.length === session.events.length) return session;
  // If history is already known complete, rebuild checkpoints now so indexes stay correct
  // when an older event is inserted (e.g., live suffix before full history). Otherwise defer
  // until historyLoaded becomes true to avoid reducing an incomplete suffix from emptyRunView.
  if (session.historyLoaded) {
    return { ...session, events: merged, checkpoints: buildCheckpoints(merged) };
  }
  return { ...session, events: merged };
}

export interface BootstrapInput {
  view: RunView;
  watermark: number;
  events: readonly EventEnvelope[];
  historyLoaded: boolean;
}

/**
 * Bootstrap from one atomic run snapshot (view + watermark) and any event pages
 * fetched afterwards. Events at or below the watermark are already in the view;
 * newer events are applied once in id order.
 */
export function bootstrapSession(session: RunSession, input: BootstrapInput): RunSession {
  const merged = mergeHistory(session, input.events);
  const events = merged.events;
  let head = input.view;
  for (const event of events) {
    if (event.id <= input.watermark) continue;
    head = reduce(head, event);
  }
  const checkpoints = input.historyLoaded ? buildCheckpoints(events) : merged.checkpoints;
  const next: RunSession = {
    ...session,
    phase: "ready",
    head,
    events,
    checkpoints,
    watermark: Math.max(session.watermark, input.watermark),
    safeCursor: Math.max(session.safeCursor, head.lastEventId),
    historyLoaded: input.historyLoaded,
    historyError: null,
    offlineSince: null,
    overflow: false,
    error: null,
    errorCode: null,
  };
  return resolveReplay(next);
}

/** Apply one live event. Duplicates, stale ids and other runs are ignored. */
export function applyLiveEvent(session: RunSession, event: EventEnvelope): RunSession {
  if (event.runId !== session.runId) return session;
  if (event.id <= session.safeCursor) return session;
  const events = sortUnique([...session.events, event]);
  const head = reduce(session.head, event);
  // Preserve live head application but defer checkpoint construction until
  // complete history is loaded. Reducing the post-watermark suffix alone
  // from emptyRunView would replay a non-pending first node.state (e.g. ready/running)
  // and throw "First node.state must start from pending".
  const checkpoints = session.historyLoaded
    ? extendCheckpoints(session.checkpoints, events)
    : session.checkpoints;
  const next: RunSession = {
    ...session,
    phase: "ready",
    head,
    events,
    checkpoints,
    safeCursor: Math.max(session.safeCursor, head.lastEventId),
    offlineSince: null,
    overflow: false,
    error: null,
    errorCode: null,
    replayPending: session.replayAt !== null && !session.historyLoaded,
  };
  return next.replayAt === null ? { ...next, view: head } : next;
}

export function setHistoryLoaded(session: RunSession): RunSession {
  const checkpoints = buildCheckpoints(session.events);
  return resolveReplay({ ...session, checkpoints, historyLoaded: true, historyError: null });
}

export function markHistoryError(session: RunSession, message: string): RunSession {
  return { ...session, historyLoaded: false, historyError: message };
}

export function setReplayAt(session: RunSession, at: number | null): RunSession {
  if (at === null || !Number.isSafeInteger(at) || at < 1) {
    if (
      session.replayAt === null &&
      session.view === session.head &&
      !session.replayPending &&
      !session.replayMissing
    ) {
      return session;
    }
    return {
      ...session,
      replayAt: null,
      replayPending: false,
      replayMissing: false,
      view: session.head,
    };
  }
  // Same cursor: return the session untouched so the run canvas does not
  // re-render (and React Flow does not tear down its edge DOM) on redundant
  // re-applies, e.g. the ?at= effect firing after an eager scrub update.
  if (session.replayAt === at) return session;
  return resolveReplay({ ...session, replayAt: at });
}

export function resolveReplay(session: RunSession): RunSession {
  if (session.replayAt === null) {
    return {
      ...session,
      view: session.phase === "loading" ? null : session.head,
      replayPending: false,
      replayMissing: false,
    };
  }
  // If history is still incomplete, keep replay pending without reducing an incomplete suffix from empty
  if (!session.historyLoaded) {
    return {
      ...session,
      view: null,
      replayPending: true,
      replayMissing: false,
    };
  }
  const target = findViewAt(session.events, session.checkpoints, session.replayAt);
  if (target === null) {
    return {
      ...session,
      view: null,
      replayPending: false,
      replayMissing: true,
    };
  }
  return {
    ...session,
    view: target,
    replayPending: false,
    replayMissing: false,
  };
}

export function findViewAt(
  events: readonly EventEnvelope[],
  checkpoints: readonly Checkpoint[],
  eventId: number,
): RunView | null {
  const index = events.findIndex((event) => event.id === eventId);
  if (index === -1) return null;
  let checkpoint = checkpoints[0];
  if (checkpoint === undefined) checkpoint = { index: -1, view: emptyRunView() };
  for (const candidate of checkpoints) {
    if (candidate.index <= index) checkpoint = candidate;
    else break;
  }
  let view = checkpoint.view;
  for (let cursor = checkpoint.index + 1; cursor <= index; cursor += 1) {
    const event = events[cursor];
    if (event !== undefined) view = reduce(view, event);
  }
  return view;
}

export function buildCheckpoints(events: readonly EventEnvelope[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [{ index: -1, view: emptyRunView() }];
  let view = emptyRunView();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    view = reduce(view, event);
    if ((index + 1) % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({ index, view });
    }
  }
  return checkpoints;
}

function extendCheckpoints(
  current: readonly Checkpoint[],
  events: readonly EventEnvelope[],
): Checkpoint[] {
  const last = current.at(-1);
  if (last === undefined) return buildCheckpoints(events);
  if (events.length <= last.index + 1) return [...current];
  const checkpoints = [...current];
  let view = last.view;
  for (let index = last.index + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    view = reduce(view, event);
    if ((index + 1) % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({ index, view });
    }
  }
  return checkpoints;
}

export function markOffline(session: RunSession, now: number): RunSession {
  if (session.offlineSince !== null) return session;
  return {
    ...session,
    phase: "reconnecting",
    offlineSince: now,
    error: null,
  };
}

export function markOnline(session: RunSession): RunSession {
  if (session.offlineSince === null && session.phase !== "reconnecting") return session;
  return { ...session, phase: "ready", offlineSince: null };
}

export function showReconnectBanner(session: RunSession, now: number): boolean {
  return session.offlineSince !== null && now - session.offlineSince >= 3_000;
}

export function markOverflow(session: RunSession): RunSession {
  return {
    ...session,
    phase: "overflow",
    overflow: true,
    offlineSince: session.offlineSince,
  };
}

export function markError(
  session: RunSession,
  message: string,
  code: string | null = null,
): RunSession {
  return {
    ...session,
    phase: "error",
    error: message,
    errorCode: code,
    offlineSince: null,
  };
}

export function replayRange(session: RunSession): { min: number; max: number } {
  return {
    min: session.events[0]?.id ?? 0,
    max: session.events.at(-1)?.id ?? 0,
  };
}
