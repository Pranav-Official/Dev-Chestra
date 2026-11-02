import type { ExecutionSettingsResponse } from "@devchestra/api";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { classifyError } from "../../api/client.js";
import {
  useExecutionSettings,
  useSaveExecutionSettings,
  useSaveWebhookSettings,
  useWebhookSettings,
} from "../../api/webhooks.js";
import { InlineError, LoadingState } from "../../ui/states.js";
import "../../styles/settings-execution.css";

interface IntLimit {
  min: number;
  max: number;
  default: number;
}

/** Blank, partial, and out-of-range values are caught here; the server still checks what it receives. */
function limitError(text: string, limit: IntLimit): string | null {
  const value = Number(text);
  if (!/^\d+$/u.test(text.trim()) || value < limit.min || value > limit.max) {
    return `Enter a whole number from ${limit.min} to ${limit.max}.`;
  }
  return null;
}

function publicUrlError(text: string): string | null {
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Enter a full address that starts with http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an http:// or https:// address.";
  }
  if (url.username !== "" || url.password !== "") {
    return "Remove the username and password from the address.";
  }
  if (url.search !== "" || url.hash !== "") {
    return "Remove the query string and fragment. A path prefix is fine.";
  }
  return null;
}

function describedBy(id: string, error: string | null): string {
  return error === null ? `${id}-hint` : `${id}-hint ${id}-error`;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | null;
  children: ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="exec-field">
      <label className="exec-label" htmlFor={id}>
        {label}
      </label>
      {children}
      <p className="exec-hint" id={hintId}>
        {hint}
      </p>
      {error === null ? null : (
        <p className="exec-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ExecutionPanel() {
  const execution = useExecutionSettings();
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <h2>Execution</h2>
        <p className="faint">
          Limits for runs. Manual and webhook runs share one queue: runs past the concurrency limit
          wait in the queue until a slot frees.
        </p>
      </div>
      {execution.isPending ? <LoadingState label="Loading execution settings…" /> : null}
      {execution.isError ? (
        <InlineError
          message={`Couldn't load execution settings. ${classifyError(execution.error).message}`}
        />
      ) : null}
      {execution.data === undefined ? null : <LimitsForm response={execution.data} />}
      <WebhookUrlSection />
    </div>
  );
}

function LimitsForm({ response }: { response: ExecutionSettingsResponse }) {
  const save = useSaveExecutionSettings();
  const { settings, limits } = response;
  const concurrentId = useId();
  const queueId = useId();
  const [concurrent, setConcurrent] = useState(String(settings.maxConcurrentRuns));
  const [queue, setQueue] = useState(String(settings.maxQueueDepth));
  const concurrentError = limitError(concurrent, limits.maxConcurrentRuns);
  const queueError = limitError(queue, limits.maxQueueDepth);
  const changed =
    Number(concurrent) !== settings.maxConcurrentRuns || Number(queue) !== settings.maxQueueDepth;
  const canSave = changed && concurrentError === null && queueError === null && !save.isPending;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSave) return;
    save.mutate({ maxConcurrentRuns: Number(concurrent), maxQueueDepth: Number(queue) });
  };

  return (
    <section className="card exec-card" aria-labelledby={`${concurrentId}-heading`}>
      <div className="card-head">
        <h3 id={`${concurrentId}-heading`}>Concurrency and queue</h3>
      </div>
      <form className="card-body exec-form" onSubmit={submit} noValidate>
        <div className="exec-grid">
          <FieldFrame
            id={concurrentId}
            label="Maximum concurrent runs"
            hint={`Runs that may execute at once. Default ${limits.maxConcurrentRuns.default}; allowed ${limits.maxConcurrentRuns.min} to ${limits.maxConcurrentRuns.max}.`}
            error={concurrentError}
          >
            <input
              id={concurrentId}
              className="input"
              type="number"
              inputMode="numeric"
              step={1}
              min={limits.maxConcurrentRuns.min}
              max={limits.maxConcurrentRuns.max}
              value={concurrent}
              aria-invalid={concurrentError === null ? undefined : true}
              aria-describedby={describedBy(concurrentId, concurrentError)}
              onChange={(event) => setConcurrent(event.currentTarget.value)}
            />
          </FieldFrame>
          <FieldFrame
            id={queueId}
            label="Maximum queued runs"
            hint={`Runs waiting for a slot. When the queue is full, new webhook deliveries are refused and can be retried. Default ${limits.maxQueueDepth.default}; allowed ${limits.maxQueueDepth.min} to ${limits.maxQueueDepth.max}.`}
            error={queueError}
          >
            <input
              id={queueId}
              className="input"
              type="number"
              inputMode="numeric"
              step={1}
              min={limits.maxQueueDepth.min}
              max={limits.maxQueueDepth.max}
              value={queue}
              aria-invalid={queueError === null ? undefined : true}
              aria-describedby={describedBy(queueId, queueError)}
              onChange={(event) => setQueue(event.currentTarget.value)}
            />
          </FieldFrame>
        </div>
        {save.isError ? (
          <p className="exec-error" role="alert">
            {classifyError(save.error).message}
          </p>
        ) : null}
        <div className="exec-actions">
          {save.isSuccess && !changed ? (
            <span className="faint" role="status">
              Saved.
            </span>
          ) : null}
          <button type="submit" className="btn" disabled={!canSave}>
            Save limits
          </button>
        </div>
      </form>
    </section>
  );
}

function WebhookUrlSection() {
  const settings = useWebhookSettings();
  const headingId = useId();
  return (
    <section className="card exec-card" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Webhook URLs</h3>
      </div>
      <div className="card-body">
        {settings.isPending ? (
          <p className="faint" role="status">
            Loading webhook settings…
          </p>
        ) : null}
        {settings.isError ? (
          <InlineError
            message={`Couldn't load webhook settings. ${classifyError(settings.error).message}`}
          />
        ) : null}
        {settings.data === undefined ? null : (
          <PublicUrlForm initial={settings.data.publicBaseUrl} />
        )}
      </div>
    </section>
  );
}

function PublicUrlForm({ initial }: { initial: string | null }) {
  const save = useSaveWebhookSettings();
  const inputId = useId();
  const [value, setValue] = useState(initial ?? "");
  const trimmed = value.trim();
  const error = publicUrlError(trimmed);
  const changed = trimmed !== (initial ?? "");
  const canSave = changed && error === null && !save.isPending;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSave) return;
    save.mutate({ publicBaseUrl: trimmed === "" ? null : trimmed });
  };

  return (
    <form className="exec-form" onSubmit={submit} noValidate>
      <FieldFrame
        id={inputId}
        label="Public base URL"
        hint="Optional. Only changes the copyable webhook URL that DevChestra shows; it does not change where DevChestra listens. Leave it empty to copy the address you opened DevChestra at."
        error={error}
      >
        <input
          id={inputId}
          className="input mono"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="https://hooks.example.com"
          value={value}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={describedBy(inputId, error)}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </FieldFrame>
      {save.isError ? (
        <p className="exec-error" role="alert">
          {classifyError(save.error).message}
        </p>
      ) : null}
      <div className="exec-actions">
        {save.isSuccess && !changed ? (
          <span className="faint" role="status">
            Saved.
          </span>
        ) : null}
        <button type="submit" className="btn" disabled={!canSave}>
          Save base URL
        </button>
      </div>
    </form>
  );
}
