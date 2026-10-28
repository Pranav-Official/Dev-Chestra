import type { DevChestraError } from "@devchestra/core";
import type { Issue, ValidationContext, WorkflowFile } from "./types.js";

const PROMPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function workspaceProblem(
  workspace: unknown,
  projectKind: ValidationContext["projectKind"],
): string | undefined {
  if (!isRecord(workspace)) return "Workspace is required.";
  const mode = workspace.mode;
  if (mode === "scratch") return undefined;
  if (mode === "worktree") {
    for (const key of ["base", "setup", "from"] as const) {
      if (workspace[key] !== undefined) {
        return `workspace.${key} is not supported; worktrees start from the project's HEAD at first acquisition. Remove '${key}'.`;
      }
    }
    if (projectKind === "folder") {
      return "Worktree workspaces require a Git project.";
    }
    return undefined;
  }
  if (mode === "project") {
    return undefined;
  }
  return `Workspace mode '${String(mode)}' is not supported; use a supported legacy mode.`;
}

export function timeoutBounds(value: number | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 480) {
    return `${name} must be an integer between 1 and 480 minutes.`;
  }
  return undefined;
}

export function retryBounds(value: number | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    return `${name} must be an integer between 0 and 10.`;
  }
  return undefined;
}

export function promptFilePath(file: WorkflowFile, value: string): boolean {
  if (value.startsWith("/") || value.includes("..")) return false;
  const prefix = `${file.id}.prompts/`;
  const name = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (name.includes("/")) return false;
  return PROMPT_FILE.test(name);
}

export function issue(
  severity: "error" | "warning",
  code: string,
  message: string,
  pointer?: string,
  nodeId?: string,
): Issue {
  return {
    severity,
    code,
    message,
    ...(pointer === undefined ? {} : { pointer }),
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

export function devchestraIssue(error: DevChestraError, pointer: string, nodeId?: string): Issue {
  const detail =
    isRecord(error.details) && typeof error.details.pointer === "string"
      ? error.details.pointer
      : "";
  return issue("error", error.code, error.message, `${pointer}${detail}`, nodeId);
}
