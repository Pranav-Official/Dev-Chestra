import {
  DECISION_UNCERTAIN_HANDLE,
  decisionHandles,
  type Issue,
  LOOP_EXHAUSTED_HANDLE,
  type NodeType,
  type PollProbe,
  type StartPollingConfig,
  type WorkflowNode,
} from "@devchestra/schema";
import { Handle, type Node, type NodeProps, Position, useUpdateNodeInternals } from "@xyflow/react";
import {
  AlertTriangle,
  Bot,
  Files,
  Flag,
  GitBranch,
  GitMerge,
  ListOrdered,
  Play,
  Repeat,
  Scale,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import { useProviderState } from "../../ui/providerState.js";

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

export interface ProbeNodeData extends Record<string, unknown> {
  startId: string;
  probe: PollProbe;
  issues: readonly Issue[];
}

export type ProbeFlowNode = Node<ProbeNodeData, "probe">;

/** A node rendered on the canvas: a saved graph node or a derived probe node. */
export type EditorCanvasNode = EditorFlowNode | ProbeFlowNode;

/** Suffix for the derived probe node rendered above a polling start node. */
export const PROBE_NODE_SUFFIX = "::probe";

/** The start node a derived probe node was rendered for, or null. */
export function probeStartId(nodeId: string): string | null {
  return nodeId.endsWith(PROBE_NODE_SUFFIX) ? nodeId.slice(0, -PROBE_NODE_SUFFIX.length) : null;
}

/** The polling config when the node is a start node that declares polling. */
export function pollConfig(node: WorkflowNode): StartPollingConfig | null {
  return node.type === "start" && node.polling?.enabled === true ? node.polling : null;
}

function Icon({ type }: { type: NodeType }) {
  if (type === "start") return <Play size={13} aria-hidden="true" />;
  if (type === "agent") return <Bot size={13} aria-hidden="true" />;
  if (type === "shell") return <TerminalSquare size={13} aria-hidden="true" />;
  if (type === "gate") return <GitBranch size={13} aria-hidden="true" />;
  if (type === "join") return <GitMerge size={13} aria-hidden="true" />;
  if (type === "approval") return <ShieldCheck size={13} aria-hidden="true" />;
  if (type === "decision") return <Scale size={13} aria-hidden="true" />;
  if (type === "loop") return <Repeat size={13} aria-hidden="true" />;
  if (type === "foreach") return <ListOrdered size={13} aria-hidden="true" />;
  if (type === "workflow") return <Files size={13} aria-hidden="true" />;
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
    case "loop":
      return `loop:${node.id}`;
    case "workflow":
      return `workflow:${node.id}`;
    case "foreach":
      return null;
    case "start":
    case "agent":
    case "shell":
    case "end":
      return null;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

/** Short model name for a node's meta line: no provider prefix, capped at 22 characters. */
export function shortModel(model: string | undefined): string {
  if (model === undefined || model === "") return "default";
  const name = model.replace(/^[^/]+\//, "");
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
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
    case "foreach":
      return `sequential · ${node.source.kind === "csv" ? "CSV" : "array"} · ${node.body.nodes.length} body nodes`;
    case "workflow":
      return node.workflowId || "Choose a workflow";
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
  const start = !unsupported && node.type === "start" ? node : null;
  const pollingProbe =
    start !== null && start.polling?.enabled === true ? start.polling.probe : null;
  const gate = !unsupported && node.type === "gate" ? node : null;
  const join = !unsupported && node.type === "join" ? node : null;
  const approval = !unsupported && node.type === "approval" ? node : null;
  const decision = !unsupported && node.type === "decision" ? node : null;
  const loop = !unsupported && node.type === "loop" ? node : null;
  const workflow = !unsupported && node.type === "workflow" ? node : null;
  const agent = !unsupported && node.type === "agent" ? node : null;
  const providers = useProviderState();
  const providerOff = agent !== null && providers.isDisabled(agent.cli);
  const agentTitle =
    agent === null ? "" : `${subtitle(agent)}${providerOff ? " · turned off in Settings" : ""}`;
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
      {pollingProbe === null ? null : (
        <Handle
          type="target"
          position={Position.Top}
          id="poll"
          className="ed-handle ed-handle-poll"
          style={{ top: -5 }}
          isConnectable={false}
          data-testid={`ed-handle-${node.id}-poll`}
          aria-label="Polling probe input"
        />
      )}
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
        {agent === null ? (
          unsupported ? (
            `Unsupported type '${node.type}'`
          ) : (
            subtitle(node)
          )
        ) : (
          <span
            className={providerOff ? "ed-node-provider is-off" : "ed-node-provider"}
            title={agentTitle}
          >
            <ProviderIcon cli={agent.cli} size={12} />
            {providerOff ? <span className="ed-node-provider-dot" aria-hidden="true" /> : null}
            <span aria-hidden="true">{shortModel(agent.model)}</span>
            <span className="sr-only">{agentTitle}</span>
          </span>
        )}
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
      {loop === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-loop-handles-${node.id}`}>
          <HandleRow
            side="out"
            id="out"
            label="success"
            title="Condition met within maxIterations"
            testId={`ed-handle-${node.id}-out-success`}
            readOnly={readOnly}
          />
          <HandleRow
            side="out"
            id={`out:${LOOP_EXHAUSTED_HANDLE}`}
            label="exhausted"
            title="Iteration budget exhausted. Unconnected, exhaustion fails the run (E_LOOP_LIMIT)."
            testId={`ed-handle-${node.id}-out-exhausted`}
            readOnly={readOnly}
          />
        </div>
      )}
      {workflow === null ? null : (
        <div className="ed-node-handle-list" data-testid={`ed-workflow-handles-${node.id}`}>
          <HandleRow
            side="out"
            id="out"
            label="success"
            title="Child workflow succeeded"
            testId={`ed-handle-${node.id}-out-success`}
            readOnly={readOnly}
          />
          <HandleRow
            side="out"
            id="out:failed"
            label="failed"
            title="Child workflow failed or was rejected"
            testId={`ed-handle-${node.id}-out-failed`}
            readOnly={readOnly}
          />
        </div>
      )}
      {!unsupported &&
      node.type !== "end" &&
      gate === null &&
      approval === null &&
      decision === null &&
      loop === null &&
      workflow === null ? (
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
  probe: ProbeNodeView,
} as const;

/**
 * The derived polling-probe node rendered above a start node that declares
 * polling. It is derived from the saved model on every render: never written
 * into the graph, the undo history, validation input, edge routing, or
 * autosave payloads.
 */
export function ProbeNodeView({ data, selected }: NodeProps<ProbeFlowNode>) {
  const { probe, startId, issues } = data;
  const agent = probe.type === "agent";
  const rawDetail = agent ? (probe.prompt ?? "") : (probe.command ?? "");
  const firstLine = rawDetail.split("\n", 1)[0] ?? "";
  const short = firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
  // A hand-written file may omit the probe's name (the schema defaults it), so read it defensively.
  const savedName = typeof probe.name === "string" ? probe.name.trim() : "";
  const displayName = savedName === "" ? (agent ? "Agent probe" : "Shell probe") : probe.name;
  const summary = agent
    ? `Agent probe for ${startId}${probe.model === undefined ? "" : ` · ${probe.model}`}`
    : `Shell probe for ${startId}`;
  const issueCount = issues.length;
  const issueSummary = issueCount > 0 ? issues.map((issue) => issue.message).join("\n") : summary;
  return (
    <button
      type="button"
      className={`ed-node ed-node-probe${selected ? " selected" : ""}`}
      data-testid={`ed-node-${startId}::probe`}
      title={issueCount > 0 ? issueSummary : summary}
      aria-label={summary}
    >
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="ed-handle ed-handle-out"
        style={{ bottom: -5 }}
        isConnectable={false}
        data-testid={`ed-handle-${startId}::probe-out`}
        aria-label="Probe output"
      />
      <div className="ed-node-head">
        <span className="ed-node-icon" aria-hidden="true">
          {agent ? <Bot size={13} /> : <TerminalSquare size={13} />}
        </span>
        <span className="ed-node-kind">probe · {agent ? "agent" : "shell"}</span>
        <span className="ed-node-spacer" />
        {issueCount > 0 ? (
          <span
            className="ed-node-issues"
            role="img"
            aria-label={`${issueCount} validation ${issueCount === 1 ? "issue" : "issues"}`}
            title={issueSummary}
            data-testid={`ed-node-${startId}::probe-issues`}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            <span>{issueCount}</span>
          </span>
        ) : null}
      </div>
      <div className="ed-node-name">{displayName}</div>
      <div className="ed-node-meta" title={rawDetail === "" ? summary : rawDetail}>
        {short === "" ? (agent ? "No prompt yet" : "No command yet") : short}
      </div>
    </button>
  );
}
