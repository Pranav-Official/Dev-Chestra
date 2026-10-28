import type { Edge } from "@devchestra/schema";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge as FlowEdge,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";
import { X } from "lucide-react";
import { createContext, useContext } from "react";

/** Provided by the canvas; null while read-only so no delete control is offered. */
export const EdgeActionsContext = createContext<{ remove: (edgeId: string) => void } | null>(null);

export interface EditorEdgeData extends Record<string, unknown> {
  edge: Edge;
}

export type EditorFlowEdge = FlowEdge<EditorEdgeData, "editor">;

function routePoints(edge: Edge): [number, number][] | null {
  const route = edge.ui?.route;
  if (!Array.isArray(route)) return null;
  const points: [number, number][] = [];
  for (const point of route) {
    if (
      Array.isArray(point) &&
      point.length === 2 &&
      typeof point[0] === "number" &&
      typeof point[1] === "number"
    ) {
      points.push([point[0], point[1]]);
    }
  }
  return points.length > 0 ? points : null;
}

export function EditorEdgeView(props: EdgeProps<EditorFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } =
    props;
  const route = data === undefined ? null : routePoints(data.edge);
  const actions = useContext(EdgeActionsContext);
  let path: string;
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;
  if (route !== null) {
    const points: [number, number][] = [[sourceX, sourceY], ...route, [targetX, targetY]];
    path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
    const mid = points[Math.floor((points.length - 1) / 2)];
    const next = points[Math.floor(points.length / 2)];
    if (mid !== undefined && next !== undefined) {
      labelX = (mid[0] + next[0]) / 2;
      labelY = (mid[1] + next[1]) / 2;
    }
  } else if (targetX < sourceX) {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 10,
    });
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  }
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        className={`ed-edge-path${selected ? " selected" : ""}`}
      />
      {selected && actions !== null ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="ed-edge-delete nodrag nopan"
            data-testid="editor-edge-delete"
            aria-label="Delete connection"
            title="Delete connection"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation();
              actions.remove(id);
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const EDITOR_EDGE_TYPES = { editor: EditorEdgeView } as const;
