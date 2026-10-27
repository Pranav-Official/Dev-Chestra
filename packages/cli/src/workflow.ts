import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { RelayError, type Result, type RunWorkspaceSelection } from "@relay/core";
import {
  hashWorkflow,
  type NormalizedWorkflow,
  normalizeWorkflow,
  parseWorkflowJson,
  validateWorkflow,
  type WorkflowFile,
} from "@relay/schema";
import { pathSafety, realRoot } from "@relay/workspaces";
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
    throw new RelayError(
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
  for (const node of file.graph.nodes) {
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
      throw new RelayError(
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
    throw new RelayError(
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
    throw new RelayError("E_VALIDATION", "An existing worktree requires --worktree-path.");
  }
  return validateWorkspaceSelection(projectRoot, {
    mode: "existing-worktree",
    path: worktreePath,
  });
}

export function workflowRequiresRealAdapter(workflow: NormalizedWorkflow): boolean {
  return workflow.graph.nodes.some((node) => node.type === "agent" && node.cli !== "fake");
}

export function requireFakeScriptForFakeNodes(workflow: NormalizedWorkflow): boolean {
  return workflow.graph.nodes.some((node) => node.type === "agent" && node.cli === "fake");
}

export function relayErrorResult(error: RelayError): Result<never, RelayError> {
  return { ok: false, error };
}
