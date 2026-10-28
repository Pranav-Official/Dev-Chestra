import type { Issue, WorkflowNode } from "@relay/schema";
import {
  Bot,
  Flag,
  GitBranch,
  Lock,
  type LucideIcon,
  Merge,
  Play,
  Scale,
  Terminal,
  UserCheck,
} from "lucide-react";
import { describedBy } from "./fields/fields.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { nodeNameIssue } from "./issues.js";
import type { PatchOf } from "./types.js";

const TYPE_ICON: Record<string, LucideIcon> = {
  start: Play,
  agent: Bot,
  shell: Terminal,
  gate: GitBranch,
  join: Merge,
  approval: UserCheck,
  decision: Scale,
  end: Flag,
};

const TYPE_LABEL: Record<string, string> = {
  start: "Start",
  agent: "Agent",
  shell: "Shell",
  gate: "Gate",
  join: "Join",
  approval: "Approval",
  decision: "Decision",
  end: "End",
};

/** Identity header: type badge, inline-editable name, and the read-only id. */
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
  const Icon = TYPE_ICON[node.type] ?? Play;

  return (
    <header className="inspector-head" data-type={node.type}>
      <span className="inspector-type-tile" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="inspector-head-main">
        <input
          id="inspector-node-name"
          className="inspector-title-input"
          data-testid="inspector-node-name"
          type="text"
          aria-label="Name"
          placeholder="Untitled node"
          value={name.text}
          maxLength={200}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy("inspector-node-name", undefined, error)}
          onChange={(event) => name.onChange(event.currentTarget.value)}
        />
        <div className="inspector-head-meta">
          <span className="inspector-type-label">{TYPE_LABEL[node.type]}</span>
          <span className="inspector-readonly-wrap" title="Stable ID, owned by the canvas">
            <Lock size={10} aria-hidden="true" />
            <input
              id="inspector-node-id"
              className="inspector-id-input"
              data-testid="inspector-node-id"
              type="text"
              aria-label="Node ID (read-only)"
              value={node.id}
              style={{ width: `${node.id.length + 1}ch` }}
              readOnly
              aria-readonly="true"
            />
          </span>
        </div>
        {error ? (
          <p className="inspector-error" id="inspector-node-name-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </header>
  );
}
