import type { Edge, Issue, WorkflowNode } from "@devchestra/schema";
import { AlertTriangle, Info, Pickaxe } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../styles/editor-inspector.css";
import { AgentForm } from "./AgentForm.js";
import { ApprovalForm } from "./ApprovalForm.js";
import { BufferContext } from "./BufferContext.js";
import { contentSignature } from "./contentSignature.js";
import { DecisionForm } from "./DecisionForm.js";
import { EndForm } from "./EndForm.js";
import { GateForm } from "./GateForm.js";
import { issuesForNode, summaryIssues } from "./issues.js";
import { JoinForm } from "./JoinForm.js";
import { LoopForm } from "./LoopForm.js";
import { NodeHeader } from "./NodeHeader.js";
import { InspectorSection } from "./Section.js";
import { ShellForm } from "./ShellForm.js";
import { StartForm } from "./StartForm.js";
import type { BufferValidity, InspectorProps, PatchOf } from "./types.js";

function NodeIssues({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <InspectorSection sectionKey="common:issues" title="Validation" badge={`${issues.length}`}>
      <ul className="inspector-issues" data-testid="inspector-issues">
        {issues.map((issue) => (
          <li
            className={`inspector-issue ${issue.severity}`}
            key={`${issue.code}:${issue.pointer ?? ""}:${issue.message}`}
          >
            {issue.severity === "error" ? (
              <AlertTriangle size={13} aria-hidden="true" />
            ) : (
              <Info size={13} aria-hidden="true" />
            )}
            <span>
              <b>{issue.code}</b> {issue.message}
              {issue.pointer === undefined ? null : (
                <span className="mono inspector-issue-pointer"> {issue.pointer}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

function renderBodyNode(
  bodyNode: WorkflowNode,
  bodyIssues: readonly Issue[],
  onBodyPatch: (patch: Partial<WorkflowNode>) => void,
  bodyEdges: readonly Edge[],
  onBodyRouting: (patch: Partial<WorkflowNode>, removeEdgeIds?: readonly string[]) => void,
  projectId?: string,
): ReactNode {
  // Each wrapper converts the form's narrow patch to the union patch with the
  // same unknown hop Inspector.emit uses (PatchOf permits explicit undefined for
  // field removal; Partial under exactOptionalPropertyTypes does not).
  switch (bodyNode.type) {
    case "start":
      return (
        <StartForm
          node={bodyNode}
          issues={bodyIssues}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
          bodyMode
        />
      );
    case "agent":
      return (
        <AgentForm
          node={bodyNode}
          issues={bodyIssues}
          projectId={projectId}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
        />
      );
    case "shell":
      return (
        <ShellForm
          node={bodyNode}
          issues={bodyIssues}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
        />
      );
    case "gate":
      return (
        <GateForm
          node={bodyNode}
          issues={bodyIssues}
          projectId={projectId}
          edges={bodyEdges}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
          onRoutingChange={(p, r) => onBodyRouting(p as unknown as Partial<WorkflowNode>, r)}
        />
      );
    case "join":
      return (
        <JoinForm
          node={bodyNode}
          issues={bodyIssues}
          edges={bodyEdges}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
          onRoutingChange={(p, r) => onBodyRouting(p as unknown as Partial<WorkflowNode>, r)}
        />
      );
    case "approval":
      return (
        <ApprovalForm
          node={bodyNode}
          issues={bodyIssues}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
        />
      );
    case "decision":
      return (
        <DecisionForm
          node={bodyNode}
          issues={bodyIssues}
          projectId={projectId}
          edges={bodyEdges}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
          onRoutingChange={(p, r) => onBodyRouting(p as unknown as Partial<WorkflowNode>, r)}
        />
      );
    case "end":
      return (
        <EndForm
          node={bodyNode}
          issues={bodyIssues}
          onPatch={(p) => onBodyPatch(p as unknown as Partial<WorkflowNode>)}
          bodyMode
        />
      );
    case "loop":
      return null;
    default: {
      const _exhaustive: never = bodyNode;
      return _exhaustive;
    }
  }
}

export function Inspector({
  node,
  projectId,
  issues,
  onPatch,
  edges,
  onRoutingChange,
  onBufferValidityChange,
  loopBodyOpenRequested,
  onLoopBodyOpenHandled,
}: InspectorProps) {
  const callbackRef = useRef(onBufferValidityChange);
  callbackRef.current = onBufferValidityChange;

  const signature = node === null ? null : contentSignature(node);
  const identity = node === null ? "none" : `${node.id}:${node.type}`;
  const emitted = useRef<string | null>(null);
  const sessionState = useRef({ identity, epoch: 0, seen: signature });
  if (sessionState.current.identity !== identity) {
    sessionState.current = { identity, epoch: sessionState.current.epoch + 1, seen: signature };
    emitted.current = null;
  } else if (signature !== sessionState.current.seen && signature !== emitted.current) {
    sessionState.current = {
      identity,
      epoch: sessionState.current.epoch + 1,
      seen: signature,
    };
    emitted.current = null;
  } else {
    sessionState.current.seen = signature;
  }
  const session = `${identity}#${sessionState.current.epoch}`;

  const [invalidFields, setInvalidFields] = useState<Record<string, string>>({});
  const setInvalid = useCallback(
    (fieldKey: string, reason: string | null) => {
      const composite = `${session}\u0000${fieldKey}`;
      setInvalidFields((previous) => {
        if (reason === null) {
          if (!(composite in previous)) return previous;
          const next = { ...previous };
          delete next[composite];
          return next;
        }
        if (previous[composite] === reason) return previous;
        return { ...previous, [composite]: reason };
      });
    },
    [session],
  );

  const registry = useMemo(() => ({ session, setInvalid }), [session, setInvalid]);
  const prefix = `${session}\u0000`;
  const reasons = Object.keys(invalidFields)
    .filter((key) => key.startsWith(prefix))
    .map((key) => invalidFields[key])
    .filter((reason): reason is string => reason !== undefined);
  const reason = reasons[0];
  const valid = reason === undefined;

  const lastValidity = useRef("");
  useEffect(() => {
    const state: BufferValidity = valid ? { valid: true } : { valid: false, reason };
    const key = `${session}|${state.valid}|${state.reason ?? ""}`;
    if (key === lastValidity.current) return;
    lastValidity.current = key;
    callbackRef.current?.(state);
  }, [session, valid, reason]);

  useEffect(() => {
    return () => {
      callbackRef.current?.({ valid: true });
    };
  }, []);

  const emit = <T extends WorkflowNode>(patch: PatchOf<T>): void => {
    if (node === null) return;
    const expected = contentSignature({ ...node, ...patch } as unknown as WorkflowNode);
    emitted.current = expected;
    onPatch(node.id, patch as unknown as Partial<WorkflowNode>);
  };

  const emitRouting = (
    patch: Partial<WorkflowNode>,
    removeEdgeIds: readonly string[] = [],
  ): void => {
    if (node === null) return;
    const expected = contentSignature({ ...node, ...patch } as unknown as WorkflowNode);
    emitted.current = expected;
    if (onRoutingChange !== undefined) {
      onRoutingChange(node.id, patch, removeEdgeIds);
    } else if (removeEdgeIds.length === 0) {
      onPatch(node.id, patch);
    }
  };

  const nodeIssues = node === null ? [] : issuesForNode(issues, node.id);
  const summary = node === null ? [] : summaryIssues(issues, node.id);

  return (
    <aside className="inspector" aria-label="Node inspector" data-testid="inspector">
      {node === null ? (
        <div className="inspector-empty" data-testid="inspector-empty">
          <Pickaxe size={20} aria-hidden="true" />
          <p>Select a node to edit its settings.</p>
        </div>
      ) : (
        <div className="inspector-body" key={session}>
          <BufferContext.Provider value={registry}>
            <NodeHeader node={node} issues={nodeIssues} onPatch={emit} />
            <div className="inspector-content">
              {node.type === "start" ? (
                <StartForm node={node} issues={nodeIssues} onPatch={emit} />
              ) : null}
              {node.type === "agent" ? (
                <AgentForm node={node} issues={nodeIssues} projectId={projectId} onPatch={emit} />
              ) : null}
              {node.type === "shell" ? (
                <ShellForm node={node} issues={nodeIssues} onPatch={emit} />
              ) : null}
              {node.type === "gate" ? (
                <GateForm
                  node={node}
                  issues={nodeIssues}
                  projectId={projectId}
                  edges={edges ?? []}
                  onPatch={emit}
                  onRoutingChange={emitRouting}
                />
              ) : null}
              {node.type === "join" ? (
                <JoinForm
                  node={node}
                  issues={nodeIssues}
                  edges={edges ?? []}
                  onPatch={emit}
                  onRoutingChange={emitRouting}
                />
              ) : null}
              {node.type === "approval" ? (
                <ApprovalForm node={node} issues={nodeIssues} onPatch={emit} />
              ) : null}
              {node.type === "decision" ? (
                <DecisionForm
                  node={node}
                  issues={nodeIssues}
                  projectId={projectId}
                  edges={edges ?? []}
                  onPatch={emit}
                  onRoutingChange={emitRouting}
                />
              ) : null}
              {node.type === "end" ? (
                <EndForm node={node} issues={nodeIssues} onPatch={emit} />
              ) : null}
              {node.type === "loop" ? (
                <LoopForm
                  openRequested={loopBodyOpenRequested}
                  onOpenHandled={onLoopBodyOpenHandled}
                  node={node}
                  issues={nodeIssues}
                  onPatch={emit}
                  renderBodyInspector={(
                    bodyNode,
                    _bodyIssues,
                    onBodyPatch,
                    bodyEdges,
                    onBodyRouting,
                  ) =>
                    renderBodyNode(bodyNode, [], onBodyPatch, bodyEdges, onBodyRouting, projectId)
                  }
                />
              ) : null}
              <NodeIssues issues={summary} />
            </div>
          </BufferContext.Provider>
        </div>
      )}
    </aside>
  );
}
