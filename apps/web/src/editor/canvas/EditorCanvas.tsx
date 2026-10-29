import { DECISION_UNCERTAIN_HANDLE, type Issue, type WorkflowFile } from "@devchestra/schema";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeMouseHandler,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  type NodeChange,
  type NodeMouseHandler,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@xyflow/react/dist/style.css";
import "../../styles/editor-canvas.css";
import { EdgeHealer } from "../../ui/EdgeHealer.js";
import { applyCommandToFile } from "../model/commands.js";
import {
  checkConnection,
  createDefaultNode,
  isSupportedNodeType,
  positionOf,
  snapPosition,
} from "../model/graph.js";
import { parseEndpoint } from "../model/routing.js";
import type {
  CommandOutcome,
  DocumentChange,
  EditorCommand,
  EditorSelection,
  Position,
} from "../model/types.js";
import { EDITOR_EDGE_TYPES, EdgeActionsContext, type EditorFlowEdge } from "./edges.js";
import { EDITOR_NODE_TYPES, type EditorFlowNode } from "./nodes.js";

export interface EditorCanvasProps {
  file: WorkflowFile;
  selection: EditorSelection;
  issues: readonly Issue[];
  readOnly?: boolean;
  onSelectionChange(selection: EditorSelection): void;
  onChange(next: WorkflowFile, change: DocumentChange): void;
  onConnectionRejected(message: string): void;
  onUndo?(): void;
  onRedo?(): void;
  onLoopOpen?(nodeId: string): void;
}

function issuesByNode(issues: readonly Issue[]): Map<string, Issue[]> {
  const byNode = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (issue.nodeId === undefined) continue;
    const list = byNode.get(issue.nodeId);
    if (list === undefined) byNode.set(issue.nodeId, [issue]);
    else list.push(issue);
  }
  return byNode;
}

function buildNodes(
  file: WorkflowFile,
  selection: EditorSelection,
  issues: readonly Issue[],
  readOnly: boolean,
  previous?: readonly EditorFlowNode[],
): EditorFlowNode[] {
  const byNode = issuesByNode(issues);
  const old = new Map((previous ?? []).map((node) => [node.id, node]));
  // A refusal can always route to `uncertain`, so warn whenever that handle is
  // unwired (the simpler rule the contract allows). Reaching it unwired fails
  // the run instead of silently falling through.
  const wiredSources = new Set(file.graph.edges.map((edge) => edge.from));
  return file.graph.nodes.map((node) => {
    const supported = isSupportedNodeType(node.type);
    const prior = old.get(node.id);
    const position =
      prior !== undefined && prior.data.node === node ? prior.position : positionOf(node);
    const unwiredUncertain =
      !supported || node.type !== "decision"
        ? undefined
        : !wiredSources.has(`${node.id}.${DECISION_UNCERTAIN_HANDLE}`);
    return {
      id: node.id,
      type: supported ? "editor" : "unsupported",
      position,
      // Keep the measured size: without it React Flow forgets the handle positions
      // and the node's edges disappear until the next re-measure.
      ...(prior?.measured === undefined ? {} : { measured: prior.measured }),
      selected: selection?.kind === "node" && selection.nodeId === node.id,
      draggable: !readOnly && supported,
      connectable: !readOnly && supported,
      data: {
        node,
        issues: byNode.get(node.id) ?? [],
        readOnly,
        unsupported: !supported,
        ...(unwiredUncertain === undefined ? {} : { unwiredUncertain }),
      },
    } as EditorFlowNode;
  });
}

function buildEdges(file: WorkflowFile, selection: EditorSelection): EditorFlowEdge[] {
  const byId = new Map(file.graph.nodes.map((node) => [node.id, node]));
  const edges: EditorFlowEdge[] = [];
  for (const edge of file.graph.edges) {
    const sourceEndpoint = parseEndpoint(edge.from);
    const targetEndpoint = parseEndpoint(edge.to);
    const sourceNode = byId.get(sourceEndpoint.nodeId);
    const targetNode = byId.get(targetEndpoint.nodeId);
    if (sourceNode === undefined || targetNode === undefined) continue;
    edges.push({
      id: edge.id,
      source: sourceNode.id,
      target: targetNode.id,
      type: "editor",
      selected: selection?.kind === "edge" && selection.edgeId === edge.id,
      data: { edge },
      sourceHandle:
        ((sourceNode as { type: string }).type === "gate" ||
          (sourceNode as { type: string }).type === "decision") &&
        sourceEndpoint.handle !== null
          ? `out:${sourceEndpoint.handle}`
          : (sourceNode as { type: string }).type === "approval" &&
              sourceEndpoint.handle === "rejected"
            ? "out:rejected"
            : "out",
      targetHandle:
        (targetNode as { type: string }).type === "join" && targetEndpoint.handle !== null
          ? `in:${targetEndpoint.handle}`
          : "in",
    });
  }
  return edges;
}

function connectionEndpoints(
  file: WorkflowFile,
  connection: Connection,
): { source: string; target: string } | null {
  if (connection.source === null || connection.target === null) return null;
  const sourceNode = file.graph.nodes.find((node) => node.id === connection.source);
  const targetNode = file.graph.nodes.find((node) => node.id === connection.target);
  if (sourceNode === undefined || targetNode === undefined) return null;
  let source = sourceNode.id;
  if ((sourceNode as { type: string }).type === "gate") {
    const handle = connection.sourceHandle;
    if (handle === null || handle === undefined || !handle.startsWith("out:")) return null;
    source = `${sourceNode.id}.${handle.slice(4)}`;
  } else if ((sourceNode as { type: string }).type === "approval") {
    const handle = connection.sourceHandle;
    if (handle === "out:rejected") source = `${sourceNode.id}.rejected`;
    else if (handle === "out" || handle === null || handle === undefined) source = sourceNode.id;
    else return null;
  } else if ((sourceNode as { type: string }).type === "decision") {
    const handle = connection.sourceHandle;
    if (handle === null || handle === undefined || !handle.startsWith("out:")) return null;
    source = `${sourceNode.id}.${handle.slice(4)}`;
  }
  let target = targetNode.id;
  if (targetNode.type === "join") {
    const handle = connection.targetHandle;
    if (handle === null || handle === undefined || !handle.startsWith("in:")) return null;
    target = `${targetNode.id}.${handle.slice(3)}`;
  }
  return { source, target };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    target.closest("[contenteditable='true']") !== null
  );
}

export function EditorCanvas({
  file,
  selection,
  issues,
  readOnly = false,
  onSelectionChange,
  onChange,
  onConnectionRejected,
  onUndo,
  onRedo,
  onLoopOpen,
}: EditorCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<EditorFlowNode, EditorFlowEdge> | null>(null);
  const fitTimer = useRef<number | null>(null);
  const fittedId = useRef<string | null>(null);
  const lastRejection = useRef<string | null>(null);
  const [nodes, setNodes] = useState<EditorFlowNode[]>(() =>
    buildNodes(file, selection, issues, readOnly),
  );

  useEffect(() => {
    setNodes((previous) => buildNodes(file, selection, issues, readOnly, previous));
  }, [file, selection, issues, readOnly]);

  const edges = useMemo(() => buildEdges(file, selection), [file, selection]);

  const run = useCallback(
    (command: EditorCommand): CommandOutcome => {
      const outcome = applyCommandToFile(file, command);
      if (!outcome.ok) {
        if (command.kind === "connect") onConnectionRejected(outcome.error);
        return outcome;
      }
      if (outcome.change !== null) onChange(outcome.state.file, outcome.change);
      return outcome;
    },
    [file, onChange, onConnectionRejected],
  );

  const fitView = useCallback(() => {
    const flow = flowRef.current;
    const wrap = wrapRef.current;
    if (flow === null || wrap === null) return;
    const flowNodes = flow.getNodes();
    if (flowNodes.length === 0) return;
    const bounds = getNodesBounds(flowNodes);
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(rect.width, 320);
    const height = Math.max(rect.height, 240);
    const viewport = getViewportForBounds(bounds, width, height, 0.35, 1.6, 0.18);
    flow.setViewport(viewport, { duration: 0 });
  }, []);

  useEffect(() => {
    if (fittedId.current === file.id) return;
    const timer = window.setTimeout(() => {
      if (flowRef.current === null) return;
      fitView();
      fittedId.current = file.id;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [file.id, fitView]);

  useEffect(() => {
    const element = wrapRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width < 40 || rect.height < 40) return;
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitView();
      }, 100);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
    };
  }, [fitView]);

  const onInit = useCallback(
    (instance: ReactFlowInstance<EditorFlowNode, EditorFlowEdge>) => {
      flowRef.current = instance;
      window.requestAnimationFrame(() => {
        fitView();
        fittedId.current = file.id;
      });
    },
    [file.id, fitView],
  );

  const handleNodesChange = useCallback((changes: NodeChange<EditorFlowNode>[]) => {
    const structural = changes.filter((change) => change.type !== "select");
    if (structural.length === 0) return;
    setNodes((current) => applyNodeChanges(structural, current));
  }, []);

  const handleNodeClick: NodeMouseHandler<EditorFlowNode> = useCallback(
    (_event, node) => {
      onSelectionChange({ kind: "node", nodeId: node.id });
    },
    [onSelectionChange],
  );

  const handleEdgeClick: EdgeMouseHandler<EditorFlowEdge> = useCallback(
    (_event, edge) => {
      onSelectionChange({ kind: "edge", edgeId: edge.id });
    },
    [onSelectionChange],
  );

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, _node: EditorFlowNode, dragged: EditorFlowNode[]) => {
      if (readOnly) return;
      const positions: Record<string, Position> = {};
      for (const item of dragged) {
        if (!isSupportedNodeType(item.data.node.type)) continue;
        positions[item.id] = snapPosition(item.position);
      }
      if (Object.keys(positions).length === 0) return;
      run({ kind: "moveNodes", positions });
    },
    [readOnly, run],
  );

  const isValidConnection = useCallback(
    (connection: Connection | EditorFlowEdge) => {
      if (readOnly) return false;
      const endpoints = connectionEndpoints(file, connection as Connection);
      if (endpoints === null) {
        lastRejection.current =
          "Connect from a Gate branch or Decision handle, and into a Join input.";
        return false;
      }
      const result = checkConnection(file, endpoints);
      lastRejection.current = result.ok ? null : (result.message ?? null);
      return result.ok;
    },
    [file, readOnly],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      const endpoints = connectionEndpoints(file, connection);
      if (endpoints === null) return;
      lastRejection.current = null;
      run({ kind: "connect", connection: endpoints });
    },
    [file, readOnly, run],
  );

  const handleConnectEnd = useCallback(
    (_event: unknown, state: { toNode: unknown; isValid: boolean | null }) => {
      if (state.toNode !== null && state.isValid === false && lastRejection.current !== null) {
        onConnectionRejected(lastRejection.current);
      }
      lastRejection.current = null;
    },
    [onConnectionRejected],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.preventDefault();
      const raw =
        event.dataTransfer.getData("application/devchestra-node") ||
        event.dataTransfer.getData("text/node");
      if (!isSupportedNodeType(raw)) return;
      const type = raw as string;
      const point = flowRef.current?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }) ?? { x: 32, y: 32 };
      const node = createDefaultNode(type, file.graph.nodes, {
        x: point.x - 84,
        y: point.y - 30,
      });
      const outcome = run({ kind: "addNode", node });
      if (outcome.ok) onSelectionChange({ kind: "node", nodeId: node.id });
    },
    [file.graph.nodes, onSelectionChange, readOnly, run],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const mutatingShortcut =
        (mod && (key === "z" || key === "y")) ||
        event.key === "Delete" ||
        event.key === "Backspace";
      if (readOnly && mutatingShortcut) {
        event.preventDefault();
        return;
      }
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        onRedo?.();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selection === null) return;
        event.preventDefault();
        const outcome =
          selection.kind === "node"
            ? run({ kind: "removeNode", nodeId: selection.nodeId })
            : run({ kind: "removeEdge", edgeId: selection.edgeId });
        if (outcome.ok) onSelectionChange(null);
        return;
      }
      const target = event.target as HTMLElement;
      const tabFromCanvas =
        event.target === wrapRef.current || target.classList.contains("react-flow__pane");
      if (event.key === "Tab" && tabFromCanvas && !mod) {
        event.preventDefault();
        if (nodes.length === 0) return;
        const current =
          selection?.kind === "node" ? nodes.findIndex((node) => node.id === selection.nodeId) : -1;
        const delta = event.shiftKey ? -1 : 1;
        const next = (current + delta + nodes.length) % nodes.length;
        const node = nodes[next];
        if (node !== undefined) onSelectionChange({ kind: "node", nodeId: node.id });
        return;
      }
      const directions: Record<string, [number, number]> = {
        ArrowRight: [1, 0],
        ArrowLeft: [-1, 0],
        ArrowDown: [0, 1],
        ArrowUp: [0, -1],
      };
      const direction = directions[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      if (nodes.length === 0) return;
      const [dx, dy] = direction;
      const current =
        selection?.kind === "node" ? nodes.find((node) => node.id === selection.nodeId) : undefined;
      if (current === undefined) {
        const first = nodes[0];
        if (first !== undefined) onSelectionChange({ kind: "node", nodeId: first.id });
        return;
      }
      let best: EditorFlowNode | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const node of nodes) {
        if (node.id === current.id) continue;
        const mx = node.position.x - current.position.x;
        const my = node.position.y - current.position.y;
        const primary = dx !== 0 ? mx * dx : my * dy;
        if (primary <= 0) continue;
        const secondary = dx !== 0 ? Math.abs(my) : Math.abs(mx);
        const score = primary + secondary * 2;
        if (score < bestScore) {
          best = node;
          bestScore = score;
        }
      }
      if (best !== undefined) onSelectionChange({ kind: "node", nodeId: best.id });
    },
    [nodes, onRedo, onSelectionChange, onUndo, readOnly, run, selection],
  );

  const edgeActions = useMemo(
    () =>
      readOnly
        ? null
        : {
            remove: (edgeId: string) => {
              const outcome = run({ kind: "removeEdge", edgeId });
              if (outcome.ok) onSelectionChange(null);
            },
          },
    [onSelectionChange, readOnly, run],
  );

  return (
    <EdgeActionsContext.Provider value={edgeActions}>
      <div
        className="editor-canvas"
        ref={wrapRef}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas is the keyboard-navigation surface.
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDrop={handleDrop}
        onDragOver={(event) => {
          if (readOnly) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        aria-label={readOnly ? "Workflow canvas (read-only)" : "Workflow editor canvas"}
        data-testid="editor-canvas"
      >
        <ReactFlow<EditorFlowNode, EditorFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={EDITOR_NODE_TYPES}
          edgeTypes={EDITOR_EDGE_TYPES}
          onInit={onInit}
          onNodesChange={handleNodesChange}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={(event, node) => {
            if (readOnly || node.data.node.type !== "loop" || !onLoopOpen) return;
            event.stopPropagation();
            onSelectionChange({ kind: "node", nodeId: node.id });
            onLoopOpen(node.id);
          }}
          onEdgeClick={handleEdgeClick}
          onPaneClick={() => onSelectionChange(null)}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onConnectEnd={handleConnectEnd}
          isValidConnection={isValidConnection}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[8, 8]}
          panOnDrag
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          minZoom={0.35}
          maxZoom={1.6}
          fitView={false}
          proOptions={{ hideAttribution: false }}
          aria-label={readOnly ? "Workflow canvas (read-only)" : "Workflow editor canvas"}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--border-strong)"
          />
          <EdgeHealer />
          {nodes.length > 1 ? (
            <MiniMap
              pannable
              zoomable={false}
              nodeStrokeWidth={2}
              maskColor="var(--bg-muted)"
              nodeColor={(node) =>
                node.data?.unsupported === true ? "var(--text-3)" : "var(--border-strong)"
              }
              style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
            />
          ) : null}
          <Controls
            showInteractive={false}
            onFitView={() => {
              fitView();
            }}
          />
        </ReactFlow>
        {nodes.length === 0 ? (
          <div className="editor-canvas-empty">
            <p>Add a node from the palette, or drag one here.</p>
          </div>
        ) : null}
      </div>
    </EdgeActionsContext.Provider>
  );
}
