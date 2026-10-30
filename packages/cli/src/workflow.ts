import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DevChestraError, type Result, type RunWorkspaceSelection } from "@devchestra/core";
import {
  hashWorkflow,
  type NormalizedWorkflow,
  normalizeWorkflow,
  parseWorkflowJson,
  validateWorkflow,
  type WorkflowFile,
  workflowNodes,
} from "@devchestra/schema";
import { pathSafety, realRoot } from "@devchestra/workspaces";
import { validateWorkspaceSelection } from "./workspace-service.js";

export interface LoadedWorkflow {
  projectRoot: string;
  projectId: string;
  projectName: string;
  projectKind: "git" | "folder";
  workflowPath: string;
  workflowId: string;
  raw: string;
  file: WorkflowFile;
  normalized: NormalizedWorkflow;
  workflowHash: string;
}

function projectKind(root: string): Promise<"git" | "folder"> {
  return stat(join(root, ".git"))
    .then(() => "git" as const)
    .catch(() => "folder" as const);
}

function workflowRelative(root: string, arg: string): string {
  const absolute = isAbsolute(arg) ? resolve(arg) : resolve(root, arg);
  if (!pathSafety.isInside(root, absolute)) {
    throw new DevChestraError(
      "E_FORBIDDEN_PATH",
      "Workflow path must be inside the project directory.",
      {
        details: { project: root, workflow: arg },
      },
    );
  }
  return relative(root, absolute);
}

async function readInsideFile(root: string, rel: string): Promise<string> {
  const resolved = pathSafety.resolveFileInside(root, rel);
  if (!resolved.ok) throw resolved.error;
  return readFile(resolved.value, "utf8");
}

async function loadPrompts(root: string, file: WorkflowFile): Promise<Record<string, string>> {
  const prompts: Record<string, string> = {};
  for (const node of workflowNodes(file.graph)) {
    if (node.type !== "agent" || node.promptFile === undefined) continue;
    const prefix = `${file.id}.prompts/`;
    const candidates = node.promptFile.startsWith(prefix)
      ? [node.promptFile]
      : [node.promptFile, `${prefix}${node.promptFile}`];
    let loaded: string | undefined;
    let last: unknown;
    for (const candidate of candidates) {
      try {
        loaded = await readInsideFile(root, candidate);
        break;
      } catch (error) {
        last = error;
      }
    }
    if (loaded === undefined) {
      throw new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Prompt file '${node.promptFile}' was not found inside the project.`,
        { details: { nodeId: node.id, candidates, cause: last } },
      );
    }
    prompts[node.promptFile] = loaded;
    prompts[`${prefix}${basename(node.promptFile)}`] = loaded;
  }
  return prompts;
}

export async function loadWorkflow(
  projectArg: string,
  workflowArg: string,
): Promise<LoadedWorkflow> {
  const projectRoot = realRoot(resolve(projectArg));
  const rel = workflowRelative(projectRoot, workflowArg);
  const workflowPath = pathSafety.resolveFileInside(projectRoot, rel);
  if (!workflowPath.ok) throw workflowPath.error;
  const raw = await readFile(workflowPath.value, "utf8");
  const parsed = parseWorkflowJson(raw);
  if (!parsed.ok) throw parsed.error;

  const report = validateWorkflow(parsed.value, { projectKind: await projectKind(projectRoot) });
  if (!report.ok) {
    const first = report.errors[0];
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      `Workflow is invalid: ${first?.message ?? "unknown error"}`,
      { details: { issues: report.errors, warnings: report.warnings } },
    );
  }

  const normalized = normalizeWorkflow(parsed.value, {
    prompts: await loadPrompts(projectRoot, parsed.value),
  });
  if (!normalized.ok) throw normalized.error;
  const workflowHash = await hashWorkflow(normalized.value);
  const projectId = `p1-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}`;
  return {
    projectRoot,
    projectId,
    projectName: basename(projectRoot) || "project",
    projectKind: await projectKind(projectRoot),
    workflowPath: workflowPath.value,
    workflowId: parsed.value.id,
    raw,
    file: parsed.value,
    normalized: normalized.value,
    workflowHash,
  };
}

/**
 * Resolve the run-level workspace for a CLI start. Read-only: existing paths
 * must belong to the trusted project's worktree list; no checkout is created
 * here. Omitted selection defaults to the project root.
 */
export async function resolveRunWorkspace(
  projectRoot: string,
  mode: "project" | "new-worktree" | "existing-worktree" | undefined,
  worktreePath: string | undefined,
): Promise<RunWorkspaceSelection> {
  if (mode === undefined || mode === "project") return { mode: "project" };
  if (mode === "new-worktree") return validateWorkspaceSelection(projectRoot, { mode });
  if (worktreePath === undefined || worktreePath === "") {
    throw new DevChestraError("E_VALIDATION", "An existing worktree requires --worktree-path.");
  }
  return validateWorkspaceSelection(projectRoot, {
    mode: "existing-worktree",
    path: worktreePath,
  });
}

export interface ResolvedChildRef {
  id: string;
  normalized: NormalizedWorkflow;
  hash: string;
  text: string;
}

/**
 * Project-bound single-id child read for the engine resolver.
 * Reads `.devchestra/workflows/<id>.json` inside the project root through the
 * safe path loader (no cwd guessing, 1 MiB cap via parseWorkflowJson).
 * Never walks transitively itself: the engine owns recursive resolution,
 * cycle detection and depth limits.
 */
export async function loadChildWorkflowResolved(
  projectRoot: string,
  workflowId: string,
): Promise<ResolvedChildRef> {
  if (!/^[a-z0-9-]{1,64}$/.test(workflowId)) {
    throw new DevChestraError("E_VALIDATION", `Child workflow id '${workflowId}' is invalid.`);
  }
  const rel = `.devchestra/workflows/${workflowId}.json`;
  const resolved = pathSafety.resolveFileInside(projectRoot, rel);
  if (!resolved.ok) throw resolved.error;
  const raw = await readFile(resolved.value, "utf8");
  const parsed = parseWorkflowJson(raw);
  if (!parsed.ok) throw parsed.error;
  if (parsed.value.id !== workflowId) {
    throw new DevChestraError("E_VALIDATION", "Workflow id must equal the file stem.");
  }
  const report = validateWorkflow(parsed.value, { projectKind: await projectKind(projectRoot) });
  if (!report.ok) {
    throw new DevChestraError(
      "E_VALIDATION",
      `Child workflow '${workflowId}' is invalid: ${report.errors[0]?.message ?? "unknown error"}`,
      { details: { issues: report.errors } },
    );
  }
  const normalized = normalizeWorkflow(parsed.value, {
    prompts: await loadPrompts(projectRoot, parsed.value),
  });
  if (!normalized.ok) throw normalized.error;
  return {
    id: workflowId,
    normalized: normalized.value,
    hash: await hashWorkflow(normalized.value),
    text: raw,
  };
}

/** Back-compat normalized-only child read (resolver uses the resolved form). */
export async function loadChildWorkflow(
  projectRoot: string,
  workflowId: string,
): Promise<NormalizedWorkflow> {
  return (await loadChildWorkflowResolved(projectRoot, workflowId)).normalized;
}

/**
 * Engine resolver bound to the CLI store: looks up the project root by
 * projectId, then performs the safe single-id read. Same-project enforced
 * (the read never leaves the project root); missing children fail explicitly.
 */
export function createCliWorkflowResolver(store: {
  projects: { get(projectId: string): { path: string } | null };
}): {
  resolve(
    projectId: string,
    workflowId: string,
  ): Promise<{ ok: true; value: ResolvedChildRef } | { ok: false; error: DevChestraError }>;
} {
  return {
    async resolve(projectId: string, workflowId: string) {
      const proj = store.projects.get(projectId);
      if (proj === null) {
        return {
          ok: false as const,
          error: new DevChestraError("E_NOT_FOUND", `Project '${projectId}' was not found.`),
        };
      }
      try {
        const value = await loadChildWorkflowResolved(proj.path, workflowId);
        return { ok: true as const, value };
      } catch (error) {
        if (error instanceof DevChestraError) return { ok: false as const, error };
        return {
          ok: false as const,
          error: new DevChestraError(
            "E_VALIDATION",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
  };
}

export function workflowRequiresRealAdapter(workflow: NormalizedWorkflow): boolean {
  return [...workflowNodes(workflow.graph)].some(
    (node) => node.type === "agent" && (node.cli as string) !== "fake",
  );
}

export function requireFakeScriptForFakeNodes(workflow: NormalizedWorkflow): boolean {
  return [...workflowNodes(workflow.graph)].some(
    (node) => node.type === "agent" && (node.cli as string) === "fake",
  );
}

export function devchestraErrorResult(error: DevChestraError): Result<never, DevChestraError> {
  return { ok: false, error };
}
