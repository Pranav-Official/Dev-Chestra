// biome-ignore-all lint/a11y/noNoninteractiveTabindex: scrollable transcript must be keyboard reachable
import { FileWarning, Info, LockKeyhole } from "lucide-react";
import { useMemo } from "react";
import { classifyError } from "../api/client.js";
import { useTranscriptPages } from "../api/hooks.js";
import { InlineError } from "../ui/states.js";

const MAX_RENDERED_LINES = 2_000;

export function TranscriptPanel({
  runId,
  path,
  isReplay,
}: {
  runId: string;
  path: string | null;
  isReplay: boolean;
}) {
  const query = useTranscriptPages(runId, path, !isReplay && path !== null);
  const pages = query.data?.pages ?? [];
  const allLines = useMemo(() => pages.flatMap((page) => page.lines), [pages]);
  const lines = allLines.slice(-MAX_RENDERED_LINES);
  const first = pages[0];

  if (isReplay) {
    return (
      <div className="note accent" data-testid="transcript-panel">
        <LockKeyhole size={15} aria-hidden="true" />
        <span>Latest transcript content is unavailable in replay. Return to live to load it.</span>
      </div>
    );
  }
  if (path === null) {
    return (
      <div className="note" data-testid="transcript-panel">
        <Info size={15} aria-hidden="true" />
        <span>Select a node to load its transcript.</span>
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="col" data-testid="transcript-panel" aria-busy="true">
        <div className="skeleton" style={{ width: "60%" }} />
        <div className="skeleton" style={{ width: "100%" }} />
        <div className="skeleton" style={{ width: "84%" }} />
      </div>
    );
  }
  if (query.error) {
    return (
      <div data-testid="transcript-panel">
        <InlineError message={classifyError(query.error).message} />
      </div>
    );
  }
  if (first === undefined || first.state === "unavailable") {
    return (
      <div className="note" data-testid="transcript-panel">
        <FileWarning size={15} aria-hidden="true" />
        <span>No transcript is available for this execution.</span>
      </div>
    );
  }
  if (first.state === "pending") {
    return (
      <div className="note" data-testid="transcript-panel">
        <Info size={15} aria-hidden="true" />
        <span>The transcript is not available yet. It appears after the agent writes to it.</span>
      </div>
    );
  }

  return (
    <div data-testid="transcript-panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="faint">
          {lines.length} lines
          {first.attempt === null ? "" : ` · attempt ${first.attempt}`}
          {first.bytes === null ? "" : ` · ${first.bytes} bytes`}
        </span>
        <span className="sp" />
        {query.hasNextPage ? (
          <button
            type="button"
            className="btn sm"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more lines"}
          </button>
        ) : null}
      </div>
      {allLines.length > MAX_RENDERED_LINES ? (
        <p className="faint" style={{ marginBottom: 6 }}>
          Showing the newest {MAX_RENDERED_LINES.toLocaleString()} lines. Load more to keep going.
        </p>
      ) : null}
      <div
        className="transcript"
        role="log"
        aria-label="Transcript"
        data-testid="transcript"
        tabIndex={0}
      >
        {lines.map((line) => (
          <div key={`${line.ts ?? "line"}-${line.kind}-${line.text}`} data-testid="transcript-line">
            <span className="faint">{line.ts ?? "—"}</span>{" "}
            <span className="faint">[{line.kind}]</span> <span>{line.text}</span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Transcript text is untrusted agent output and is rendered as plain text.
      </p>
    </div>
  );
}
