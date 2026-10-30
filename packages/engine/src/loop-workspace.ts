import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { DevChestraError, isRecord } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";

function hasExclusive(snapshot: unknown): boolean {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph) || !Array.isArray(snapshot.graph.nodes))
    return false;
  return snapshot.graph.nodes.some(
    (node) =>
      isRecord(node) &&
      (node.type === "loop" || node.type === "workflow" || node.type === "foreach"),
  );
}

function sharedDirectory(run: RunRecord): string | null {
  const binding = run.workspace;
  if (binding?.selection.mode === "new-worktree") return null;
  const directory =
    binding?.selection.mode === "existing-worktree"
      ? binding.selection.path
      : (binding?.projectRoot ?? run.project.path);
  try {
    const canonical = realpathSync.native(directory);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch (cause) {
    throw new DevChestraError("E_WORKSPACE", "Cannot resolve active run workspace ownership", {
      cause,
    });
  }
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === "" ||
    (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
  );
}

/**
 * Called inside the run-creation transaction, retaining ownership while parked.
 * Parent/child invocations in one lineage share the prepared workspace
 * sequentially (siblings never run concurrently — the parent parks while the
 * child runs), so lineage pairs are exempt; unrelated runs stay excluded.
 */
export function assertLoopWorkspaceAvailable(
  candidate: RunRecord,
  active: readonly RunRecord[],
  isRelated: (a: string, b: string) => boolean = () => false,
): void {
  if (!hasExclusive(candidate.snapshot) && !active.some((run) => hasExclusive(run.snapshot)))
    return;
  const directory = sharedDirectory(candidate);
  if (directory === null) return;
  for (const other of active) {
    if (
      other.id === candidate.id ||
      (!hasExclusive(candidate.snapshot) && !hasExclusive(other.snapshot))
    )
      continue;
    if (isRelated(candidate.id as string, other.id as string)) continue;
    const occupied = sharedDirectory(other);
    if (occupied !== null && (contains(directory, occupied) || contains(occupied, directory))) {
      throw new DevChestraError(
        "E_LOCKED",
        "A loop/workflow run requires exclusive use of its workspace until it finishes or is cancelled",
        {
          details: { runId: other.id },
        },
      );
    }
  }
}
