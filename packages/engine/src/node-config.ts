import { DevChestraError, isRecord } from "@devchestra/core";
import { validateShellPolicy } from "@devchestra/schema";

/** Node kinds whose config the engine validates here; richer kinds are planned in graph-plan. */
export type BaseNodeKind = "start" | "agent" | "shell" | "end";

function invalid(message: string, details?: unknown): DevChestraError {
  return new DevChestraError(
    "E_WORKFLOW_INVALID",
    message,
    details === undefined ? {} : { details },
  );
}

/** Shared config validation for the node types the engine can execute. */
export function validateBaseNodeConfig(
  node: Record<string, unknown>,
  kind: BaseNodeKind,
  platform: NodeJS.Platform = process.platform,
): void {
  if (kind === "start") validateStart(node);
  if (kind === "agent") validateAgent(node, platform);
  if (kind === "shell") validateShell(node);
  if (kind === "end") validateEnd(node);
}

function validateStart(node: Record<string, unknown>): void {
  if (!Array.isArray(node.params)) throw invalid("Start node params must be an array", node);
  for (const [index, param] of node.params.entries()) {
    if (!isRecord(param) || typeof param.name !== "string" || param.name === "") {
      throw invalid(`Start parameter ${index} must have a name`, param);
    }
    if (
      param.type !== "string" &&
      param.type !== "number" &&
      param.type !== "boolean" &&
      param.type !== "enum"
    ) {
      throw invalid(`Start parameter ${param.name} has an unsupported type`, param);
    }
    if (typeof param.required !== "boolean") {
      throw invalid(`Start parameter ${param.name} must declare required`, param);
    }
    if (param.type === "enum" && !Array.isArray(param.options)) {
      throw invalid(`Enum parameter ${param.name} must declare options`, param);
    }
  }
}

function validateWorkspace(node: Record<string, unknown>, nodeType: string): void {
  const workspace = node.workspace;
  // Legacy node workspace is optional; run-level selection drives fresh runs.
  if (workspace === undefined) return;
  if (isRecord(workspace) && workspace.mode === "scratch") return;
  // Legacy metadata for old documents; fresh runs use the run-level choice.
  if (isRecord(workspace) && workspace.mode === "project") return;
  if (isRecord(workspace) && workspace.mode === "worktree") {
    for (const key of ["base", "setup", "from"] as const) {
      if (workspace[key] !== undefined) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          `worktree.${key} is not supported; worktrees start from the project HEAD`,
          { details: { nodeId: node.id, workspace } },
        );
      }
    }
    return;
  }
  throw new DevChestraError(
    "E_WORKFLOW_INVALID",
    `Workspace mode must be scratch or worktree (${nodeType} node)`,
    { details: { nodeId: node.id, workspace } },
  );
}

function validateAgent(node: Record<string, unknown>, platform: NodeJS.Platform): void {
  if (typeof node.cli !== "string" || node.cli === "") {
    throw invalid("Agent node must declare a cli", node);
  }
  if (typeof node.prompt !== "string") {
    throw invalid("Agent node prompt must be inlined during normalization", node);
  }
  if (node.promptFile !== undefined) {
    throw invalid("Agent promptFile must be inlined during normalization", node);
  }
  if (!isRecord(node.output) || node.output.type !== "object") {
    throw invalid("Agent node output must be an object schema", node);
  }
  if (containsArtifact(node.output)) {
    throw new DevChestraError("E_WORKFLOW_INVALID", "Artifact outputs are not supported", {
      details: { nodeId: node.id },
    });
  }
  if (!isRecord(node.permissions)) {
    throw invalid("Agent node permissions are required", node);
  }
  validateAgentShellPolicy(node, platform);
  const write = node.permissions.write;
  if (Array.isArray(write) && write.includes("project")) {
    throw new DevChestraError("E_WORKFLOW_INVALID", "Project write access is not supported", {
      details: { nodeId: node.id },
    });
  }
  if (node.context !== undefined) {
    if (!isRecord(node.context)) throw invalid("Agent context must be an object", node);
    if (node.context.project !== undefined && node.context.project !== "none") {
      throw new DevChestraError("E_WORKFLOW_INVALID", "Context banks are not supported", {
        details: { nodeId: node.id, context: node.context },
      });
    }
    if (node.context.workflow !== undefined && node.context.workflow !== "none") {
      throw new DevChestraError("E_WORKFLOW_INVALID", "Context banks are not supported", {
        details: { nodeId: node.id, context: node.context },
      });
    }
  }
  validateWorkspace(node, "agent");
  validateLimits(node);
}

function validateAgentShellPolicy(node: Record<string, unknown>, platform: NodeJS.Platform): void {
  const permissions = node.permissions as Record<string, unknown>;
  const policy = permissions.shellPolicy;
  if (policy === undefined) return;
  // A policy turns the CLI's native shell off and routes every command through the
  // gateway exec tool, which only runs on POSIX hosts. Failing here keeps a Windows
  // run from starting an agent that could never execute a command.
  if (platform === "win32") {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      "Agent shellPolicy is not supported on Windows: the policy command runner is POSIX-only. Remove permissions.shellPolicy or run this workflow on macOS/Linux.",
      { details: { nodeId: node.id, platform } },
    );
  }
  if (permissions.shell === false) {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      "Agent shellPolicy requires shell to be enabled",
      {
        details: { nodeId: node.id },
      },
    );
  }
  const problems = validateShellPolicy(policy);
  if (problems.length > 0) {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      `Agent shellPolicy is invalid: ${problems[0]?.message ?? "unknown error"}`,
      { details: { nodeId: node.id, problems } },
    );
  }
  throw new DevChestraError(
    "E_WORKFLOW_INVALID",
    "Agent shellPolicy is unavailable until runtime enforcement is installed",
    { details: { nodeId: node.id } },
  );
}

function validateShell(node: Record<string, unknown>): void {
  if (typeof node.command !== "string") throw invalid("Shell node command must be a string", node);
  validateWorkspace(node, "shell");
  if (typeof node.timeoutMin !== "number") throw invalid("Shell node timeoutMin is required", node);
}

function validateEnd(node: Record<string, unknown>): void {
  if (node.status !== "success" && node.status !== "failed" && node.status !== "rejected") {
    throw invalid("End node status must be success, failed or rejected", node);
  }
  if (typeof node.result !== "string")
    throw invalid("End node result expression is required", node);
}

function validateLimits(node: Record<string, unknown>): void {
  if (node.limits === undefined) return;
  if (!isRecord(node.limits)) throw invalid("Agent limits must be an object", node);
  for (const key of ["validationRetries", "crashRetries"] as const) {
    const value = node.limits[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw invalid(`Agent limits.${key} must be a non-negative integer`, node);
    }
  }
}

function containsArtifact(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsArtifact);
  if (!isRecord(value)) return false;
  if (value.format === "devchestra-artifact") return true;
  return Object.values(value).some(containsArtifact);
}
