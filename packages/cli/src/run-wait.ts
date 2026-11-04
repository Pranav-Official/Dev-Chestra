import {
  type ApiClient,
  ApiTransportError,
  type CompactRunStatus,
  kindOfPath,
  type WaitUntil,
  type WakeReason,
  wakeReason,
} from "@devchestra/api";
import { fetchRunStatus } from "./run-status.js";

/** Exit code for "the run is still going": a timeout, or a change with the run still active. */
export const WAIT_STILL_RUNNING = 10;
/** Quiet period after a waking event, so a burst of events yields one answer. */
const DEFAULT_SETTLE_MS = 300;
const RECONNECT_DELAY_MS = 500;
const REPLAY_PAGE = 200;
const MAX_REASONS = 5;

export type WaitClient = Pick<
  ApiClient,
  "getRun" | "getExecutionTranscript" | "listRunEvents" | "streamRunEvents"
>;

export interface WaitOptions {
  timeoutMs: number;
  until: WaitUntil;
  /** Event id of the last status the caller saw; changes after it are not missed. */
  after?: number;
  settleMs?: number;
}

export interface WaitResult {
  status: CompactRunStatus;
  timedOut: boolean;
  /** What ended the wait; empty when it timed out. */
  reasons: string[];
  exitCode: number;
}

const FINISHED = new Set(["succeeded", "failed", "rejected", "cancelled"]);
const NEEDS_PERSON = new Set(["paused", "waiting_approval"]);

/** Same mapping as `run watch`, plus WAIT_STILL_RUNNING while the run is active. */
export function waitExitCode(status: string): number {
  if (status === "succeeded") return 0;
  if (status === "rejected") return 2;
  if (status === "cancelled") return 3;
  if (NEEDS_PERSON.has(status)) return 5;
  if (status === "failed") return 1;
  return WAIT_STILL_RUNNING;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Blocks until something worth reporting happens to a run, then returns its
 * compact status. The event stream is only the wake-up: the answer always comes
 * from a fresh status fetch, so it never depends on interpreting event payloads
 * beyond deciding whether to look.
 */
export async function waitForRun(
  client: WaitClient,
  runId: string,
  options: WaitOptions,
): Promise<WaitResult> {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
  const finish = async (reasons: string[], timedOut: boolean): Promise<WaitResult> => {
    const { status } = await fetchRunStatus(client, runId);
    return { status, timedOut, reasons, exitCode: waitExitCode(status.status) };
  };
  try {
    const initial = await client.getRun(runId, { signal: deadline.signal });
    const kindOf = (path: string) => kindOfPath(initial.snapshot, path);
    const wake = (event: Parameters<typeof wakeReason>[0]) =>
      wakeReason(event, kindOf, options.until);

    const state = initial.view.status;
    if (FINISHED.has(state)) return await finish([`run ${state}`], false);
    if (options.after === undefined && NEEDS_PERSON.has(state))
      return await finish([`run ${state}`], false);

    let cursor = initial.watermark;
    if (options.after !== undefined) {
      // Changes between the caller's last status and now: replay them before streaming.
      let from = options.after;
      for (let more = true; more; ) {
        const page = await client.listRunEvents(
          runId,
          { after: from, upTo: initial.watermark, limit: REPLAY_PAGE },
          { signal: deadline.signal },
        );
        const hits = page.events.map((event) => wake(event)).filter((hit) => hit !== null);
        if (hits.length > 0) return await finish(reasonsOf(hits), false);
        from = page.nextAfter;
        more = page.hasMore;
      }
    }

    while (!deadline.signal.aborted) {
      const woke = await streamUntilWake(client, runId, cursor, wake, settleMs, deadline.signal);
      cursor = woke.cursor;
      if (woke.reasons !== null) return await finish(woke.reasons, false);
      if (!deadline.signal.aborted) await sleep(RECONNECT_DELAY_MS, deadline.signal);
    }
    return await finish([], true);
  } catch (error) {
    if (deadline.signal.aborted) return await finish([], true);
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

function reasonsOf(hits: readonly WakeReason[]): string[] {
  return [...new Set(hits.map((hit) => hit.reason))].slice(0, MAX_REASONS);
}

/**
 * Follows the run's stream from `cursor` until a waking event has been quiet for
 * `settleMs`. Returns reasons=null when the stream ended (or dropped) without one,
 * so the caller can reconnect from the returned cursor.
 */
async function streamUntilWake(
  client: WaitClient,
  runId: string,
  cursor: number,
  wake: (event: Parameters<typeof wakeReason>[0]) => WakeReason | null,
  settleMs: number,
  signal: AbortSignal,
): Promise<{ cursor: number; reasons: string[] | null }> {
  const stream = new AbortController();
  const stop = () => stream.abort();
  signal.addEventListener("abort", stop, { once: true });
  const hits: WakeReason[] = [];
  let last = cursor;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let settled: (() => void) | undefined;
  const quiet = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const consume = (async () => {
    try {
      for await (const message of client.streamRunEvents(
        runId,
        { after: cursor },
        { signal: stream.signal },
      )) {
        if (message.event === "overflow") {
          hits.push({ category: "status", reason: "event stream overflowed; status refreshed" });
          return;
        }
        if (message.event !== "run") continue;
        last = message.id;
        const hit = wake(message.data);
        if (hit === null) continue;
        hits.push(hit);
        clearTimeout(settle);
        settle = setTimeout(() => settled?.(), settleMs);
      }
    } catch (error) {
      if (!(error instanceof ApiTransportError) && !stream.signal.aborted) throw error;
    }
  })();
  try {
    // Resolves when the settle timer fires, or the stream ends/drops/overflows first.
    await Promise.race([quiet, consume]);
  } finally {
    clearTimeout(settle);
    stream.abort();
    signal.removeEventListener("abort", stop);
    await consume.catch(() => undefined);
  }
  return { cursor: last, reasons: hits.length > 0 ? reasonsOf(hits) : null };
}
