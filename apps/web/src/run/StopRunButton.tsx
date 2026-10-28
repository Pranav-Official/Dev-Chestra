import { isTerminalRunStatus, type RunStatus } from "@relay/core";
import { OctagonX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, classifyError } from "../api/client.js";

/**
 * Persistent run-level stop control. It is driven by the authoritative live
 * head status (`session.head.status`), never by the replay view, so stopping
 * stays available (and correctly labelled) while replaying history.
 *
 * The button never claims "Cancelled" optimistically: a successful POST only
 * records that the stop was requested, and the Cancelled state arrives via the
 * live stream, at which point this control unmounts.
 */
export function StopRunButton({
  runId,
  headStatus,
  isReplay,
}: {
  runId: string;
  headStatus: RunStatus;
  isReplay: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const requestedRef = useRef(false);
  const headRef = useRef(headStatus);
  headRef.current = headStatus;

  const cancellable = !isTerminalRunStatus(headStatus);
  // A 202 is accepted, not confirmed: the controller reports the early
  // running status while cancellation completes asynchronously, so the
  // control stays busy until live terminal evidence arrives via the stream.
  const busy = pending || requested;

  // Completion/cancel race: the live run reached a terminal state (finished,
  // failed, or backend-confirmed cancel) while a request was in flight. There
  // is nothing left to stop, so drop pending/error/requested state silently.
  useEffect(() => {
    if (!cancellable && (pendingRef.current || requestedRef.current)) {
      pendingRef.current = false;
      requestedRef.current = false;
      setPending(false);
      setRequested(false);
      setError(null);
    }
  }, [cancellable]);

  if (!cancellable) return null;

  const label = busy ? "Stopping…" : isReplay ? "Stop live run" : "Stop run";

  const stop = async (): Promise<void> => {
    // Fence both Stop and Retry synchronously, including while an accepted
    // request is still awaiting live terminal confirmation.
    if (pendingRef.current || requestedRef.current) return;
    pendingRef.current = true;
    requestedRef.current = false;
    setPending(true);
    setRequested(false);
    setError(null);
    try {
      await api.cancelRun(runId);
      // 202 accepted is not confirmation. Stay in Stopping… until the live
      // head flips to a terminal status; the stream owns "Cancelled".
      if (!isTerminalRunStatus(headRef.current)) {
        requestedRef.current = true;
        setRequested(true);
      }
    } catch (err) {
      // The run may have finished between click and response — a terminal
      // head means there is nothing left to stop, so swallow the error.
      if (isTerminalRunStatus(headRef.current)) return;
      setError(classifyError(err).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <span className="run-stop-wrap">
      <button
        type="button"
        className="btn sm danger"
        data-testid="run-stop"
        disabled={busy}
        aria-busy={busy}
        aria-label={isReplay ? "Stop the live run" : "Stop this run"}
        title={
          isReplay
            ? "Stop the live run (replay position is unaffected)"
            : "Request the backend to cancel this run"
        }
        onClick={() => void stop()}
      >
        <OctagonX size={12} aria-hidden="true" />
        {label}
      </button>
      {busy && requested ? (
        <span className="run-stop-note" role="status" data-testid="run-stop-requested">
          {isReplay ? "Confirming the live run stopped…" : "Confirming the run stopped…"}
        </span>
      ) : null}
      {error !== null ? (
        <span className="run-stop-error" role="alert" data-testid="run-stop-error">
          <span className="msg" title={error}>
            {error}
          </span>
          <button
            type="button"
            className="btn sm"
            data-testid="run-stop-retry"
            onClick={() => void stop()}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn sm ghost icon"
            data-testid="run-stop-dismiss"
            aria-label="Dismiss stop error"
            onClick={() => setError(null)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </span>
  );
}
