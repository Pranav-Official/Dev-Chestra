import {
  DECISION_UNCERTAIN_HANDLE,
  decisionHandles,
  type Issue,
  type NodeType,
  type WorkflowNode,
} from "@devchestra/schema";
import { Handle, type Node, type NodeProps, Position, useUpdateNodeInternals } from "@xyflow/react";
import {
  AlertTriangle,
  Bot,
  Flag,
  GitBranch,
  GitMerge,
  Play,
  Repeat,
  Scale,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef } from "react";

export interface EditorNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  issues: readonly Issue[];
  readOnly: boolean;
  unsupported: boolean;
  /**
   * True when a decision node's `uncertain` handle can occur but has no outgoing
   * edge. Reaching it unwired fails the run, so the canvas flags it.
   */
  unwiredUncertain?: boolean;
}

export type EditorFlowNode = Node<EditorNodeData, "editor" | "unsupported">;

function Icon({ type }: { type: NodeType }) {
  if (type === "start") return <Play size={13} aria-hidden="true" />;
  if (type === "agent") return <Bot size={13} aria-hidden="true" />;
  if (type === "shell") return <TerminalSquare size={13} aria-hidden="true" />;
  if (type === "gate") return <GitBranch size={13} aria-hidden="true" />;
  if (type === "join") return <GitMerge size={13} aria-hidden="true" />;
  if (type === "approval") return <ShieldCheck size={13} aria-hidden="true" />;
  if (type === "decision") return <Scale size={13} aria-hidden="true" />;
  if (type === "loop") return <Repeat size={13} aria-hidden="true" />;
  if (type === "end") return <Flag size={13} aria-hidden="true" />;
  return <AlertTriangle size={13} aria-hidden="true" />;
}

/** "1 branch" / "2 branches", "1 parameter" / "2 parameters". */
function plural(count: number, singular: string, many: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

/** Handle geometry is cached by React Flow, so programmatic id/order changes need a remeasure. */
export function handleSignature(node: WorkflowNode): string | null {
  switch (node.type) {
    case "gate":
      return `gate:${node.branches.map((branch) => branch.id).join("|")}`;
    case "join":
      return `join:${node.inputs.join("|")}`;
    case "approval":
      return `approval:${node.id}`;
    case "decision":
      return `decision:${decisionHandles(node).join("|")}`;
    case "start":
    case "agent":
    case "shell":
    case "loop":
    case "end":
      return null;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

export function subtitle(node: WorkflowNode): string {
  switch (node.type) {
    case "start":
      return plural(node.params.length, "parameter");
    case "agent":
      return node.model === undefined ? node.cli : `${node.cli} · ${node.model}`;
    case "shell":
      return node.command;
    case "gate":
      return plural(node.branches.length, "branch", "branches");
    case "join":
      return `${node.mode} · ${plural(node.inputs.length, "input")}`;
    case "approval": {
      const msg = node.message ?? "";
      const short = msg.trim().slice(0, 32);
      return node.irreversible ? `Irreversible · ${short}` : short || "Waits for a person";
    }
    case "decision": {
      const short = (node.instructions ?? "").trim().slice(0, 32);
      return short === "" ? `Asks ${node.provider}` : `${node.provider} · ${short}`;
    }
    case "loop":
      return `repeat ≤${node.maxIterations} · ${node.body.nodes.length} body nodes`;
    case "end":
      return `Ends as ${node.status}`;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
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
  const { node, issues, readOnly, unsupported, unwiredUncertain } = data;
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
  const gate = !unsupported && node.type === "gate" ? node : null;
  const join = !unsupported && node.type === "join" ? node : null;
  const approval = !unsupported && node.type === "approval" ? node : null;
  const decision = !unsupported && node.type === "decision" ? node : null;
  return (
    <button
      type="button"
      className={`ed-node ed-node-${node.type}${selected ? " selected" : ""}${
        unsupported ? " ed-node-unsupported" : ""
      }`}
      data-testid={`ed-node-${node.id}`}
    >
      {!unsupported && node.type !== "start" && node.type !== "join" ? (
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
        {decision !== null && unwiredUncertain === true ? (
          <span
            className="ed-node-issues ed-node-warn"
            role="img"
            aria-label="Uncertain route is not wired"
            title="The uncertain route can always occur (low confidence, refusal, or provider error with onError uncertain) but has no outgoing edge. Reaching it fails the run."
          >
            <AlertTriangle size={11} aria-hidden="true" />
            <span>?</span>
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
      {decision === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-decision-handles-${node.id}`}>
          {decisionHandles(decision).map((handle) => (
            <HandleRow
              key={handle}
              side="out"
              id={`out:${handle}`}
              label={handle}
              title={
                handle === DECISION_UNCERTAIN_HANDLE
                  ? "Fallback when the model is unsure, refuses, or the provider fails"
                  : `Decision route ${handle}`
              }
              testId={`ed-handle-${node.id}-out-${handle}`}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
      {!unsupported &&
      node.type !== "end" &&
      gate === null &&
      approval === null &&
      decision === null ? (
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
