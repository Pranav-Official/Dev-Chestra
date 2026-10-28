import type { AgentNode, Issue } from "@devchestra/schema";
import { FileText } from "lucide-react";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import type { PatchOf } from "./types.js";

export function AgentPrompt({
  node,
  issues,
  onPatch,
}: {
  node: AgentNode;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<AgentNode>) => void;
}) {
  const promptFile = node.promptFile;
  const hasPrompt = typeof node.prompt === "string";
  const fileOnly = !hasPrompt && promptFile !== undefined;
  const both = hasPrompt && promptFile !== undefined;
  const promptIssue = fieldIssue(issues, "/prompt");
  const fileIssue = fieldIssue(issues, "/promptFile");
  const promptError = promptIssue ?? (both ? "Both prompt and promptFile are set." : null);
  const id = "inspector-agent-prompt";

  if (fileOnly) {
    return (
      <div className="inspector-stack">
        <div
          className="inspector-note amber"
          data-testid="inspector-agent-prompt-file-note"
          role="note"
        >
          <FileText size={14} aria-hidden="true" />
          <div>
            <b>External prompt file</b>
            <p className="mono">{promptFile}</p>
            <p>
              The inspector does not read prompt files and cannot inline them. Edit the file on
              disk, or convert it in a host that supplies its contents. This form leaves
              <span className="mono"> promptFile </span> untouched rather than silently dropping it.
            </p>
            {fileIssue ? <p className="inspector-error">{fileIssue}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-stack">
      <Field
        id={id}
        label="Prompt"
        required
        help="Workflow parameters and connected earlier outputs are automatically included with every run. Optional {{ … }} templates remain for custom formatting."
        error={promptError}
      >
        <textarea
          id={id}
          className="inspector-input inspector-textarea"
          data-testid={id}
          rows={6}
          value={node.prompt ?? ""}
          aria-invalid={promptError ? true : undefined}
          aria-describedby={describedBy(id, undefined, promptError)}
          onChange={(event) => onPatch({ prompt: event.currentTarget.value })}
        />
      </Field>
      {both ? (
        <div className="inspector-note amber" role="note">
          <div>
            <p>Both prompt and promptFile are set, which the schema rejects.</p>
            <button
              type="button"
              className="btn sm"
              data-testid="inspector-agent-remove-prompt-file"
              onClick={() => onPatch({ promptFile: undefined })}
            >
              Remove promptFile (keep inline prompt)
            </button>
          </div>
        </div>
      ) : null}
      {fileIssue && !both ? <p className="inspector-error">{fileIssue}</p> : null}
    </div>
  );
}
