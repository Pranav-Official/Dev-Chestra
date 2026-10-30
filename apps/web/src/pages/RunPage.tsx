import type { EventEnvelope } from "@devchestra/core";
import { Info, Radio, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useBootstrap } from "../api/hooks.js";
import { useRunSession } from "../api/useRunSession.js";
import { DetailPanel } from "../run/DetailPanel.js";
import { EventsPanel } from "../run/EventsPanel.js";
import { ReplayBar } from "../run/ReplayBar.js";
import { RunCanvas } from "../run/RunCanvas.js";
import { StopRunButton } from "../run/StopRunButton.js";
import { TranscriptPanel } from "../run/TranscriptPanel.js";
import { Topbar } from "../shell/Topbar.js";
import { showReconnectBanner } from "../state/runSession.js";
import { formatCost, formatDuration, formatTime, formatTokens } from "../ui/format.js";
import {
  AuthState,
  LoadingState,
  MissingProjectBanner,
  NetworkError,
  NotFoundState,
} from "../ui/states.js";

type Tab = "detail" | "events" | "transcript";

function parseTab(value: string | null): Tab {
  return value === "events" || value === "transcript" ? value : "detail";
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function RunRoute() {
  const { rid = "" } = useParams();
  return <RunPage key={rid} rid={rid} />;
}

function RunPage({ rid }: { rid: string }) {
  const { pid = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const bootstrap = useBootstrap();
  const { session, detail, retry, setReplay } = useRunSession(rid);
  const now = useNow(session.offlineSince !== null);
  const tab = parseTab(params.get("tab"));
  const path = params.get("path");
  const atParam = params.get("at");
  const atNumber = atParam === null ? null : Number(atParam);
  const malformedAt =
    atParam !== null && (atNumber === null || !Number.isSafeInteger(atNumber) || atNumber < 1);
  const project = bootstrap.data?.projects.find((item) => item.id === pid);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new event can make a pending replay target resolvable
  useEffect(() => {
    if (!session.historyLoaded) return;
    if (atParam === null || malformedAt || atNumber === null) {
      setReplay(null);
      return;
    }
    setReplay(atNumber);
  }, [atParam, atNumber, malformedAt, session.historyLoaded, session.events.length, setReplay]);

  const update = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const selectReplay = (eventId: number | null): void => {
    // Apply the target immediately so rapid keyboard scrubs accumulate step by
    // step instead of collapsing to one step. The URL stays the source of
    // truth for deep links; the ?at= effect above re-applies the same value
    // idempotently once it runs.
    setReplay(eventId);
    update({ at: eventId === null ? null : String(eventId) });
  };

  const view = session.view;
  const run = detail?.run ?? null;
  const workflowName = run?.workflowName ?? detail?.snapshot.name ?? run?.workflowId ?? "Workflow";
  const crumbs = [
    { label: "Projects", to: "/" },
    { label: project?.name ?? run?.projectName ?? pid, to: `/p/${pid}/runs` },
    { label: workflowName },
    { label: `Run #${run?.runNumber ?? view?.runNumber ?? "—"}` },
  ];

  // Replay derivations live above the topbar so the run-level stop control can
  // rely on the authoritative live head status even while replaying history.
  const replayPending = atParam !== null && !malformedAt && session.replayAt === null;
  const replayMissing = malformedAt || session.replayMissing;
  const replayUnavailable = atParam !== null && session.historyError !== null;
  const isReplay = session.replayAt !== null && !session.replayMissing;
  // The stop control is run-level: it ignores the selected node/tab and the
  // replay position, and stays mounted while the live head is nonterminal.
  // `readonly` only covers snapshot editing, so it never suppresses the stop.
  const stopControl =
    (view !== null || session.phase === "error") &&
    session.errorCode !== "E_AUTH" &&
    session.errorCode !== "E_NOT_FOUND" ? (
      <StopRunButton
        runId={rid}
        headStatus={session.head.lastEventId > 0 ? session.head.status : null}
        isReplay={isReplay}
      />
    ) : null;

  const topbar = (
    <Topbar
      crumbs={crumbs}
      {...(view === null ? {} : { status: { value: view.status, testId: "run-status" } })}
      readonly
      actions={
        <>
          {stopControl}
          <Link className="btn sm" to={`/p/${pid}/runs`}>
            Project runs
          </Link>
        </>
      }
    />
  );

  const failure =
    session.phase === "error"
      ? { code: session.errorCode, message: session.error ?? "The run could not be loaded." }
      : null;
  if (failure?.code === "E_AUTH") {
    return (
      <>
        {topbar}
        <div className="content">
          <AuthState />
        </div>
      </>
    );
  }
  if (failure?.code === "E_NOT_FOUND") {
    return (
      <>
        {topbar}
        <div className="content">
          <NotFoundState
            title="Run not found"
            message={`No run has the id "${rid}" in this project.`}
            backTo={`/p/${pid}/runs`}
            backLabel="Back to runs"
          />
        </div>
      </>
    );
  }
  if (failure) {
    return (
      <>
        {topbar}
        <div className="content">
          <NetworkError message={failure.message} onRetry={retry} />
        </div>
      </>
    );
  }

  if (view === null || replayPending || replayUnavailable || replayMissing) {
    return (
      <>
        {topbar}
        {replayPending ? (
          <ReplayBanner variant="pending" text="Loading event history for replay…" />
        ) : null}
        {replayUnavailable ? (
          <ReplayBanner variant="missing" text="Replay history could not be loaded." />
        ) : null}
        {replayMissing ? (
          <ReplayBanner
            variant="missing"
            text={`Event ${atParam ?? ""} is not part of this run.`}
            onLive={() => update({ at: null })}
          />
        ) : null}
        <div className="content">
          {replayPending || replayMissing || replayUnavailable ? (
            <div className="state-page">
              <div className="state-card">
                <Info size={24} aria-hidden="true" />
                <div className="title">
                  {replayUnavailable
                    ? "Replay unavailable"
                    : replayPending
                      ? "Loading history"
                      : "Event not available"}
                </div>
                <p>
                  {replayUnavailable
                    ? "The full event history could not be loaded, so this viewer will not pretend to replay a position. Live state is hidden for this URL."
                    : replayPending
                      ? "The viewer is paging the full event history before it shows a replay position."
                      : "No live run state is shown while a replay position cannot be resolved."}
                </p>
                <button type="button" className="btn" onClick={() => update({ at: null })}>
                  <Radio size={14} aria-hidden="true" />
                  Back to live
                </button>
              </div>
            </div>
          ) : (
            <LoadingState label="Loading the run snapshot and event stream…" />
          )}
        </div>
      </>
    );
  }

  const selectedNode = detail?.snapshot.graph.nodes.find(
    (node) => node.id === path || path?.endsWith(`/${node.id}`),
  );
  const nodeLabel = selectedNode?.name ?? null;
  const reconnect = showReconnectBanner(session, now);

  const selectEvent = (event: EventEnvelope): void => {
    update({
      ...(event.path === "" ? {} : { path: event.path }),
      tab: "detail",
    });
  };

  return (
    <div
      className="run-page"
      data-testid="run-page"
      data-run-id={rid}
      data-head-event-id={session.head.lastEventId}
    >
      {topbar}
      {project?.missing ? (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <MissingProjectBanner projectName={project.name} />
        </div>
      ) : null}
      {reconnect ? (
        <div className="banner amber" data-testid="connection-banner" role="status">
          <Unplug size={16} aria-hidden="true" />
          <span>
            <b>Reconnecting…</b> Live updates are paused. Last applied event #{session.safeCursor}.
            The view stays available.
          </span>
        </div>
      ) : null}
      {session.overflow || session.phase === "overflow" ? (
        <div className="banner blue" data-testid="overflow-banner" role="status">
          <Info size={16} aria-hidden="true" />
          <span>
            The event stream overflowed. Refetching the snapshot and history from the last applied
            event #{session.safeCursor}.
          </span>
        </div>
      ) : null}
      {isReplay && session.replayAt !== null ? (
        <ReplayBanner
          variant="replay"
          text={`Replaying event ${session.replayAt} of ${session.head.lastEventId}`}
          onLive={() => update({ at: null })}
        />
      ) : null}
      {session.historyError ? (
        <div className="banner amber" role="status">
          <Info size={16} aria-hidden="true" />
          <span>
            <b>Replay history unavailable.</b> {session.historyError} Live state continues.
          </span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={retry}>
            Reload
          </button>
        </div>
      ) : null}

      <div className="run-toolbar">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail?.snapshot.name ?? workflowName}
          </b>
          <span className="faint mono">snapshot</span>
        </span>
        <span className="sp" />
        <span className="chip">Run #{run?.runNumber ?? view.runNumber}</span>
        <span className="chip">{run?.kind ?? "run"}</span>
        <span className="chip optional">{formatCost(view.budget.usd)}</span>
        <span className="chip optional">{formatTokens(view.budget.tokens)} tokens</span>
        <span className="chip optional">{formatDuration(view.budget.activeMs)} active</span>
        <span className="chip optional">
          {run?.startedAt ? formatTime(run.startedAt) : "not started"}
        </span>
      </div>

      <div className="run-split">
        {detail ? (
          <RunCanvas
            snapshot={detail.snapshot}
            view={view}
            runId={rid}
            isReplay={isReplay}
            selectedPath={path}
            {...(detail.layout === undefined ? {} : { layout: detail.layout })}
            onSelect={(nodePath) => update({ path: nodePath, tab: "detail" })}
          />
        ) : (
          <div className="canvas-wrap">
            <LoadingState label="Loading workflow snapshot…" />
          </div>
        )}
        <aside className="panel" aria-label="Run details">
          <div className="panel-head" role="tablist">
            {(["detail", "events", "transcript"] as Tab[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={`tab${tab === item ? " active" : ""}`}
                data-testid={`tab-${item}`}
                onClick={() => update({ tab: item })}
              >
                {item === "detail" ? "Details" : item === "events" ? "Events" : "Transcript"}
                {item === "events" ? <span className="faint">{session.events.length}</span> : null}
              </button>
            ))}
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable panel must be keyboard reachable */}
          <div className="panel-body" data-testid="detail-panel" tabIndex={0}>
            {tab === "detail" ? (
              <DetailPanel
                run={run}
                runId={rid}
                path={path}
                nodeLabel={nodeLabel}
                view={view}
                events={session.events}
                isReplay={isReplay}
                snapshot={detail?.snapshot ?? null}
                onSelectPath={(next) => update({ path: next, tab: "detail" })}
              />
            ) : tab === "events" ? (
              <EventsPanel
                events={session.events}
                upTo={view.lastEventId}
                selectedEventId={isReplay ? session.replayAt : null}
                onSelect={selectEvent}
              />
            ) : (
              <TranscriptPanel runId={rid} path={path} isReplay={isReplay} />
            )}
          </div>
        </aside>
      </div>

      {session.historyLoaded ? (
        <ReplayBar
          events={session.events}
          replayAt={session.replayAt}
          headEventId={session.head.lastEventId}
          onChange={(eventId) => selectReplay(eventId)}
        />
      ) : (
        <div className="replay-bar" aria-busy="true">
          <span className="faint">Loading event history for replay…</span>
          {session.historyError ? (
            <>
              <span className="sp" />
              <button type="button" className="btn sm" onClick={retry}>
                Retry
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ReplayBanner({
  text,
  variant,
  onLive,
}: {
  text: string;
  variant: "replay" | "pending" | "missing";
  onLive?: () => void;
}) {
  const testId =
    variant === "pending"
      ? "replay-pending-banner"
      : variant === "missing"
        ? "replay-missing-banner"
        : "replay-banner";
  return (
    <div className="banner blue" role="status" data-testid={testId}>
      <Info size={16} aria-hidden="true" />
      <span>
        <b>{text}</b>
      </span>
      <span className="sp" />
      {onLive ? (
        <button type="button" className="btn sm" onClick={onLive}>
          Back to live
        </button>
      ) : null}
    </div>
  );
}

export { parseTab };
