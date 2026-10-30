import { isRecord } from "@devchestra/core";
import type { ContextEntry } from "@devchestra/schema";
import type { ContextEntryRecord } from "@devchestra/store";

export interface FrozenContextPools {
  project: ContextEntry[];
  workflow: ContextEntry[];
}

export interface ContextAccess {
  project: "none" | "read";
  workflow: "none" | "read";
  execution: "none" | "read" | "readwrite";
}

const DEFAULT_ACCESS: ContextAccess = { project: "none", workflow: "none", execution: "none" };

function readEntries(value: unknown): ContextEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ContextEntry[] => {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      return [];
    }
    return [{ key: entry.key, value: entry.value }];
  });
}

/**
 * Static pools frozen in the run snapshot at launch. Reads both the new
 * `snapshot.contextPools` shape and the legacy fields (`snapshot.context`
 * workflow entries, `snapshot.projectContext`) so old runs still resolve.
 */
export function readContextPools(snapshot: unknown): FrozenContextPools {
  if (!isRecord(snapshot)) return { project: [], workflow: [] };
  const pools = snapshot.contextPools;
  if (isRecord(pools)) {
    return { project: readEntries(pools.project), workflow: readEntries(pools.workflow) };
  }
  return {
    project: readEntries(snapshot.projectContext),
    workflow: readEntries(snapshot.context),
  };
}

/**
 * Merge launch-time pools into the snapshot before it is hashed and persisted,
 * so static context is immutable for the run (same freeze discipline as the
 * child-workflow bundle). Unknown snapshot shapes pass through untouched.
 */
export function freezeContextPools(
  snapshot: unknown,
  project: readonly ContextEntry[] = [],
): unknown {
  if (!isRecord(snapshot)) return snapshot;
  const pools = readContextPools(snapshot);
  const rest = { ...snapshot } as Record<string, unknown>;
  delete rest.projectContext;
  return {
    ...rest,
    contextPools: {
      project: project.map((entry) => ({ key: entry.key, value: entry.value })),
      workflow: pools.workflow,
    },
  };
}

export function readContextAccess(raw: unknown): ContextAccess {
  if (!isRecord(raw)) return DEFAULT_ACCESS;
  const context = raw.context;
  if (!isRecord(context)) return DEFAULT_ACCESS;
  const pick = (value: unknown, allowed: readonly string[]): "none" | "read" | "readwrite" =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as "none" | "read" | "readwrite")
      : "none";
  return {
    project: pick(context.project, ["none", "read"]) as "none" | "read",
    workflow: pick(context.workflow, ["none", "read"]) as "none" | "read",
    execution: pick(context.execution, ["none", "read", "readwrite"]),
  };
}

const MAX_BLOCK_BYTES = 24 * 1024;

function formatEntries(entries: readonly { key: string; value: string }[]): string {
  return entries.map((entry) => `- ${entry.key}: ${entry.value}`).join("\n");
}

/**
 * Deterministic prompt block for one agent attempt. Static pools come from the
 * frozen snapshot; execution entries are listed live from the store so notes
 * written by earlier nodes are visible. Sections the node cannot read are
 * omitted, never redacted in place, so the model learns nothing about them.
 */
export function buildContextBlock(
  pools: FrozenContextPools,
  execution: readonly ContextEntryRecord[],
  access: ContextAccess,
): string {
  const sections: string[] = [];
  if (access.project === "read" && pools.project.length > 0) {
    sections.push(`[project]\n${formatEntries(pools.project)}`);
  }
  if (access.workflow === "read" && pools.workflow.length > 0) {
    sections.push(`[workflow]\n${formatEntries(pools.workflow)}`);
  }
  if (access.execution !== "none" && execution.length > 0) {
    const rows = execution.map((entry) => ({ key: entry.key, value: entry.value }));
    sections.push(`[execution]\n${formatEntries(rows)}`);
    if (access.execution === "readwrite") {
      sections.push(
        "Use the devchestra context tools to update [execution] notes for downstream agents.",
      );
    }
  }
  if (sections.length === 0) return "";
  let block = sections.join("\n\n");
  if (Buffer.byteLength(block, "utf8") > MAX_BLOCK_BYTES) {
    // ponytail: truncate oldest-first is wrong here; entries are key-sorted, so cut the tail.
    while (sections.length > 1 && Buffer.byteLength(block, "utf8") > MAX_BLOCK_BYTES) {
      sections.pop();
      block = sections.join("\n\n");
    }
    if (Buffer.byteLength(block, "utf8") > MAX_BLOCK_BYTES) {
      block = `${block.slice(0, MAX_BLOCK_BYTES)}\n…(truncated)`;
    }
  }
  return block;
}
