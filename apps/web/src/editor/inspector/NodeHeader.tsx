import type { Issue, WorkflowNode } from "@relay/schema";
import { Lock } from "lucide-react";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { nodeNameIssue } from "./issues.js";
import type { PatchOf } from "./types.js";

export function NodeHeader({
  node,
  issues,
  onPatch,
}: {
  node: WorkflowNode;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<WorkflowNode>) => void;
}) {
  const name = useBufferedText(
    node.name,
    (next) => {
      if (next.trim() === "") return "Name is required.";
      if (next.length > 200) return "Name must be 200 characters or fewer.";
      return null;
    },
    (next) => onPatch({ name: next }),
    `node.${node.id}.name`,
  );
  const error = name.localError ?? nodeNameIssue(issues);

  return (
    <div className="inspector-identity">
      <Field id="inspector-node-name" label="Name" required error={error}>
        <input
          id="inspector-node-name"
          className="inspector-input"
          data-testid="inspector-node-name"
          type="text"
          value={name.text}
          maxLength={200}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy("inspector-node-name", undefined, error)}
          onChange={(event) => name.onChange(event.currentTarget.value)}
        />
      </Field>
      <Field
        id="inspector-node-id"
        label="Node ID (read-only)"
        help="The canvas owns stable IDs; the inspector never rewrites them."
      >
        <div className="inspector-readonly-wrap">
          <Lock size={12} aria-hidden="true" />
          <input
            id="inspector-node-id"
            className="inspector-input inspector-readonly"
            data-testid="inspector-node-id"
            type="text"
            value={node.id}
            readOnly
            aria-readonly="true"
          />
        </div>
      </Field>
    </div>
  );
}
