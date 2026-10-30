import {
  type ExecutionIdentity,
  isRecord,
  type Path,
  parsePath,
  type Segment,
} from "@devchestra/core";
import { fail } from "./util.js";

export function validateMessage(m: string): string {
  if (typeof m !== "string" || m.trim() === "" || m.length > 4096 || m.includes("\u0000"))
    fail("E_VALIDATION", "approval message must be 1-4096 chars without null bytes");
  return m.trim();
}
export function validateBy(b: string): string {
  if (
    typeof b !== "string" ||
    b.trim() === "" ||
    b.length > 256 ||
    b.includes("\u0000") ||
    b.includes("\n")
  )
    fail("E_VALIDATION", "approval by must be 1-256 chars without null/newline");
  return b.trim();
}
export function validateNote(n: string | undefined): string | null {
  if (n === undefined) return null;
  if (typeof n !== "string" || n.length > 4096 || n.includes("\u0000"))
    fail("E_VALIDATION", "approval note must be <=4096 chars");
  const t = n.trim();
  return t === "" ? null : t;
}
export function validateCriteria(c: string[] | undefined): string[] | null {
  if (c === undefined) return null;
  if (!Array.isArray(c)) fail("E_VALIDATION", "approval criteria must be string[]");
  if (c.length > 32) fail("E_VALIDATION", "approval criteria max 32 entries");
  const out: string[] = [];
  for (const v of c) {
    if (typeof v !== "string" || v.trim() === "" || v.length > 256)
      fail("E_VALIDATION", "criteria entry 1-256 chars");
    out.push(v.trim());
  }
  return out.length === 0 ? null : out;
}
export function stableRequestId(id: ExecutionIdentity): string {
  return `${id.runId}:${id.path}:${id.attempt}:${id.generation}`;
}
function snapshotGraphAt(snapshot: unknown, segments: readonly Segment[]): unknown {
  if (!isRecord(snapshot))
    fail("E_INTERNAL", "Stored run snapshot is corrupt; refusing to resolve approval");
  let graph = snapshot.graph;
  // Each round segment enters that controller's body graph.
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (!seg || seg.round === undefined)
      fail("E_INTERNAL", "Stored loop execution path is corrupt");
    if (!isRecord(graph)) fail("E_INTERNAL", "Stored run snapshot graph is corrupt");
    const nodes = graph.nodes;
    if (!Array.isArray(nodes)) fail("E_INTERNAL", "Stored run snapshot nodes are corrupt");
    const node: unknown = nodes.find((entry) => isRecord(entry) && entry.id === seg.node);
    if (!isRecord(node) || node.type !== "loop" || !isRecord(node.body))
      fail("E_INTERNAL", "Stored loop controller or body is missing");
    graph = node.body;
  }
  return graph;
}

export function hasRejectedEdge(snapshot: unknown, fullPath: Path): boolean {
  const parsed = parsePath(fullPath);
  if (!parsed.ok) fail("E_INTERNAL", "Stored execution path is corrupt", { path: fullPath });
  const segments = parsed.value;
  const last = segments.at(-1);
  if (!last) fail("E_INTERNAL", "Stored execution path is empty");
  const graph = snapshotGraphAt(snapshot, segments);
  if (typeof graph !== "object" || graph === null)
    fail("E_INTERNAL", "Stored run snapshot graph is corrupt");
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) fail("E_INTERNAL", "Stored run snapshot edges are corrupt");
  const target = `${last.node}.rejected`;
  for (const e of edges) {
    if (e === null || typeof e !== "object")
      fail("E_INTERNAL", "Stored run snapshot edge is corrupt");
    const from = (e as { from?: unknown }).from;
    if (typeof from !== "string") fail("E_INTERNAL", "Stored run snapshot edge from is corrupt");
    if (from === target) return true;
  }
  return false;
}
