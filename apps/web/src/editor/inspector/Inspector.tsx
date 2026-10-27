import type { Issue, WorkflowNode } from "@relay/schema";
import { AlertTriangle, Info, Pickaxe } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../styles/editor-inspector.css";
import { AgentForm } from "./AgentForm.js";
import { ApprovalForm } from "./ApprovalForm.js";
import { BufferContext } from "./BufferContext.js";
import { contentSignature } from "./contentSignature.js";
import { EndForm } from "./EndForm.js";
import { GateForm } from "./GateForm.js";
import { issuesForNode, summaryIssues } from "./issues.js";
import { JoinForm } from "./JoinForm.js";
import { NodeHeader } from "./NodeHeader.js";
import { InspectorSection } from "./Section.js";
import { ShellForm } from "./ShellForm.js";
import { StartForm } from "./StartForm.js";
import type { BufferValidity, InspectorProps, PatchOf } from "./types.js";

const TYPE_LABEL: Record<string, string> = {
  start: "Start",
  agent: "Agent",
  shell: "Shell",
  gate: "Gate",
  join: "Join",
  approval: "Approval",
  end: "End",
};

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

export function Inspector({
  node,
  projectId,
  issues,
  onPatch,
  edges,
  onRoutingChange,
  onBufferValidityChange,
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
        <>
          <header className="inspector-head">
            <div>
              <p className="inspector-eyebrow">{TYPE_LABEL[node.type]} node</p>
              <h2>{node.name.trim() === "" ? "Untitled node" : node.name}</h2>
            </div>
            <span className="pill">{TYPE_LABEL[node.type]}</span>
          </header>
          <div className="inspector-body" key={session}>
            <BufferContext.Provider value={registry}>
              <NodeHeader node={node} issues={nodeIssues} onPatch={emit} />
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
              {(node as { type: string }).type === "approval" ? (
                <ApprovalForm
                  node={node as unknown as never}
                  issues={nodeIssues}
                  onPatch={emit as unknown as never}
                />
              ) : null}
              {node.type === "end" ? (
                <EndForm node={node} issues={nodeIssues} onPatch={emit} />
              ) : null}
              <NodeIssues issues={summary} />
            </BufferContext.Provider>
          </div>
        </>
      )}
    </aside>
  );
}
