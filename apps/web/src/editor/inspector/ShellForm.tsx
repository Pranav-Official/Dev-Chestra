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

function ProbeShellFields({
  node,
  issues,
  onPatch,
}: {
  node: ShellNode;
  issues: readonly Issue[];
  onPatch: FormProps<ShellNode>["onPatch"];
}) {
  const commandIssue = fieldIssue(issues, "/command");
  const timeout = useBufferedNumber(node.timeoutMin, {
    label: "Shell timeout",
    min: 1,
    max: 480,
    allowEmpty: true,
    onCommit: (value) => onPatch({ timeoutMin: value }),
    bufferKey: "shell.timeoutMin",
  });
  const timeoutIssue = fieldIssue(issues, "/timeoutMin");
  const timeoutError = timeout.localError ?? timeoutIssue;
  const timeoutId = "inspector-shell-timeout";
  const probeErrors = issues.filter(
    (issue) => issue.code === "E_POLL_PROBE" && issue.severity === "error",
  );
  const failure =
    probeErrors.length === 0 ? null : probeErrors.map((issue) => issue.message).join(" ");
  return (
    <>
      {failure === null ? null : (
        <p className="inspector-error" role="alert" data-testid="inspector-probe-error">
          {failure}
        </p>
      )}
      <InspectorSection sectionKey="shell:command" title="Command">
        <div className="inspector-stack">
          <Field
            id="inspector-shell-command"
            label="Command"
            required
            help="Runs unattended on every tick. Print the start parameters as JSON, or nothing. {{ }} variables are not available."
            error={commandIssue}
          >
            <ExpandableTextarea
              id="inspector-shell-command"
              label="Command"
              value={node.command}
              onCommit={(next) => onPatch({ command: next })}
              mode="none"
              nodeId={node.id}
              field="command"
              textareaTestId="inspector-shell-command"
              rows={7}
              className="inspector-input inspector-textarea inspector-code-input"
              spellCheck={false}
              error={commandIssue}
              help="Runs unattended on every tick. Print the start parameters as JSON, or nothing. {{ }} variables are not available."
              describedBy={describedBy("inspector-shell-command", undefined, commandIssue)}
            />
          </Field>
          <Field
            id={timeoutId}
            label="Timeout (minutes)"
            help="Engine default 10; allowed 1–480. Blank uses the default. Must be shorter than the arming interval."
            error={timeoutError}
          >
            <input
              id={timeoutId}
              className="inspector-input"
              data-testid={timeoutId}
              type="text"
              inputMode="numeric"
              value={timeout.text}
              aria-invalid={timeoutError ? true : undefined}
              aria-describedby={describedBy(timeoutId, undefined, timeoutError)}
              onChange={(event) => timeout.onChange(event.currentTarget.value)}
            />
          </Field>
        </div>
      </InspectorSection>
    </>
  );
}

export function ShellForm({
  node,
  issues,
  onPatch,
  probeMode = false,
}: FormProps<ShellNode> & { probeMode?: boolean }) {
  const commandIssue = fieldIssue(issues, "/command");
  if (probeMode) {
    return <ProbeShellFields node={node} issues={issues} onPatch={onPatch} />;
  }
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
            <TriangleAlert size={12} aria-hidden="true" /> Runs in the run&apos;s workspace with
            real side effects. Not a sandbox.
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
