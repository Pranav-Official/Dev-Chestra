import type { AgentNode, Issue } from "@relay/schema";
import { ShieldAlert } from "lucide-react";
import { CheckboxField } from "./fields/fields.js";
import { containingIssue, fieldIssue } from "./issues.js";
import type { PatchOf } from "./types.js";

function setWorkspaceWrite(node: AgentNode, enabled: boolean): PatchOf<AgentNode> {
  const others = node.permissions.write.filter((entry) => entry !== "workspace");
  const write: AgentNode["permissions"]["write"] = enabled ? ["workspace", ...others] : others;
  return { permissions: { ...node.permissions, write } };
}

export function AgentPermissions({
  node,
  issues,
  onPatch,
}: {
  node: AgentNode;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<AgentNode>) => void;
}) {
  const write = node.permissions.write;
  const hasWorkspace = write.includes("workspace");
  const hasProject = write.includes("project");
  const networkIssue = fieldIssue(issues, "/permissions/network");
  const writeIssue = fieldIssue(issues, "/permissions/write");
  const sectionIssue = containingIssue(issues, "/permissions");

  return (
    <div className="inspector-stack">
      <CheckboxField
        id="inspector-agent-network"
        label="Network access"
        checked={node.permissions.network}
        help="Lets the agent browse and call APIs. It does not grant host credentials."
        error={networkIssue}
        onChange={(network) => onPatch({ permissions: { ...node.permissions, network } })}
      />
      <CheckboxField
        id="inspector-agent-write-workspace"
        label="Write to workspace"
        checked={hasWorkspace}
        help="Applies to the directory chosen when the run starts: the project root, an existing Git worktree, or a new worktree. Advisory to the CLI."
        error={writeIssue}
        onChange={(enabled) => onPatch(setWorkspaceWrite(node, enabled))}
      />
      {hasProject ? (
        <>
          <CheckboxField
            id="inspector-agent-write-project"
            label="Legacy project write flag"
            checked
            disabled
            onChange={() => undefined}
            help="Kept for older workflows. Write to workspace now covers the selected run directory, including the project root."
          />
          <button
            type="button"
            className="btn sm"
            data-testid="inspector-agent-remove-project-write"
            onClick={() =>
              onPatch({
                permissions: {
                  ...node.permissions,
                  write: write.filter((entry) => entry !== "project"),
                },
              })
            }
          >
            Remove legacy project write
          </button>
        </>
      ) : null}
      <p className="inspector-footnote" role="note">
        <ShieldAlert size={12} aria-hidden="true" /> Advisory only. Relay is not an OS sandbox.
      </p>
      {sectionIssue ? (
        <p className="inspector-error" role="alert">
          {sectionIssue}
        </p>
      ) : null}
    </div>
  );
}
