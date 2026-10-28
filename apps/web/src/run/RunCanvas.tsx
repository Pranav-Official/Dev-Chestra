import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { deriveRouting, type RunView } from "@relay/core";
import {
  Bot,
  CheckCircle2,
  Circle,
  CircleSlash,
  Flag,
  GitBranch,
  GitMerge,
  LoaderCircle,
  OctagonX,
  PauseCircle,
  Play,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { resolveApproval } from "../api/approvals.js";
import { StatusPill, statusLabel } from "../ui/StatusPill.js";
import { approvalForPath, isActionable } from "./approval.js";

interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  cli?: string;
  model?: string;
  command?: string;
  status?: string;
  branches?: { id: string; when?: string; otherwise?: true }[];
  mode?: "first" | "all";
  inputs?: string[];
}

export interface WorkflowSnapshot {
  name?: string;
  graph: {
    nodes: SnapshotNode[];
    edges: { id: string; from: string; to: string }[];
  };
}

interface NodeData extends Record<string, unknown> {
  name: string;
  kind: string;
  subtitle: string;
  status: string;
  selected: boolean;
  testId: string;
  gateBranch: string | null;
  gateEvaluated: { branch: string; matched: boolean; error?: string }[];
  joinActive: string[];
  joinSkipped: string[];
  runId: string;
  approvalCanAct: boolean;
  approvalRequestId: string | null;
  approvalAttempt: number | null;
  approvalGeneration: number | null;
}

const NODE_W = 184;
const NODE_H = 76;

function nodeColor(kind: string): string {
  if (kind === "agent") return "var(--accent)";
  return "var(--text-2)";
}

function NodeStatusIcon({ status }: { status: string }) {
  if (status === "succeeded") return <CheckCircle2 size={10} aria-hidden="true" />;
  if (status === "failed" || status === "rejected")
    return <OctagonX size={10} aria-hidden="true" />;
  if (status === "running" || status === "validating")
    return <LoaderCircle size={10} className="spin" aria-hidden="true" />;
  if (status === "waiting_quota" || status === "waiting_approval")
    return <PauseCircle size={10} aria-hidden="true" />;
  if (status === "skipped") return <CircleSlash size={10} aria-hidden="true" />;
  return <Circle size={10} aria-hidden="true" />;
}

function NodeIcon({ kind }: { kind: string }) {
  if (kind === "start") return <Play size={12} aria-hidden="true" />;
  if (kind === "agent") return <Bot size={12} aria-hidden="true" />;
  if (kind === "shell") return <TerminalSquare size={12} aria-hidden="true" />;
  if (kind === "gate") return <GitBranch size={12} aria-hidden="true" />;
  if (kind === "join") return <GitMerge size={12} aria-hidden="true" />;
  if (kind === "approval") return <ShieldCheck size={12} aria-hidden="true" />;
  return <Flag size={12} aria-hidden="true" />;
}

function ApprovalNodeActions({ data }: { data: NodeData }) {
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  if (!data.approvalCanAct || data.approvalRequestId === null) return null;
  const act = async (decision: "approve" | "reject", e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy !== null) return;
    if (
      data.approvalRequestId === null ||
      data.approvalAttempt === null ||
      data.approvalGeneration === null
    ) {
      setError("Missing request identity — open the node to resolve.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await resolveApproval(data.runId, String(data.id), {
        requestId: data.approvalRequestId,
        expectedAttempt: data.approvalAttempt,
        expectedGeneration: data.approvalGeneration,
        decision,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve failed.");
      setBusy(null);
      return;
    }
    setBusy(null);
  };
  const nodeId = String(data.id);
  return (
    <div
      className="flow-node-actions row"
      style={{ gap: 6 }}
      data-testid={`node-approval-${nodeId}`}
    >
      <button
        type="button"
        className="btn sm primary"
        data-testid={`approval-approve-node-${nodeId}`}
        disabled={busy !== null}
        aria-busy={busy === "approve"}
        aria-label={`Approve ${nodeId}`}
        onClick={(e) => void act("approve", e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {busy === "approve" ? "…" : "Approve"}
      </button>
      <button
        type="button"
        className="btn sm danger"
        data-testid={`approval-reject-node-${nodeId}`}
        disabled={busy !== null}
        aria-busy={busy === "reject"}
        aria-label={`Reject ${nodeId}`}
        onClick={(e) => void act("reject", e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      {error ? (
        <span className="faint" role="alert" style={{ fontSize: 10.5 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function WorkflowNode({ data }: NodeProps<Node<NodeData>>) {
  return (
    <div
      className={`flow-node st-${data.status}${data.selected ? " selected" : ""}`}
      data-testid={data.testId}
      data-path={String(data.id)}
      data-node-status={data.status}
      title={`${data.name} — ${statusLabel(data.status)}`}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flow-node-head" style={{ color: nodeColor(data.kind) }}>
        <NodeIcon kind={data.kind} />
        <span>{data.kind}</span>
        <span className="sp" />
        <span className="sr-only" data-testid={`run-node-status-${String(data.id)}`}>
          {statusLabel(data.status)}
        </span>
      </div>
      <div className="flow-node-body">{data.name}</div>
      <div className="flow-node-meta row" style={{ gap: 4 }}>
        <NodeStatusIcon status={data.status} />
        <span>
          {statusLabel(data.status)}
          {data.subtitle ? ` · ${data.subtitle}` : ""}
        </span>
      </div>
      {data.kind === "gate" ? (
        <div className="flow-node-route" data-testid={`run-gate-branch-${String(data.id)}`}>
          {data.gateBranch === null
            ? data.status === "succeeded"
              ? "gate failed"
              : data.status === "skipped"
                ? "not run"
                : "pending"
            : `branch ${data.gateBranch}`}
          {data.gateEvaluated.length === 0
            ? ""
            : ` · ${data.gateEvaluated
                .map((entry) => `${entry.branch}:${entry.matched ? "true" : "false"}`)
                .join(" ")}`}
        </div>
      ) : null}
      {data.kind === "join" ? (
        <div className="flow-node-route">
          {data.status === "skipped" ? (
            "not run"
          ) : (
            <>
              <span data-testid={`run-join-active-${String(data.id)}`}>
                active {data.joinActive.length === 0 ? "none" : data.joinActive.join(", ")}
              </span>
              <span data-testid={`run-join-skipped-${String(data.id)}`}>
                skipped {data.joinSkipped.length === 0 ? "none" : data.joinSkipped.join(", ")}
              </span>
            </>
          )}
        </div>
      ) : null}
      {data.kind === "approval" && data.approvalCanAct ? <ApprovalNodeActions data={data} /> : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNode };

function executionFor(view: RunView, nodeId: string): RunView["executions"][string] | undefined {
  const direct = view.executions[nodeId];
  if (direct !== undefined) return direct;
  for (const [path, exec] of Object.entries(view.executions)) {
    if (path === nodeId || path.endsWith(`/${nodeId}`) || path.startsWith(`${nodeId}[`))
      return exec;
  }
  return undefined;
}

function nodeStatus(view: RunView, nodeId: string): string {
  return executionFor(view, nodeId)?.status ?? "pending";
}

function edgeClass(state: string, targetStatus: string): string {
  if (state === "dead") return targetStatus === "skipped" ? "dead skip" : "dead";
  if (state === "active" && (targetStatus === "running" || targetStatus === "validating"))
    return "live";
  if (state === "active") return "done";
  return "";
}

function autoLayout(snapshot: WorkflowSnapshot): Map<string, { x: number; y: number }> {
  const nodes = snapshot.graph.nodes;
  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  for (const edge of snapshot.graph.edges) {
    const target = edge.to.split(".")[0] ?? edge.to;
    if (incoming.has(target)) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  if (queue.length === 0 && nodes[0] !== undefined) queue.push(nodes[0].id);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const current = depth.get(id) ?? 0;
    for (const edge of snapshot.graph.edges) {
      const source = edge.from.split(".")[0] ?? edge.from;
      const target = edge.to.split(".")[0] ?? edge.to;
      if (source !== id) continue;
      if (!depth.has(target) || (depth.get(target) ?? 0) < current + 1) {
        depth.set(target, current + 1);
        queue.push(target);
      }
    }
  }
  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  for (const node of ordered) {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    positions.set(node.id, { x: 32 + column * 250, y: 32 + row * 104 });
  }
  return positions;
}

function subtitle(node: SnapshotNode): string {
  if (node.command) return node.command;
  if (node.cli) return node.model ? `${node.cli} · ${node.model}` : node.cli;
  return "";
}

export function RunCanvas({
  snapshot,
  view,
  selectedPath,
  layout,
  onSelect,
  runId = "",
  isReplay = false,
}: {
  snapshot: WorkflowSnapshot;
  view: RunView;
  selectedPath: string | null;
  /** Immutable editor coordinates from this run's raw snapshot, when available. */
  layout?: Record<string, { x: number; y: number }>;
  onSelect: (path: string) => void;
  runId?: string;
  isReplay?: boolean;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<Node<NodeData>, Edge> | null>(null);
  const instanceRef = useRef<ReactFlowInstance<Node<NodeData>, Edge> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastSize = useRef({ width: 0, height: 0 });
  const resizeTimer = useRef<number | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width < 40 || rect.height < 40) return;
      const last = lastSize.current;
      if (Math.abs(last.width - rect.width) < 2 && Math.abs(last.height - rect.height) < 2) {
        return;
      }
      lastSize.current = { width: rect.width, height: rect.height };
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        const flow = instanceRef.current;
        if (flow !== null) void flow.fitView({ padding: 0.18, duration: 0 });
      }, 100);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    };
  }, []);

  const routing = useMemo(
    () =>
      deriveRouting({ nodes: snapshot.graph.nodes, edges: snapshot.graph.edges }, view.executions),
    [snapshot, view],
  );

  const nodes = useMemo<Node<NodeData>[]>(() => {
    const fallback = autoLayout(snapshot);
    return snapshot.graph.nodes.map((node) => {
      const position = layout?.[node.id] ?? fallback.get(node.id) ?? { x: 0, y: 0 };
      const status = nodeStatus(view, node.id);
      const exec = executionFor(view, node.id);
      const derived = node.type === "approval" ? approvalForPath(view, node.id) : null;
      const frozen = derived?.frozen ?? null;
      const canAct =
        derived !== null &&
        isReplay === false &&
        isActionable(frozen, exec?.status ?? null, view.status, false, null, null) &&
        derived.pending;
      return {
        id: node.id,
        type: "workflow",
        position,
        selected: selectedPath === node.id,
        data: {
          id: node.id,
          name: node.name,
          kind: node.type,
          subtitle: subtitle(node),
          status,
          selected: selectedPath === node.id,
          testId: `run-node-${node.id}`,
          gateBranch: exec?.gateDecision?.branch ?? null,
          gateEvaluated: exec?.gateDecision?.evaluated ?? [],
          joinActive: exec?.joinResolution?.active ?? [],
          joinSkipped: exec?.joinResolution?.skipped ?? [],
          runId,
          approvalCanAct: canAct,
          approvalRequestId:
            typeof frozen?.requestId === "string" && frozen.requestId.length > 0
              ? frozen.requestId
              : null,
          approvalAttempt:
            typeof frozen?.attempt === "number" && Number.isInteger(frozen.attempt)
              ? frozen.attempt
              : null,
          approvalGeneration:
            typeof frozen?.generation === "number" && Number.isInteger(frozen.generation)
              ? frozen.generation
              : null,
        },
        ...(node.type === "gate" || node.type === "join" ? {} : { width: NODE_W, height: NODE_H }),
      };
    });
  }, [snapshot, view, selectedPath, layout, runId, isReplay]);

  const edges = useMemo<Edge[]>(() => {
    return snapshot.graph.edges.map((edge) => {
      const source = edge.from.split(".")[0] ?? edge.from;
      const target = edge.to.split(".")[0] ?? edge.to;
      const state = routing.edges[edge.id] ?? "pending";
      const targetStatus = executionFor(view, target)?.status ?? "pending";
      const className = edgeClass(state, targetStatus);
      const dead = state === "dead";
      return {
        id: edge.id,
        source,
        target,
        type: "smoothstep",
        animated: className === "live",
        className,
        ariaLabel: `${edge.id} ${state}`,
        style: {
          stroke:
            className === "live" || className === "done"
              ? "var(--accent)"
              : dead
                ? "var(--text-3)"
                : "var(--border-strong)",
          strokeWidth: className === "live" ? 2 : 1.5,
          strokeDasharray: dead ? "4 4" : undefined,
          opacity: dead ? 0.45 : 1,
        },
      };
    });
  }, [snapshot, routing, view]);

  const onInit = (flow: ReactFlowInstance<Node<NodeData>, Edge>): void => {
    instanceRef.current = flow;
    setInstance(flow);
  };

  return (
    <div className="canvas-wrap" data-testid="run-canvas" ref={wrapRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        onNodeClick={(_event, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll={false}
        zoomOnPinch
        minZoom={0.35}
        maxZoom={1.6}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: false }}
        aria-label="Workflow canvas (read-only)"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--border-strong)"
        />
        {snapshot.graph.nodes.length > 1 ? (
          <MiniMap
            pannable
            zoomable={false}
            nodeStrokeWidth={2}
            maskColor="var(--bg-muted)"
            nodeColor={(node) => {
              const status = (node.data as NodeData | undefined)?.status ?? "pending";
              if (status === "succeeded") return "var(--green)";
              if (status === "failed" || status === "rejected") return "var(--red)";
              if (status === "running" || status === "validating") return "var(--blue)";
              if (status === "waiting_quota" || status === "waiting_approval")
                return "var(--amber)";
              return "var(--border-strong)";
            }}
            style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
          />
        ) : null}
        <Controls
          showInteractive={false}
          onFitView={() => {
            void instance?.fitView({ padding: 0.2, duration: 0 });
          }}
        />
      </ReactFlow>
      <span className="sr-only">
        <StatusPill status={view.status} />
      </span>
    </div>
  );
}

export { executionFor };
