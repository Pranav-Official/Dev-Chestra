import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { DevChestraError, isRecord } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";

function hasLoop(snapshot: unknown): boolean {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph) || !Array.isArray(snapshot.graph.nodes))
    return false;
  return snapshot.graph.nodes.some((node) => isRecord(node) && node.type === "loop");
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

/** Called inside the run-creation transaction, retaining ownership while parked. */
export function assertLoopWorkspaceAvailable(
  candidate: RunRecord,
  active: readonly RunRecord[],
): void {
  if (!hasLoop(candidate.snapshot) && !active.some((run) => hasLoop(run.snapshot))) return;
  const directory = sharedDirectory(candidate);
  if (directory === null) return;
  for (const other of active) {
    if (other.id === candidate.id || (!hasLoop(candidate.snapshot) && !hasLoop(other.snapshot)))
      continue;
    const occupied = sharedDirectory(other);
    if (occupied !== null && (contains(directory, occupied) || contains(occupied, directory))) {
      throw new DevChestraError(
        "E_LOCKED",
        "A loop run requires exclusive use of its workspace until it finishes or is cancelled",
        {
          details: { runId: other.id },
        },
      );
    }
  }
}
