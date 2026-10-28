import type { ExecutionIdentity } from "@devchestra/core";
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
export function hasRejectedEdge(snapshot: unknown, nodeId: string): boolean {
  const s = snapshot as { graph?: { edges?: { from?: string }[] } } | null;
  if (s === null || typeof s !== "object")
    fail("E_INTERNAL", "Stored run snapshot is corrupt; refusing to resolve approval");
  const graph = s.graph;
  if (graph === null || typeof graph !== "object" || graph === undefined)
    fail("E_INTERNAL", "Stored run snapshot graph is corrupt");
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) fail("E_INTERNAL", "Stored run snapshot edges are corrupt");
  const target = `${nodeId}.rejected`;
  for (const e of edges) {
    if (e === null || typeof e !== "object")
      fail("E_INTERNAL", "Stored run snapshot edge is corrupt");
    const from = (e as { from?: unknown }).from;
    if (typeof from !== "string") fail("E_INTERNAL", "Stored run snapshot edge from is corrupt");
    if (from === target) return true;
  }
  return false;
}
