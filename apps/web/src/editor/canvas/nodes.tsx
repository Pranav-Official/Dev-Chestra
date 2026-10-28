import type { Issue, WorkflowNode } from "@relay/schema";
import { Handle, type Node, type NodeProps, Position, useUpdateNodeInternals } from "@xyflow/react";
import {
  AlertTriangle,
  Bot,
  Flag,
  GitBranch,
  GitMerge,
  Play,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef } from "react";

export interface EditorNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  issues: readonly Issue[];
  readOnly: boolean;
  unsupported: boolean;
}

export type EditorFlowNode = Node<EditorNodeData, "editor" | "unsupported">;

function Icon({ type }: { type: string }) {
  const t = type as string;
  if (t === "start") return <Play size={13} aria-hidden="true" />;
  if (t === "agent") return <Bot size={13} aria-hidden="true" />;
  if (t === "shell") return <TerminalSquare size={13} aria-hidden="true" />;
  if (t === "gate") return <GitBranch size={13} aria-hidden="true" />;
  if (t === "join") return <GitMerge size={13} aria-hidden="true" />;
  if (t === "approval") return <ShieldCheck size={13} aria-hidden="true" />;
  if (t === "end") return <Flag size={13} aria-hidden="true" />;
  return <AlertTriangle size={13} aria-hidden="true" />;
}

/** Handle geometry is cached by React Flow, so programmatic id/order changes need a remeasure. */
function handleSignature(node: WorkflowNode): string | null {
  const t = (node as { type: string }).type;
  if (t === "gate")
    return `gate:${(node as unknown as { branches: { id: string }[] }).branches.map((branch) => branch.id).join("|")}`;
  if (t === "join") return `join:${(node as unknown as { inputs: string[] }).inputs.join("|")}`;
  if (t === "approval") return `approval:${node.id}`;
  return null;
}

function subtitle(node: WorkflowNode): string {
  const t = (node as { type: string }).type;
  switch (t) {
    case "start":
      return `${(node as unknown as { params: unknown[] }).params.length} parameter${(node as unknown as { params: unknown[] }).params.length === 1 ? "" : "s"}`;
    case "agent":
      return `${(node as unknown as { cli: string }).cli}${
        (node as unknown as { model?: string }).model === undefined
          ? ""
          : ` · ${(node as unknown as { model?: string }).model}`
      }`;
    case "shell":
      return (node as unknown as { command: string }).command;
    case "gate":
      return `${(node as unknown as { branches: unknown[] }).branches.length} branch${(node as unknown as { branches: unknown[] }).branches.length === 1 ? "" : "es"}`;
    case "join":
      return `${(node as unknown as { mode: string }).mode} · ${(node as unknown as { inputs: unknown[] }).inputs.length} input${(node as unknown as { inputs: unknown[] }).inputs.length === 1 ? "" : "s"}`;
    case "approval": {
      const msg = (node as unknown as { message?: string }).message ?? "";
      const short = msg.trim().slice(0, 32);
      return (node as unknown as { irreversible?: boolean }).irreversible
        ? `Irreversible · ${short}`
        : short || "Waits for a person";
    }
    case "end":
      return `Ends as ${(node as unknown as { status: string }).status}`;
    default:
      return "";
  }
}

function HandleRow({
  side,
  id,
  label,
  title,
  testId,
  readOnly,
}: {
  side: "in" | "out";
  id: string;
  label: string;
  title: string;
  testId: string;
  readOnly: boolean;
}) {
  return (
    <div
      className={`ed-node-handle-row ed-node-handle-row-${side}`}
      style={{ position: "relative" }}
    >
      <span className="ed-node-handle-label" title={title}>
        {label}
      </span>
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={id}
        className={`ed-handle ed-handle-${side}`}
        style={{ top: "50%", [side === "in" ? "left" : "right"]: -5 }}
        isConnectable={!readOnly}
        data-testid={testId}
        aria-label={`${side === "in" ? "Input" : "Output"} ${label}`}
      />
    </div>
  );
}

export function EditorNodeView({ data, selected }: NodeProps<EditorFlowNode>) {
  const { node, issues, readOnly, unsupported } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const signature = unsupported ? null : handleSignature(node);
  const measured = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null || measured.current === signature) return;
    measured.current = signature;
    updateNodeInternals(node.id);
  }, [node.id, signature, updateNodeInternals]);
  const issueCount = issues.length;
  const summary = issueCount ? issues.map((issue) => issue.message).join("\n") : node.name;
  const t = (node as { type: string }).type;
  const gate =
    !unsupported && t === "gate"
      ? (node as unknown as { branches: { id: string; when?: string; otherwise?: true }[] })
      : null;
  const join = !unsupported && t === "join" ? (node as unknown as { inputs: string[] }) : null;
  const approval = !unsupported && t === "approval" ? (node as unknown as { id: string }) : null;
  return (
    <button
      type="button"
      className={`ed-node ed-node-${node.type}${selected ? " selected" : ""}${
        unsupported ? " ed-node-unsupported" : ""
      }`}
      data-testid={`ed-node-${node.id}`}
    >
      {!unsupported &&
      (node as { type: string }).type !== "start" &&
      (node as { type: string }).type !== "join" ? (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="ed-handle ed-handle-in"
          style={{ top: "50%", left: -5 }}
          isConnectable={!readOnly}
          data-testid={`ed-handle-${node.id}-in`}
          aria-label="Input"
        />
      ) : null}
      <div className="ed-node-head">
        <span className={`ed-node-icon ed-node-icon-${node.type}`}>
          <Icon type={node.type} />
        </span>
        <span className="ed-node-kind">{unsupported ? "unsupported" : node.type}</span>
        <span className="ed-node-spacer" />
        {issueCount > 0 ? (
          <span
            className="ed-node-issues"
            role="img"
            aria-label={`${issueCount} validation ${issueCount === 1 ? "issue" : "issues"}`}
            title={summary}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            <span>{issueCount}</span>
          </span>
        ) : null}
      </div>
      <div className="ed-node-name">{node.name}</div>
      <div className="ed-node-meta" title={summary}>
        {unsupported ? `Unsupported type '${node.type}'` : subtitle(node)}
      </div>
      {gate === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-gate-branches-${node.id}`}>
          {gate.branches.map((branch) => (
            <HandleRow
              key={branch.id}
              side="out"
              id={`out:${branch.id}`}
              label={branch.otherwise === true ? "otherwise" : branch.id}
              title={branch.otherwise === true ? "otherwise" : (branch.when ?? "")}
              testId={`ed-handle-${node.id}-out-${branch.id}`}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
      {join === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-join-inputs-${node.id}`}>
          {join.inputs.map((input) => (
            <HandleRow
              key={input}
              side="in"
              id={`in:${input}`}
              label={input}
              title={`Join input ${input}`}
              testId={`ed-handle-${node.id}-in-${input}`}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
      {approval === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-approval-handles-${node.id}`}>
          <HandleRow
            side="out"
            id="out"
            label="approved"
            title="Approved continues"
            testId={`ed-handle-${node.id}-out-approved`}
            readOnly={readOnly}
          />
          <HandleRow
            side="out"
            id="out:rejected"
            label="rejected"
            title="Rejected route (or run rejected if unconnected)"
            testId={`ed-handle-${node.id}-out-rejected`}
            readOnly={readOnly}
          />
        </div>
      )}
      {!unsupported &&
      (node as { type: string }).type !== "end" &&
      gate === null &&
      approval === null ? (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="ed-handle ed-handle-out"
          style={{ top: "50%", right: -5 }}
          isConnectable={!readOnly}
          data-testid={`ed-handle-${node.id}-out`}
          aria-label="Output"
        />
      ) : null}
    </button>
  );
}

export const EDITOR_NODE_TYPES = {
  editor: EditorNodeView,
  unsupported: EditorNodeView,
} as const;
