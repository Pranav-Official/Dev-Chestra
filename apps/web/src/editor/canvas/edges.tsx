import type { Edge } from "@relay/schema";
import {
  BaseEdge,
  type EdgeProps,
  type Edge as FlowEdge,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";

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
  let path: string;
  if (route !== null) {
    const points: [number, number][] = [[sourceX, sourceY], ...route, [targetX, targetY]];
    path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  } else if (targetX < sourceX) {
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 10,
    });
  } else {
    [path] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  }
  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={18}
      className={`ed-edge-path${selected ? " selected" : ""}`}
    />
  );
}

export const EDITOR_EDGE_TYPES = { editor: EditorEdgeView } as const;
