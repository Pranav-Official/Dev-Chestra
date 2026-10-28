import type { Edge, GateNode, Issue } from "@devchestra/schema";
import { ArrowDown, ArrowUp, GitBranch, Plus, Trash2 } from "lucide-react";
import {
  addGateBranch,
  HANDLE_ID_PATTERN,
  moveGateBranch,
  removeGateBranch,
  updateGateBranch,
} from "../model/routing.js";
import { useBufferFlag } from "./BufferContext.js";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedHandle } from "./fields/useBufferedHandle.js";
import { GateTester, type GateTestRunner } from "./GateTester.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import type { RoutingFormProps } from "./types.js";

function handleEdgeCount(edges: readonly Edge[], nodeId: string, branchId: string): number {
  const prefix = `${nodeId}.${branchId}`;
  return edges.filter((edge) => edge.from === prefix || edge.to === prefix).length;
}

function BranchRow({
  node,
  branch,
  index,
  issues,
  edges,
  canMoveUp,
  canMoveDown,
  onRoutingChange,
}: {
  node: GateNode;
  branch: GateNode["branches"][number];
  index: number;
  issues: readonly Issue[];
  edges: readonly Edge[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRoutingChange: RoutingFormProps<GateNode>["onRoutingChange"];
}) {
  const committed = useBufferedHandle(
    branch.id,
    (next) => {
      if (!HANDLE_ID_PATTERN.test(next)) {
        return "Branch id must start with a letter or digit and use only letters, digits, underscores or hyphens.";
      }
      if (next !== branch.id && node.branches.some((candidate) => candidate.id === next)) {
        return `Branch id '${next}' is already used.`;
      }
      if (next !== branch.id && handleEdgeCount(edges, node.id, branch.id) > 0) {
        return "This branch is connected. Disconnect its edge before renaming the handle.";
      }
      return null;
    },
    (next) => {
      if (next === branch.id) return;
      const updated = updateGateBranch(node, branch.id, { id: next });
      if (updated !== null) onRoutingChange({ branches: updated.branches });
    },
    `gate.${node.id}.branch.${branch.id}.id`,
  );
  const whenIssue = fieldIssue(issues, `/branches/${index}/when`);
  const idIssue = fieldIssue(issues, `/branches/${index}/id`);
  const id = `gate-branch-${index}`;
  return (
    <fieldset className="inspector-schema-row" data-testid={`gate-branch-${index}`}>
      <legend className="sr-only">Gate branch {index + 1}</legend>
      <div className="inspector-row-head">
        <span className="inspector-row-title">
          {branch.otherwise === true ? "Otherwise (always last)" : `Branch ${index + 1}`}
        </span>
        {branch.otherwise === true ? null : (
          <span className="inspector-inline">
            <button
              type="button"
              className="btn ghost sm"
              data-testid={`gate-branch-${index}-up`}
              aria-label={`Move branch ${index + 1} up`}
              disabled={!canMoveUp}
              onClick={() => {
                const updated = moveGateBranch(node, branch.id, "up");
                if (updated !== null) onRoutingChange({ branches: updated.branches });
              }}
            >
              <ArrowUp size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid={`gate-branch-${index}-down`}
              aria-label={`Move branch ${index + 1} down`}
              disabled={!canMoveDown}
              onClick={() => {
                const updated = moveGateBranch(node, branch.id, "down");
                if (updated !== null) onRoutingChange({ branches: updated.branches });
              }}
            >
              <ArrowDown size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn ghost sm danger"
              data-testid={`gate-branch-${index}-remove`}
              aria-label={`Remove branch ${index + 1}`}
              onClick={() => {
                const updated = removeGateBranch(node, branch.id);
                if (updated === null) return;
                const removed = edges
                  .filter((edge) => edge.from === `${node.id}.${branch.id}`)
                  .map((edge) => edge.id);
                onRoutingChange({ branches: updated.branches }, removed);
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {branch.otherwise === true ? (
        <p className="inspector-help">
          Fallback branch. It has no condition and is always evaluated last.
        </p>
      ) : (
        <>
          <Field
            id={`${id}-id`}
            label="Branch id (handle)"
            required
            help="Edge endpoints use gateId.branchId. Renaming is blocked while the handle has connections."
            error={committed.localError ?? idIssue}
          >
            <input
              id={`${id}-id`}
              className="inspector-input"
              data-testid={`gate-branch-${index}-id`}
              type="text"
              value={committed.text}
              aria-invalid={(committed.localError ?? idIssue) ? true : undefined}
              aria-describedby={describedBy(`${id}-id`, undefined, committed.localError ?? idIssue)}
              onChange={(event) => committed.onChange(event.currentTarget.value)}
              onBlur={committed.onBlur}
              onKeyDown={committed.onKeyDown}
            />
          </Field>
          <Field
            id={`${id}-when`}
            label="When (JSONata, boolean)"
            required
            help="First true branch wins. A non-boolean or evaluation error fails the gate and the run."
            error={whenIssue}
          >
            <textarea
              id={`${id}-when`}
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid={`gate-branch-${index}-when`}
              rows={2}
              spellCheck={false}
              value={branch.when ?? ""}
              aria-invalid={whenIssue ? true : undefined}
              aria-describedby={describedBy(`${id}-when`, undefined, whenIssue)}
              onChange={(event) => {
                const updated = updateGateBranch(node, branch.id, {
                  when: event.currentTarget.value,
                });
                if (updated !== null) onRoutingChange({ branches: updated.branches });
              }}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}

export function GateForm({
  node,
  issues,
  edges,
  onRoutingChange,
  projectId,
  runTest,
}: RoutingFormProps<GateNode> & {
  projectId?: string | undefined;
  runTest?: GateTestRunner | undefined;
}) {
  const branchesIssue = fieldIssue(issues, "/branches");
  const otherwiseIndex = node.branches.findIndex((branch) => branch.otherwise === true);
  const movableEnd = otherwiseIndex < 0 ? node.branches.length : otherwiseIndex;
  useBufferFlag("gate.branches", branchesIssue);
  return (
    <>
      <InspectorSection sectionKey="gate:branches" title="Branches">
        <div className="inspector-stack">
          <p className="inspector-help" data-testid="gate-branch-order-note">
            Branches evaluate top to bottom. Exactly one otherwise branch is fixed last.
          </p>
          {node.branches.map((branch, index) => (
            <BranchRow
              key={branch.id}
              node={node}
              branch={branch}
              index={index}
              issues={issues}
              edges={edges}
              canMoveUp={index > 0 && branch.otherwise !== true}
              canMoveDown={index < movableEnd - 1 && branch.otherwise !== true}
              onRoutingChange={onRoutingChange}
            />
          ))}
          {branchesIssue ? (
            <p className="inspector-error" role="alert">
              <GitBranch size={12} aria-hidden="true" />
              <span>{branchesIssue}</span>
            </p>
          ) : null}
          <div className="inspector-inline">
            <button
              type="button"
              className="btn sm"
              data-testid="gate-branch-add"
              onClick={() => {
                const updated = addGateBranch(node);
                onRoutingChange({ branches: updated.branches });
              }}
            >
              <Plus size={13} aria-hidden="true" />
              Add branch
            </button>
          </div>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="gate:tester" title="Gate tester">
        <GateTester node={node} projectId={projectId} runTest={runTest} />
      </InspectorSection>
    </>
  );
}
