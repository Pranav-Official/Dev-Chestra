import { AlertTriangle } from "lucide-react";
import { Dialog } from "../controls/Dialog.js";
import { CopyField } from "./CopyField.js";

/** The one secret a sender needs, with the Payload URL it posts to. Shown once. */
export interface WebhookReveal {
  readonly secret: string;
  readonly url: string | null;
}

/**
 * Shows the secret once, straight after an arm that created it or a rotate. The
 * values are laid out as GitHub's webhook form asks for them. Nothing keeps them
 * afterwards: the caller clears its state on close. Escape is guarded so a stray
 * key press cannot discard the only copy.
 */
export function WebhookSecretsDialog({
  reveal,
  onClose,
}: {
  reveal: WebhookReveal | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={reveal !== null}
      title="Save this webhook secret"
      description="Shown once. Enter these values in GitHub's webhook form."
      onClose={onClose}
      cancelGuard={() => true}
      testId="webhook-secrets-dialog"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {reveal === null ? null : (
        <div className="webhook-secrets">
          {reveal.url === null ? null : (
            <CopyField
              label="Payload URL"
              value={reveal.url}
              copyLabel="Copy Payload URL"
              testId="webhook-payload-url"
            />
          )}
          <p className="faint">
            Content type: <b>application/json</b>
          </p>
          <CopyField
            label="Secret"
            value={reveal.secret}
            copyLabel="Copy secret"
            testId="webhook-secret"
          />
          <p className="note amber">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Paste the secret into GitHub's Secret field. To get a new one later, rotate it; the
              current one stops working at once.
            </span>
          </p>
        </div>
      )}
    </Dialog>
  );
}
