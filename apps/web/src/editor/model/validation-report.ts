import type { Issue, RequiresSummary, ValidationReport } from "@devchestra/schema";

export function emptyRequires(): RequiresSummary {
  return {
    clis: [],
    networkNodes: [],
    shellCommands: [],
    projectWriteNodes: [],
    worktreeNodes: [],
    providers: [],
    envVars: [],
    irreversibleApprovals: [],
    budget: {},
  };
}

export function errorReport(
  code: string,
  message: string,
  pointer?: string,
  nodeId?: string,
): ValidationReport {
  const error: Issue = {
    severity: "error",
    code,
    message,
    ...(pointer === undefined ? {} : { pointer }),
    ...(nodeId === undefined ? {} : { nodeId }),
  };
  return { ok: false, errors: [error], warnings: [], requires: emptyRequires() };
}

interface ErrorDetails {
  pointer?: unknown;
  nodeId?: unknown;
}

export function devchestraErrorReport(error: {
  code: string;
  message: string;
  details?: unknown;
}): ValidationReport {
  const details =
    error.details !== null && typeof error.details === "object"
      ? (error.details as ErrorDetails)
      : undefined;
  return errorReport(
    error.code,
    error.message,
    typeof details?.pointer === "string" ? details.pointer : undefined,
    typeof details?.nodeId === "string" ? details.nodeId : undefined,
  );
}
