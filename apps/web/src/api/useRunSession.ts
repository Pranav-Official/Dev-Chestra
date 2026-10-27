import { parseRunStreamEvent, type RunDetailResponse } from "@relay/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyLiveEvent,
  bootstrapSession,
  createRunSession,
  markError,
  markHistoryError,
  markOffline,
  markOnline,
  markOverflow,
  mergeHistory,
  type RunSession,
  setHistoryLoaded,
  setReplayAt,
} from "../state/runSession.js";
import { api, classifyError } from "./client.js";
import { collectHistory } from "./history.js";

function streamUrl(runId: string, after: number): string {
  return `/api/runs/${encodeURIComponent(runId)}/stream?after=${encodeURIComponent(String(after))}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunSessionHandle {
  session: RunSession;
  detail: RunDetailResponse | null;
  retry: () => void;
  setReplay: (eventId: number | null) => void;
}

export function useRunSession(runId: string): RunSessionHandle {
  const [session, setSession] = useState<RunSession>(() => createRunSession(runId));
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [reload, setReload] = useState(0);
  const sessionRef = useRef(session);
  const generationRef = useRef(0);

  const commit = useCallback((update: (current: RunSession) => RunSession): void => {
    const next = update(sessionRef.current);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const retry = useCallback((): void => setReload((value) => value + 1), []);
  const setReplay = useCallback(
    (eventId: number | null): void => {
      commit((current) => setReplayAt(current, eventId));
    },
    [commit],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload intentionally restarts this session effect
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    let stopped = false;
    let source: EventSource | null = null;
    let historyToken = 0;
    const initial = createRunSession(runId);
    sessionRef.current = initial;
    setSession(initial);
    setDetail(null);

    const alive = (): boolean => !stopped && generation === generationRef.current;
    const closeSource = (): void => {
      if (source !== null) {
        source.close();
        source = null;
      }
    };

    const failOrWait = async (error: unknown): Promise<boolean> => {
      if (!alive()) return false;
      const failure = classifyError(error);
      commit((current) => markError(current, failure.message, failure.code));
      if (failure.kind === "auth" || failure.kind === "notfound") return false;
      await sleep(3_000, controller.signal);
      return alive();
    };

    const loadSnapshot = async (): Promise<boolean> => {
      try {
        const next = await api.getRun(runId, { signal: controller.signal });
        if (!alive()) return false;
        setDetail(next);
        commit((current) =>
          bootstrapSession(current, {
            view: next.view,
            watermark: next.watermark,
            events: [],
            historyLoaded: false,
          }),
        );
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        return failOrWait(error);
      }
    };

    const loadHistory = async (watermark: number): Promise<void> => {
      historyToken += 1;
      const token = historyToken;
      if (watermark <= 0) {
        if (alive() && token === historyToken) {
          commit(setHistoryLoaded);
        }
        return;
      }
      try {
        const events = await collectHistory(
          (after) =>
            api.listRunEvents(
              runId,
              { after, upTo: watermark, limit: 500 },
              { signal: controller.signal },
            ),
          watermark,
        );
        if (!alive() || token !== historyToken) return;
        commit((current) => setHistoryLoaded(mergeHistory(current, events)));
      } catch (error) {
        if (controller.signal.aborted || !alive() || token !== historyToken) return;
        commit((current) => markHistoryError(current, classifyError(error).message));
      }
    };

    const terminalError = (): boolean =>
      sessionRef.current.errorCode === "E_AUTH" || sessionRef.current.errorCode === "E_NOT_FOUND";

    const connect = (): void => {
      if (!alive()) return;
      closeSource();
      const opened = new EventSource(streamUrl(runId, sessionRef.current.safeCursor), {
        withCredentials: true,
      });
      source = opened;
      const active = (): boolean => alive() && source === opened;

      opened.addEventListener("open", () => {
        if (active()) commit(markOnline);
      });

      opened.addEventListener("run", (raw) => {
        if (!active()) return;
        try {
          const parsed = parseRunStreamEvent({
            id: raw.lastEventId === "" ? null : raw.lastEventId,
            event: "run",
            data: raw.data,
            retry: null,
          });
          if (parsed?.event === "run") {
            commit((current) => applyLiveEvent(current, parsed.data));
          }
        } catch (error) {
          commit((current) => markError(current, classifyError(error).message, "E_PROTOCOL"));
          closeSource();
        }
      });

      opened.addEventListener("snapshot", (raw) => {
        if (!active()) return;
        try {
          const parsed = parseRunStreamEvent({
            id: raw.lastEventId === "" ? null : raw.lastEventId,
            event: "snapshot",
            data: raw.data,
            retry: null,
          });
          if (parsed?.event === "snapshot") {
            commit((current) =>
              bootstrapSession(current, {
                view: parsed.data.view,
                watermark: parsed.data.watermark,
                events: current.events,
                historyLoaded: current.historyLoaded,
              }),
            );
          }
        } catch {
          // A snapshot control frame is optional on cursor streams.
        }
      });

      opened.addEventListener("overflow", () => {
        if (!active()) return;
        commit(markOverflow);
        closeSource();
        void recover();
      });

      opened.onerror = () => {
        if (active()) commit((current) => markOffline(current, Date.now()));
      };
    };

    const detailWatermark = (): number => sessionRef.current.watermark;

    async function recover(): Promise<void> {
      while (alive()) {
        if (await loadSnapshot()) {
          connect();
          void loadHistory(detailWatermark());
          return;
        }
        if (!alive() || terminalError()) return;
        await sleep(3_000, controller.signal);
      }
    }

    const onOffline = (): void => {
      if (!alive()) return;
      closeSource();
      commit((current) => markOffline(current, Date.now()));
    };
    const onOnline = (): void => {
      if (!alive()) return;
      if (sessionRef.current.safeCursor > 0 || sessionRef.current.head.lastEventId > 0) {
        connect();
      }
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    const start = async (): Promise<void> => {
      while (alive()) {
        if (await loadSnapshot()) {
          connect();
          void loadHistory(detailWatermark());
          return;
        }
        if (!alive() || terminalError()) return;
        await sleep(3_000, controller.signal);
      }
    };

    void start();

    return () => {
      stopped = true;
      generationRef.current += 1;
      controller.abort();
      closeSource();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [runId, reload, commit]);

  return { session, detail, retry, setReplay };
}
