import type { WebhookIssue, WebhookTriggerState, WebhookTriggerStatus } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Webhook } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { classifyError } from "../../api/client.js";
import {
  describeWebhookFailure,
  invalidateWebhookTrigger,
  useArmWebhookTrigger,
  useDisarmWebhookTrigger,
  useRefreshWebhookTrigger,
  useRotateWebhookTrigger,
  useWebhookTrigger,
  type WebhookFailure,
} from "../../api/webhooks.js";
import "../../styles/editor-webhook.css";
import { ConfirmDialog } from "../controls/ConfirmDialog.js";
import { Dialog } from "../controls/Dialog.js";
import { CopyField } from "./CopyField.js";
import { type WebhookReveal, WebhookSecretsDialog } from "./WebhookSecretsDialog.js";

const DESCRIPTION =
  "Deliveries from an HTTP sender can start this workflow. Manual runs stay available whether or not the trigger is armed.";

const STATE_TEXT: Record<WebhookTriggerState, string> = {
  off: "Not armed. Deliveries to the URL are refused until the trigger is armed.",
  current: "Armed. Deliveries start a run of the armed revision, which matches the saved workflow.",
  stale:
    "Armed, but the saved workflow changed after arming. Deliveries keep running the armed revision until you refresh it.",
  invalid:
    "Armed, but the saved workflow is invalid or no longer accepts webhooks. The last valid armed revision keeps running.",
};

interface Chip {
  label: string;
  tone: string;
}

function chipFor(status: WebhookTriggerStatus | undefined, failed: boolean): Chip {
  if (status === undefined) {
    return failed ? { label: "Webhook unknown", tone: "" } : { label: "Webhook…", tone: "" };
  }
  switch (status.state) {
    case "current":
      return { label: "Webhook armed", tone: "green" };
    case "stale":
      return { label: "Webhook stale", tone: "amber" };
    case "invalid":
      return { label: "Webhook invalid", tone: "red" };
    case "off":
      return { label: "Webhook off", tone: "" };
  }
}

function formatTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toLocaleString();
}

function FailureNote({ failure }: { failure: WebhookFailure }) {
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

function IssueList({ issues }: { issues: readonly WebhookIssue[] }) {
  return (
    <ul className="webhook-issues">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.message}`}>
          <span className="mono">{issue.code}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The editor's webhook trigger: a header chip that shows the armed state, and a
 * dialog that arms, disarms, refreshes and rotates it. The server reads the
 * saved file, so arming is blocked while the editor holds unsaved edits.
 */
export function WebhookTriggerControl({
  projectId,
  workflowId,
  savedRevision,
  armBlockedReason,
}: {
  projectId: string;
  workflowId: string;
  /** Changes after each successful save. A root save can refresh the armed revision on the server. */
  savedRevision: number;
  /** Why arming is blocked right now (unsaved edits, invalid form, validation errors), or null. */
  armBlockedReason: string | null;
}) {
  const queryClient = useQueryClient();
  const trigger = useWebhookTrigger(projectId, workflowId);
  const arm = useArmWebhookTrigger(projectId, workflowId);
  const disarm = useDisarmWebhookTrigger(projectId, workflowId);
  const rotate = useRotateWebhookTrigger(projectId, workflowId);
  const refresh = useRefreshWebhookTrigger(projectId, workflowId);
  const [open, setOpen] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [reveal, setReveal] = useState<WebhookReveal | null>(null);
  const armHintId = useId();

  const lastRevision = useRef(savedRevision);
  useEffect(() => {
    if (lastRevision.current === savedRevision) return;
    lastRevision.current = savedRevision;
    void invalidateWebhookTrigger(queryClient, projectId, workflowId);
  }, [savedRevision, projectId, workflowId, queryClient]);

  const status = trigger.data;
  const chip = chipFor(status, trigger.isError);
  const armHint =
    status === undefined
      ? null
      : (armBlockedReason ??
        (status.supported
          ? null
          : "Turn on Accept webhook triggers in the Start node, then save."));
  const armDisabled = arm.isPending || armHint !== null || status === undefined;

  // The secret appears once. It leaves component state when the dialog closes, and
  // the mutation cache is reset so the plaintext is not kept there either. The URL
  // comes from the same response, because the cached status may not have it yet.
  const showReveal = (next: WebhookReveal): void => {
    setOpen(false);
    setReveal(next);
  };
  const closeReveal = (): void => {
    setReveal(null);
    arm.reset();
    rotate.reset();
  };

  const armNow = (): void => {
    arm.mutate(undefined, {
      onSuccess: (response) => {
        if (response.secret !== null) {
          showReveal({ secret: response.secret, url: response.status.url });
        }
      },
    });
  };
  const rotateNow = (): void => {
    rotate.mutate(undefined, {
      onSuccess: (response) => {
        if (response.secret !== null) {
          showReveal({ secret: response.secret, url: response.status.url });
        }
      },
      onSettled: () => setConfirmRotate(false),
    });
  };

  return (
    <>
      <button
        type="button"
        className={`pill ${chip.tone}`}
        data-testid="webhook-trigger-chip"
        data-state={status?.state ?? (trigger.isError ? "unknown" : "loading")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Re-read on open: the last-delivery time changes outside the editor.
          setOpen(true);
          void trigger.refetch();
        }}
      >
        <Webhook size={12} aria-hidden="true" />
        {chip.label}
      </button>

      <Dialog
        open={open}
        title="Webhook trigger"
        description={DESCRIPTION}
        onClose={() => setOpen(false)}
        testId="webhook-trigger-dialog"
      >
        <div className="webhook-panel">
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
              <p className="faint">Loading webhook status…</p>
            )
          ) : (
            <>
              <div className="webhook-summary">
                <span className={`pill ${chip.tone}`}>{chip.label}</span>
                <p>{STATE_TEXT[status.state]}</p>
                {status.hookId === null ? null : (
                  <p className="faint">The delivery URL stays the same when you arm again.</p>
                )}
              </div>

              {status.supported ? null : (
                <div className="note amber">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    The saved workflow does not accept webhook triggers. Turn on Accept webhook
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
                <section className="webhook-section" aria-label="Saved workflow issues">
                  <h3>Saved workflow issues</h3>
                  <IssueList issues={status.issues} />
                </section>
              ) : null}

              <div className="webhook-actions">
                {status.armed ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => disarm.mutate()}
                    disabled={disarm.isPending}
                  >
                    Disarm webhook
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={armNow}
                    disabled={armDisabled}
                    aria-describedby={armHint === null ? undefined : armHintId}
                  >
                    Arm webhook
                  </button>
                )}
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
              </div>
              {!status.armed && armHint !== null ? (
                <p className="webhook-hint" id={armHintId}>
                  {armHint}
                </p>
              ) : null}

              {arm.isError ? <FailureNote failure={describeWebhookFailure(arm.error)} /> : null}
              {disarm.isError ? (
                <FailureNote failure={describeWebhookFailure(disarm.error)} />
              ) : null}
              {refresh.isError ? (
                <FailureNote failure={describeWebhookFailure(refresh.error)} />
              ) : null}
              {rotate.isError ? (
                <FailureNote failure={describeWebhookFailure(rotate.error)} />
              ) : null}

              {status.url === null ? null : (
                <section className="webhook-section">
                  <CopyField
                    label="Delivery URL"
                    value={status.url}
                    copyLabel="Copy URL"
                    testId="webhook-url"
                  />
                  <p className="faint">
                    POST a JSON object signed with the secret: send the HMAC-SHA256 of the raw body
                    in X-Hub-Signature-256, the header GitHub uses.
                  </p>
                </section>
              )}

              <dl className="webhook-facts">
                {status.armed && status.armedAt !== null ? (
                  <div>
                    <dt>Armed</dt>
                    <dd>{formatTime(status.armedAt)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Last delivery</dt>
                  <dd>{formatTime(status.lastDeliveryAt) ?? "No deliveries yet"}</dd>
                </div>
              </dl>

              {status.hookId === null ? null : (
                <div className="webhook-rotate">
                  <div>
                    <b>Secret</b>
                    <p className="faint">
                      Rotating issues a new secret. The current one stops working at once.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirmRotate(true)}
                    disabled={rotate.isPending}
                  >
                    Rotate secret
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate the webhook secret?"
        message="The current secret stops working immediately. Update the Secret field in GitHub before its next delivery."
        confirmLabel="Rotate secret"
        danger
        busy={rotate.isPending}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={rotateNow}
      />

      <WebhookSecretsDialog reveal={reveal} onClose={closeReveal} />
    </>
  );
}
