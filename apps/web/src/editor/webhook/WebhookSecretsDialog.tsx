import type { WebhookSecrets } from "@devchestra/api";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "../controls/Dialog.js";
import { CopyField } from "./CopyField.js";

/**
 * Shows plaintext credentials once, straight after an arm that created them or
 * a rotate. Nothing keeps them afterwards: the caller clears its state on close.
 * Escape is guarded so a stray key press cannot discard the only copy.
 */
export function WebhookSecretsDialog({
  secrets,
  onClose,
}: {
  secrets: WebhookSecrets | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={secrets !== null}
      title="Save these webhook secrets"
      description="They are shown once and will not be shown again."
      onClose={onClose}
      cancelGuard={() => true}
      testId="webhook-secrets-dialog"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {secrets === null ? null : (
        <div className="webhook-secrets">
          <CopyField
            label="Bearer token"
            value={secrets.bearerToken}
            copyLabel="Copy bearer token"
            testId="webhook-secret-bearer"
          />
          <CopyField
            label="Signing secret"
            value={secrets.signingSecret}
            copyLabel="Copy signing secret"
            testId="webhook-secret-signing"
          />
          <p className="note amber">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Copy both now and store them where your sender can read them. To get new values later,
              rotate the trigger; that stops the current ones at once.
            </span>
          </p>
        </div>
      )}
    </Dialog>
  );
}
