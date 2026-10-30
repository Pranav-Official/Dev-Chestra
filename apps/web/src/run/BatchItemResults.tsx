import type { ForeachItemsResponse, OutputPreview } from "@devchestra/api";
import { useEffect, useRef, useState } from "react";
import { api, classifyError } from "../api/client.js";
import { JsonView } from "../ui/JsonView.js";

/** Bounded, lazy inspection of completed item results; never hydrates a whole batch. */
export function BatchItemResults({
  runId,
  sourceId,
  processed,
  isReplay,
}: {
  runId: string;
  sourceId: string;
  processed: number;
  isReplay: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors.at(-1);
  const [data, setData] = useState<ForeachItemsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ index: number; preview: OutputPreview } | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => previewRequest.current?.abort(), []);
  useEffect(() => {
    if (isReplay) return;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void api
      .listForeachItems(
        runId,
        sourceId,
        { limit: 20, ...(cursor ? { cursor } : {}) },
        { signal: controller.signal },
      )
      .then((page) => {
        if (!controller.signal.aborted) setData(page);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(classifyError(failure).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    // Progress is a refresh signal; values themselves are fetched only on demand.
    void processed;
    return () => controller.abort();
  }, [runId, sourceId, cursor, processed, isReplay]);

  if (isReplay)
    return <p className="faint">Per-item result browsing is available in the live view.</p>;
  return (
    <div className="col" data-testid="batch-item-results">
      <h4>Recorded item results</h4>
      {error ? (
        <p className="inspector-error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="faint" role="status">
          Loading items…
        </p>
      ) : null}
      {data?.items.length === 0 && !busy ? <p className="faint">No items recorded yet.</p> : null}
      {data?.items.map((item) => (
        <div key={item.index} className="row wrap" style={{ gap: 8 }}>
          <span>
            Item {item.index + 1} · {item.status}
          </span>
          {item.outputId ? (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                previewRequest.current?.abort();
                const controller = new AbortController();
                previewRequest.current = controller;
                setResult(null);
                setError(null);
                void api
                  .getRunOutput(runId, item.outputId as string, { signal: controller.signal })
                  .then((preview) => {
                    if (!controller.signal.aborted) setResult({ index: item.index, preview });
                  })
                  .catch((failure: unknown) => {
                    if (!controller.signal.aborted) setError(classifyError(failure).message);
                  });
              }}
            >
              View result
            </button>
          ) : null}
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn sm ghost"
          disabled={cursors.length <= 1 || busy}
          onClick={() => setCursors((previous) => previous.slice(0, -1))}
        >
          Previous items
        </button>
        <button
          type="button"
          className="btn sm ghost"
          disabled={!data?.nextCursor || busy}
          onClick={() => {
            if (data?.nextCursor)
              setCursors((previous) => [...previous, data.nextCursor ?? undefined]);
          }}
        >
          Next items
        </button>
      </div>
      {result ? (
        <div>
          <h4>Item {result.index + 1} result</h4>
          {result.preview.truncated ? (
            <p className="faint">
              Result exceeds the preview limit; inspect its saved artifact or output reference.
            </p>
          ) : (
            <JsonView value={result.preview.data} testId="batch-item-result-preview" />
          )}
        </div>
      ) : null}
    </div>
  );
}
