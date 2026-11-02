import type {
  PollIssue,
  PollProbeResult,
  PollTriggerState,
  PollTriggerStatus,
} from "@devchestra/api";
import { POLL_INTERVAL_LIMITS } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Timer } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError } from "../../api/client.js";
import {
  describePollFailure,
  invalidatePollTrigger,
  type PollFailure,
  useArmPollTrigger,
  useDisarmPollTrigger,
  usePollTrigger,
  useProbePollTrigger,
  useRefreshPollTrigger,
} from "../../api/polling.js";
import "../../styles/editor-poll.css";
import { JsonView } from "../../ui/JsonView.js";
import { ConfirmDialog } from "../controls/ConfirmDialog.js";
import { Dialog } from "../controls/Dialog.js";

const DESCRIPTION =
  "A timer probe can start this workflow on a schedule. Manual runs stay available whether or not the trigger is armed.";

const STATE_HEADING: Record<PollTriggerState, string> = {
  off: "Not armed",
  current: "Armed",
  stale: "Armed, out of date",
  invalid: "Armed, saved workflow invalid",
  failing: "Armed, last probe failed",
};

const STATE_DETAIL: Record<PollTriggerState, string> = {
  off: "The probe does not run until the trigger is armed.",
  current: "The probe runs on the armed revision, which matches the saved workflow.",
  stale:
    "The saved workflow changed after arming. The probe keeps running the armed revision until you refresh it.",
  invalid:
    "The saved workflow is invalid or no longer declares polling. The last valid armed revision keeps running.",
  failing: "The poller keeps trying until the next probe succeeds or it disarms itself.",
};

const OUTCOME_TONE: Record<string, string> = {
  triggered: "green",
  nothing: "",
  duplicate: "blue",
  skipped: "amber",
  failed: "red",
};

interface Chip {
  label: string;
  tone: string;
}

function chipFor(status: PollTriggerStatus | undefined, failed: boolean): Chip {
  if (status === undefined) {
    return failed ? { label: "Polling unknown", tone: "" } : { label: "Polling…", tone: "" };
  }
  switch (status.state) {
    case "current":
      return { label: "Polling armed", tone: "green" };
    case "stale":
      return { label: "Polling stale", tone: "amber" };
    case "failing":
      return { label: "Polling failing", tone: "amber" };
    case "invalid":
      return { label: "Polling invalid", tone: "red" };
    case "off":
      return { label: "Polling off", tone: "" };
  }
}

function formatTime(value: number | null): string | null {
  return value === null
    ? null
    : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatInterval(seconds: number | null): string | null {
  if (seconds === null) return null;
  const unit = (count: number, word: string): string =>
    `Every ${count === 1 ? "" : `${count} `}${word}${count === 1 ? "" : "s"}`;
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

function FailureNote({ failure }: { failure: PollFailure }) {
  return (
    <div className="note red" role="alert">
      <AlertTriangle size={14} aria-hidden="true" />
      <div>
        <span>{failure.message}</span>
        {failure.issues.length === 0 ? null : <IssueList issues={failure.issues} />}
      </div>
    </div>
  );
}

function IssueList({ issues }: { issues: readonly PollIssue[] }) {
  return (
    <ul className="poll-issues">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.message}`}>
          <span className="mono">{issue.code}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

function ProbeResult({ result }: { result: PollProbeResult }) {
  const tone = result.outcome === "failed" ? "red" : result.outcome === "found" ? "green" : "";
  const heading =
    result.outcome === "failed"
      ? "Probe failed"
      : result.outcome === "found"
        ? "Found parameters"
        : "Nothing found";
  return (
    <section className="poll-section poll-result" data-tone={tone} aria-label="Probe result">
      <h3>
        <span className={`pill ${tone}`}>{heading}</span>
        <span className="poll-result-time">Took {result.durationMs} ms.</span>
      </h3>
      {result.outcome === "failed" ? (
        <div className="note red" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{result.error ?? "The probe failed."}</span>
        </div>
      ) : result.outcome === "nothing" ? (
        <p>No run would start: the probe found nothing.</p>
      ) : (
        <>
          <p>The probe found parameters that would start a run.</p>
          {result.params === null ? null : (
            <JsonView value={result.params} testId="poll-probe-params" label="Probe parameters" />
          )}
          {result.dedupeKey === null ? null : (
            <p className="poll-dedupe">
              <span className="faint">Dedupe key</span>
              <span className="mono">{result.dedupeKey}</span>
            </p>
          )}
          {result.wouldSkipAsDuplicate ? (
            <p className="note amber" role="note">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>A real tick would skip this result as a repeat.</span>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The editor's polling trigger: a header chip that shows the armed state, and
 * a dialog that arms, disarms, refreshes and test-probes it. The server reads
 * the saved file, so arming is blocked while the editor holds unsaved edits.
 */
export function PollTriggerControl({
  projectId,
  workflowId,
  savedRevision,
  armBlockedReason,
  probeType,
}: {
  projectId: string;
  workflowId: string;
  /** Changes after each successful save. A root save can refresh the armed revision on the server. */
  savedRevision: number;
  /** Why arming is blocked right now (unsaved edits, invalid form, validation errors), or null. */
  armBlockedReason: string | null;
  /** The saved start node's probe type, which sets the minimum interval. */
  probeType: "shell" | "agent";
}) {
  const queryClient = useQueryClient();
  const trigger = usePollTrigger(projectId, workflowId);
  const arm = useArmPollTrigger(projectId, workflowId);
  const disarm = useDisarmPollTrigger(projectId, workflowId);
  const refresh = useRefreshPollTrigger(projectId, workflowId);
  const probeNow = useProbePollTrigger(projectId, workflowId);
  const [open, setOpen] = useState(false);
  const [confirmDisarm, setConfirmDisarm] = useState(false);
  const [probeResult, setProbeResult] = useState<PollProbeResult | null>(null);
  const [amount, setAmount] = useState("5");
  const [unit, setUnit] = useState<"minutes" | "seconds">("minutes");
  const intervalEdited = useRef(false);
  const armHintId = useId();

  const lastRevision = useRef(savedRevision);
  useEffect(() => {
    if (lastRevision.current === savedRevision) return;
    lastRevision.current = savedRevision;
    void invalidatePollTrigger(queryClient, projectId, workflowId);
  }, [savedRevision, projectId, workflowId, queryClient]);

  const status = trigger.data;
  // Start the form from the interval the poller is armed with, until the person edits it.
  const armedSeconds = status?.intervalSeconds ?? null;
  useEffect(() => {
    if (armedSeconds === null || intervalEdited.current) return;
    if (armedSeconds % 60 === 0) {
      setAmount(String(armedSeconds / 60));
      setUnit("minutes");
    } else {
      setAmount(String(armedSeconds));
      setUnit("seconds");
    }
  }, [armedSeconds]);
  const chip = chipFor(status, trigger.isError);
  const minInterval = POLL_INTERVAL_LIMITS[probeType].min;
  const parsed = Number(amount.trim());
  const intervalError =
    amount.trim() === ""
      ? "Enter an interval."
      : !Number.isSafeInteger(parsed)
        ? "The interval must be a whole number."
        : parsed * (unit === "minutes" ? 60 : 1) < minInterval
          ? `The interval must be at least ${minInterval} seconds for ${probeType} probes.`
          : parsed * (unit === "minutes" ? 60 : 1) > POLL_INTERVAL_LIMITS[probeType].max
            ? "The interval must be at most 24 hours."
            : null;
  const intervalSeconds = intervalError === null ? parsed * (unit === "minutes" ? 60 : 1) : null;
  const armHint =
    status === undefined
      ? null
      : (armBlockedReason ??
        (status.supported
          ? intervalError
          : "Turn on Accept polling triggers in the Start node, then save."));
  const armDisabled = arm.isPending || armHint !== null || status === undefined;

  const armNow = (): void => {
    if (intervalSeconds === null) return;
    arm.mutate(intervalSeconds);
  };

  return (
    <>
      <button
        type="button"
        className={`pill ${chip.tone}`}
        data-testid="poll-trigger-chip"
        data-state={status?.state ?? (trigger.isError ? "unknown" : "loading")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Re-read on open: the last tick changes outside the editor.
          setOpen(true);
          void trigger.refetch();
        }}
      >
        <Timer size={12} aria-hidden="true" />
        {chip.label}
      </button>

      <Dialog
        open={open}
        title="Polling trigger"
        description={DESCRIPTION}
        onClose={() => setOpen(false)}
        testId="poll-trigger-dialog"
        footer={
          <p className="poll-footnote">Polling only runs while the DevChestra server is running.</p>
        }
      >
        <div className="poll-panel">
          {status === undefined ? (
            trigger.isError ? (
              <div className="note red" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{classifyError(trigger.error).message}</span>
                <button type="button" className="btn sm" onClick={() => void trigger.refetch()}>
                  Try again
                </button>
              </div>
            ) : (
              <p className="faint">Loading polling status…</p>
            )
          ) : (
            <>
              <div className="poll-status" data-tone={chip.tone === "" ? "neutral" : chip.tone}>
                <span className="poll-dot" aria-hidden="true" />
                <div className="poll-status-text">
                  <p className="poll-state">{STATE_HEADING[status.state]}</p>
                  <p className="poll-state-detail">{STATE_DETAIL[status.state]}</p>
                </div>
                {status.armed && formatInterval(status.intervalSeconds) !== null ? (
                  <span className="poll-cadence">{formatInterval(status.intervalSeconds)}</span>
                ) : null}
              </div>

              {status.supported ? null : (
                <div className="note amber">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    The saved workflow does not accept polling triggers. Turn on Accept polling
                    triggers in the Start node, then save.
                  </span>
                </div>
              )}

              {status.refreshError === null ? null : (
                <div className="note amber" role="alert">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    The last automatic refresh failed: {status.refreshError} The armed revision was
                    kept.
                  </span>
                </div>
              )}

              {status.state === "invalid" && status.issues.length > 0 ? (
                <section className="poll-section poll-block" aria-label="Saved workflow issues">
                  <h3>Saved workflow issues</h3>
                  <IssueList issues={status.issues} />
                </section>
              ) : null}

              <section className="poll-block" aria-label="Schedule">
                <h3>Schedule</h3>
                <div className="poll-schedule">
                  <div className="poll-interval">
                    <label htmlFor="poll-interval-amount">Check every</label>
                    <input
                      id="poll-interval-amount"
                      className="inspector-input mono"
                      data-testid="poll-interval-amount"
                      type="text"
                      inputMode="numeric"
                      value={amount}
                      onChange={(event) => {
                        intervalEdited.current = true;
                        setAmount(event.currentTarget.value);
                      }}
                      aria-invalid={intervalError ? true : undefined}
                    />
                    <select
                      data-testid="poll-interval-unit"
                      aria-label="Interval unit"
                      value={unit}
                      onChange={(event) => {
                        intervalEdited.current = true;
                        setUnit(event.currentTarget.value as "minutes" | "seconds");
                      }}
                    >
                      <option value="minutes">minutes</option>
                      <option value="seconds">seconds</option>
                    </select>
                  </div>
                  <div className="poll-actions">
                    {status.armed ? (
                      <button
                        type="button"
                        className="btn ghost danger"
                        onClick={() => setConfirmDisarm(true)}
                        disabled={disarm.isPending}
                      >
                        Disarm polling
                      </button>
                    ) : null}
                    {status.state === "stale" ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => refresh.mutate()}
                        disabled={refresh.isPending}
                      >
                        <RefreshCw size={13} aria-hidden="true" />
                        Refresh armed revision
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn primary"
                      onClick={armNow}
                      disabled={armDisabled}
                      aria-describedby={armHint === null ? undefined : armHintId}
                    >
                      {status.armed ? "Update interval" : "Arm polling"}
                    </button>
                  </div>
                </div>
                <p className="poll-hint">
                  Minimum {minInterval} seconds for {probeType} probes.
                </p>
                {armHint !== null ? (
                  <p
                    className="poll-hint"
                    id={armHintId}
                    data-tone={armHint === intervalError ? "error" : undefined}
                  >
                    {armHint}
                  </p>
                ) : null}
                {arm.isError ? <FailureNote failure={describePollFailure(arm.error)} /> : null}
                {disarm.isError ? (
                  <FailureNote failure={describePollFailure(disarm.error)} />
                ) : null}
                {refresh.isError ? (
                  <FailureNote failure={describePollFailure(refresh.error)} />
                ) : null}
              </section>

              <section className="poll-block" aria-label="Test probe">
                <div className="poll-block-head">
                  <div>
                    <h3>Test the probe</h3>
                    <p className="poll-block-note">Runs it once. Never starts a workflow run.</p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      probeNow.mutate(undefined, {
                        onSuccess: (result) => setProbeResult(result),
                      })
                    }
                    disabled={probeNow.isPending || !status.supported}
                  >
                    {probeNow.isPending ? "Probing…" : "Test probe now"}
                  </button>
                </div>
                {probeNow.isError ? (
                  <FailureNote failure={describePollFailure(probeNow.error)} />
                ) : null}
                {probeResult === null ? null : <ProbeResult result={probeResult} />}
              </section>

              <section className="poll-block" aria-label="Last activity">
                <h3>Last activity</h3>
                <dl className="poll-facts">
                  <div>
                    <dt>Last check</dt>
                    <dd>{formatTime(status.lastTickAt) ?? "No checks yet"}</dd>
                  </div>
                  <div>
                    <dt>Next check</dt>
                    <dd>{formatTime(status.nextDueAt) ?? "Not scheduled"}</dd>
                  </div>
                  <div>
                    <dt>Last outcome</dt>
                    <dd>
                      {status.lastOutcome === null ? (
                        <span className="faint">None yet</span>
                      ) : (
                        <span className={`pill ${OUTCOME_TONE[status.lastOutcome] ?? ""}`}>
                          {status.lastOutcome}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Last run</dt>
                    <dd>
                      {status.lastRunId === null ? (
                        <span className="faint">No runs yet</span>
                      ) : (
                        <Link to={`/p/${projectId}/r/${status.lastRunId}`} className="mono">
                          {status.lastRunId}
                        </Link>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Consecutive failures</dt>
                    <dd data-tone={status.consecutiveFailures > 0 ? "error" : undefined}>
                      {status.consecutiveFailures}
                    </dd>
                  </div>
                  {status.lastError === null ? null : (
                    <div>
                      <dt>Last error</dt>
                      <dd data-tone="error">{status.lastError}</dd>
                    </div>
                  )}
                </dl>
              </section>
            </>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmDisarm}
        title="Disarm the polling trigger?"
        message="The probe stops running. The saved workflow still declares polling, so it can be armed again."
        confirmLabel="Disarm polling"
        danger
        busy={disarm.isPending}
        onCancel={() => {
          if (disarm.isPending) return;
          setConfirmDisarm(false);
        }}
        onConfirm={() =>
          disarm.mutate(undefined, {
            onSettled: () => setConfirmDisarm(false),
          })
        }
      />
    </>
  );
}
