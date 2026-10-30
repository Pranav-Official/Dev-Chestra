import type { EndNode } from "@devchestra/schema";
import { Info } from "lucide-react";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import type { FormProps } from "./types.js";

const STATUSES: readonly { value: EndNode["status"]; label: string }[] = [
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];

export function EndForm({
  node,
  issues,
  onPatch,
  bodyMode = false,
}: FormProps<EndNode> & { bodyMode?: boolean }) {
  const statusIssue = fieldIssue(issues, "/status");
  const resultIssue = fieldIssue(issues, "/result");
  return (
    <InspectorSection sectionKey="end:outcome" title="Outcome">
      <div className="inspector-stack">
        {bodyMode ? (
          <p className="inspector-help" data-testid="inspector-end-body-note">
            Body End must stay success; failure ends the run, not the round.
          </p>
        ) : (
          <Field id="inspector-end-status" label="Status" required error={statusIssue}>
            <select
              id="inspector-end-status"
              className="inspector-input"
              data-testid="inspector-end-status"
              value={node.status}
              aria-invalid={statusIssue ? true : undefined}
              aria-describedby={describedBy("inspector-end-status", undefined, statusIssue)}
              onChange={(event) =>
                onPatch({ status: event.currentTarget.value as EndNode["status"] })
              }
            >
              {STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          id="inspector-end-result"
          label="Result expression (JSONata)"
          required
          help="A JSONata expression over start parameters and ancestor outputs."
          error={resultIssue}
        >
          <ExpandableTextarea
            id="inspector-end-result"
            label="Result expression (JSONata)"
            value={node.result}
            onCommit={(next) => onPatch({ result: next })}
            mode="expression"
            nodeId={node.id}
            field="result"
            pickerTestId="inspector-end-result-variables"
            textareaTestId="inspector-end-result"
            rows={3}
            className="inspector-input inspector-textarea inspector-code-input"
            spellCheck={false}
            error={resultIssue}
            help="A JSONata expression over start parameters and ancestor outputs."
            describedBy={describedBy("inspector-end-result", undefined, resultIssue)}
          />
        </Field>
        <p className="inspector-note" data-testid="inspector-end-scope-hint" role="note">
          <Info size={13} aria-hidden="true" />
          <span>
            Scope: start parameters and this node's ancestor outputs only. Unrelated nodes are out
            of scope. The editor validates the expression but never evaluates it on the main thread.
          </span>
        </p>
      </div>
    </InspectorSection>
  );
}
