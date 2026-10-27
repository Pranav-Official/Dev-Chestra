import type { Issue } from "@relay/schema";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useBufferFlag } from "./BufferContext.js";
import { CheckboxField, describedBy, Field } from "./fields/fields.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";

// Local approval shape to stay compatible before schema publish.
interface ApprovalNodeLike {
  id: string;
  type: "approval";
  name: string;
  message: string;
  criteria?: string[];
  irreversible: boolean;
}

export function ApprovalForm({
  node,
  issues,
  onPatch,
}: {
  node: ApprovalNodeLike;
  issues: readonly Issue[];
  onPatch: (patch: Partial<ApprovalNodeLike>) => void;
}) {
  const messageIssue = fieldIssue(issues, "/message");
  const criteriaIssue = fieldIssue(issues, "/criteria");
  const irreversible = node.irreversible ?? false;
  const criteria = node.criteria ?? [];

  const message = useBufferedText(
    node.message ?? "",
    (next) => {
      if (next.trim() === "") return "Message is required.";
      if (next.length > 4096) return "Message must be 4096 characters or fewer.";
      return null;
    },
    (next) => onPatch({ message: next } as Partial<ApprovalNodeLike>),
    `approval.${node.id}.message`,
  );

  useBufferFlag("approval.criteria", criteriaIssue);

  return (
    <>
      <InspectorSection sectionKey="approval:request" title="Human review">
        <div className="inspector-stack">
          <Field
            id="inspector-approval-message"
            label="Message for the reviewer"
            required
            help="Human-readable request shown frozen at runtime. Supports {{ start.param }} and ancestor output templates."
            error={message.localError ?? messageIssue}
          >
            <textarea
              id="inspector-approval-message"
              className="inspector-input inspector-textarea"
              data-testid="inspector-approval-message"
              rows={4}
              value={message.text}
              maxLength={4096}
              aria-invalid={(message.localError ?? messageIssue) ? true : undefined}
              aria-describedby={describedBy(
                "inspector-approval-message",
                undefined,
                message.localError ?? messageIssue,
              )}
              onChange={(event) => message.onChange(event.currentTarget.value)}
              onBlur={() => {
                // useBufferedText commits on valid change already.
              }}
            />
          </Field>
          <CheckboxField
            id="inspector-approval-irreversible"
            label="Irreversible action"
            checked={irreversible}
            help="Marks the checkpoint as requiring explicit human judgment. No auto-approve."
            onChange={(next) => onPatch({ irreversible: next } as Partial<ApprovalNodeLike>)}
          />
          <p className="inspector-help">
            Approved handle is <span className="mono">{node.id}</span>; rejected handle is{" "}
            <span className="mono">{node.id}.rejected</span>. Without a rejected edge, rejection
            ends the run as rejected.
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="approval:criteria" title="Criteria (optional)">
        <div className="inspector-stack">
          <p className="inspector-help" data-testid="approval-criteria-help">
            Optional checklist for the reviewer. Each entry is a short string.
          </p>
          {criteria.length === 0 ? (
            <p className="faint" data-testid="approval-criteria-empty">
              No criteria. Add one if the reviewer should see a checklist.
            </p>
          ) : null}
          {criteria.map((item, index) => {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: criteria items may duplicate/empty, stable order by index
              <div key={`${index}:${item}`} className="inspector-inline" style={{ gap: 8 }}>
                <input
                  className="inspector-input"
                  data-testid={`inspector-approval-criteria-${index}`}
                  aria-label={`Criteria ${index + 1}`}
                  value={item}
                  placeholder="Review step"
                  maxLength={256}
                  onChange={(event) => {
                    const next = [...criteria];
                    next[index] = event.currentTarget.value;
                    onPatch({ criteria: next } as Partial<ApprovalNodeLike>);
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm danger"
                  data-testid={`inspector-approval-criteria-remove-${index}`}
                  aria-label={`Remove criteria ${index + 1}`}
                  onClick={() => {
                    const next = criteria.filter((_, i) => i !== index);
                    onPatch({
                      criteria: next.length === 0 ? undefined : next,
                    } as Partial<ApprovalNodeLike>);
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {criteriaIssue ? (
            <p className="inspector-error" role="alert">
              <ShieldCheck size={12} aria-hidden="true" />
              <span>{criteriaIssue}</span>
            </p>
          ) : null}
          <button
            type="button"
            className="btn sm"
            data-testid="inspector-approval-criteria-add"
            disabled={criteria.length >= 32}
            onClick={() => {
              if (criteria.length >= 32) return;
              const next = [...criteria, ""];
              onPatch({ criteria: next } as Partial<ApprovalNodeLike>);
            }}
          >
            <Plus size={13} aria-hidden="true" />
            Add criteria
          </button>
          {criteria.length >= 32 ? <p className="faint">Maximum 32 criteria items.</p> : null}
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="approval:handles" title="Routing">
        <p className="inspector-help">
          Connect <span className="mono">{node.id}</span> for approved,{" "}
          <span className="mono">{node.id}.rejected</span> for rejected. Rejected without an edge
          ends the run as rejected.
        </p>
      </InspectorSection>
    </>
  );
}
