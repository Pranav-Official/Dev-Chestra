import { useStore, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, useState } from "react";

const MAX_ATTEMPTS = 6;

/**
 * React Flow draws an edge only once both of its nodes have measured handle
 * positions. Rebuilding node objects (every streamed run event, every
 * selection) clears those positions, and React Flow re-measures only when a
 * node's size changes, so a missed re-measure leaves every edge missing until
 * the canvas is remounted. This watches for nodes that have no handle
 * positions and asks React Flow to measure them again, with a few bounded
 * retries so an unmeasurable (hidden) canvas can never spin.
 *
 * Render it as a child of <ReactFlow>.
 */
export function EdgeHealer() {
  const updateNodeInternals = useUpdateNodeInternals();
  const unmeasured = useStore((state) => {
    const ids: string[] = [];
    for (const [id, node] of state.nodeLookup) {
      if (node.hidden !== true && !node.internals.handleBounds) ids.push(id);
    }
    return ids.join("\u0000");
  });
  // Retries so far; each attempt bumps it, which schedules the next (backed-off) one.
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (unmeasured === "") {
      if (attempts !== 0) setAttempts(0);
      return;
    }
    if (attempts >= MAX_ATTEMPTS) return;
    const ids = unmeasured.split("\u0000");
    const timer = window.setTimeout(
      () => {
        updateNodeInternals(ids);
        setAttempts((value) => value + 1);
      },
      40 * 2 ** attempts,
    );
    return () => window.clearTimeout(timer);
  }, [unmeasured, attempts, updateNodeInternals]);

  return null;
}
