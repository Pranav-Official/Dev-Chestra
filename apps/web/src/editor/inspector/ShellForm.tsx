import type { Issue, ShellNode } from "@devchestra/schema";
import { TriangleAlert } from "lucide-react";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { CheckboxField, describedBy, Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import type { FormProps } from "./types.js";

function ShellTimeout({
  node,
  issues,
  onPatch,
}: {
  node: ShellNode;
  issues: readonly Issue[];
  onPatch: FormProps<ShellNode>["onPatch"];
}) {
  const timeout = useBufferedNumber(node.timeoutMin, {
    label: "Shell timeout",
    min: 1,
    max: 480,
    allowEmpty: true,
    onCommit: (value) => onPatch({ timeoutMin: value }),
    bufferKey: "shell.timeoutMin",
  });
  const issue = fieldIssue(issues, "/timeoutMin");
  const error = timeout.localError ?? issue;
  const id = "inspector-shell-timeout";
  return (
    <Field
      id={id}
      label="Timeout (minutes)"
      help="Engine default 10; allowed 1–480. Blank uses the default."
      error={error}
    >
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="numeric"
        value={timeout.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => timeout.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

export function ShellForm({ node, issues, onPatch }: FormProps<ShellNode>) {
  const commandIssue = fieldIssue(issues, "/command");
  const allowFailureIssue = fieldIssue(issues, "/allowFailure");
  return (
    <>
      <InspectorSection sectionKey="shell:command" title="Command">
        <div className="inspector-stack">
          <Field
            id="inspector-shell-command"
            label="Command"
            required
            help="Plain multi-line shell text. Nothing runs while you edit."
            error={commandIssue}
          >
            <ExpandableTextarea
              id="inspector-shell-command"
              label="Command"
              value={node.command}
              onCommit={(next) => onPatch({ command: next })}
              mode="template"
              nodeId={node.id}
              field="command"
              pickerTestId="inspector-shell-command-variables"
              textareaTestId="inspector-shell-command"
              rows={7}
              className="inspector-input inspector-textarea inspector-code-input"
              spellCheck={false}
              error={commandIssue}
              help="Plain multi-line shell text. Nothing runs while you edit."
              describedBy={describedBy("inspector-shell-command", undefined, commandIssue)}
            />
          </Field>
          <p className="inspector-footnote" data-testid="inspector-shell-effects-note" role="note">
            <TriangleAlert size={12} aria-hidden="true" /> Runs in the run's workspace with real
            side effects. Not a sandbox.
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="shell:execution" title="Options" defaultOpen={false}>
        <div className="inspector-stack">
          <ShellTimeout node={node} issues={issues} onPatch={onPatch} />
          <CheckboxField
            id="inspector-shell-allow-failure"
            label="Allow failure"
            checked={node.allowFailure ?? false}
            help="Continue the workflow when the command exits non-zero."
            error={allowFailureIssue}
            onChange={(allowFailure) => onPatch({ allowFailure })}
          />
        </div>
      </InspectorSection>
      <p className="inspector-footnote" data-testid="inspector-workspace-note">
        Workspace is chosen when starting the workflow.
      </p>
    </>
  );
}
