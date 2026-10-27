import type { RelayError } from "@relay/core";
import { compileExpression } from "./expression.js";
import { analyzeGraph } from "./graph.js";
import { WORKFLOW_ID_PATTERN } from "./ids.js";
import { joinOutputIssues } from "./join.js";
import { normalizeOutputSchema } from "./output-schema.js";
import { validateParamDefinitions } from "./params.js";
import { buildRequires } from "./requires.js";
import { compileTemplate } from "./template.js";
import type {
  AgentNode,
  ApprovalNode,
  EndNode,
  GateNode,
  Issue,
  JoinNode,
  ShellNode,
  StartNode,
  ValidationContext,
  ValidationReport,
  WorkflowFile,
  WorkflowNode,
} from "./types.js";
import { validateApproval } from "./validate-approval.js";
import {
  isRecord,
  issue,
  promptFilePath,
  relayIssue,
  retryBounds,
  timeoutBounds,
  workspaceProblem,
} from "./validate-support.js";
export function validateWorkflow(
  file: WorkflowFile,
  ctx: ValidationContext = {},
): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const referencedRoots = new Set<string>();
  const addError = (item: Issue): void => void errors.push(item);
  const addWarning = (item: Issue): void => void warnings.push(item);
  const addRelay = (error: RelayError, pointer: string, nodeId?: string): void =>
    addError(relayIssue(error, pointer, nodeId));
  if (!isRecord(file) || !isRecord(file.graph)) {
    return {
      ok: false,
      errors: [issue("error", "E_WORKFLOW_INVALID", "Workflow graph is missing or malformed.")],
      warnings: [],
      requires: buildRequires([]),
    };
  }
  if (file.schemaVersion !== 1) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        `Unsupported schemaVersion ${String(file.schemaVersion)}; this build supports 1.`,
        "/schemaVersion",
      ),
    );
  }
  if (typeof file.id !== "string" || !WORKFLOW_ID_PATTERN.test(file.id)) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_ID",
        `Workflow id '${String(file.id)}' must match ${WORKFLOW_ID_PATTERN.source} and equal the file stem.`,
        "/id",
      ),
    );
  }
  if (typeof file.name !== "string" || file.name.trim() === "" || file.name.length > 200) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_NAME",
        "Workflow name must be a non-empty string (max 200).",
        "/name",
      ),
    );
  }
  if (file.budget !== undefined) {
    const defined = Object.entries(file.budget).filter(([, value]) => value !== undefined);
    if (defined.length > 0) {
      addError(
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          `Workflow budgets are not implemented in P1 and would be ignored (${defined
            .map(([key]) => key)
            .join(", ")}). Remove the budget block; enforcement belongs to the engine.`,
          "/budget",
        ),
      );
    }
  }
  if (file.supervisor !== undefined) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        "supervisor is not implemented in P1; remove the supervisor block.",
        "/supervisor",
      ),
    );
  }
  if (!Array.isArray(file.graph.nodes) || !Array.isArray(file.graph.edges)) {
    return {
      ok: false,
      errors: [
        ...errors,
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          "graph.nodes and graph.edges must be arrays.",
          "/graph",
        ),
      ],
      warnings,
      requires: buildRequires([]),
    };
  }
  const nodes = file.graph.nodes as WorkflowNode[];
  const { analysis, issues: graphIssues } = analyzeGraph(file.graph);
  for (const graphIssue of graphIssues) addError(graphIssue);
  const checkRoots = (
    roots: readonly string[],
    allowed: Set<string>,
    pointer: string,
    nodeId: string,
    expression: string,
  ): void => {
    for (const root of roots) {
      referencedRoots.add(root);
      if (!allowed.has(root)) {
        const list = [...allowed].sort().join(", ");
        addError(
          issue(
            "error",
            "E_EXPR_SCOPE",
            `Expression root '${root}' is not in scope. Allowed: ${list || "(none)"}. Expression: ${expression}`,
            pointer,
            nodeId,
          ),
        );
      }
    }
  };
  const checkTemplate = (
    node: WorkflowNode,
    template: string,
    allowed: Set<string>,
    pointer: string,
    shell: boolean,
    label: string,
  ): void => {
    const compiled = compileTemplate(template, { shell });
    if (!compiled.ok) {
      addRelay(compiled.error, pointer, node.id);
      return;
    }
    for (const part of compiled.value.parts) {
      if (part.kind !== "expression") continue;
      checkRoots(part.compiled.roots, allowed, pointer, node.id, `${label}: {{ ${part.source} }}`);
    }
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const pointer = `/graph/nodes/${index}`;
    if (typeof node.name !== "string" || node.name.trim() === "" || node.name.length > 200) {
      addError(
        issue(
          "error",
          "E_NODE_NAME",
          `Node '${node.id}' name must be a non-empty string.`,
          `${pointer}/name`,
          node.id,
        ),
      );
    }
    if (node.supervise !== undefined && node.supervise !== "default") {
      addError(
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          `Node supervise mode '${node.supervise}' is not implemented in P1; use 'default' or omit it.`,
          `${pointer}/supervise`,
          node.id,
        ),
      );
    }
    if (node.env !== undefined && node.env.length > 0) {
      addError(
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          "env passthrough is not implemented in P1; remove node.env.",
          `${pointer}/env`,
          node.id,
        ),
      );
    }
    const allowed = new Set<string>(["start", ...analysis.ancestors(node.id)]);

    if (node.type === "start") {
      const start = node as StartNode;
      const paramIssues = validateParamDefinitions(start.params, `${pointer}/params`, node.id);
      for (const paramIssue of paramIssues) addError(paramIssue);
      continue;
    }

    if (node.type === "agent") {
      const agent = node as AgentNode;
      if (!["fake", "claude-code", "codex"].includes(agent.cli)) {
        addError(
          issue(
            "error",
            "E_WORKFLOW_INVALID",
            `Agent CLI '${String(agent.cli)}' is not supported in P1; use fake (test-only), claude-code or codex.`,
            `${pointer}/cli`,
            node.id,
          ),
        );
      } else if (agent.cli === "fake") {
        addWarning(
          issue(
            "warning",
            "W_FAKE_CLI",
            "Agent CLI 'fake' is test-only; do not use it for a real run.",
            `${pointer}/cli`,
            node.id,
          ),
        );
      }

      if (agent.prompt !== undefined && agent.promptFile !== undefined) {
        addError(
          issue(
            "error",
            "E_PROMPT",
            "Agent must set exactly one of prompt or promptFile.",
            `${pointer}`,
            node.id,
          ),
        );
      } else if (agent.prompt === undefined && agent.promptFile === undefined) {
        addError(
          issue("error", "E_PROMPT", "Agent must set prompt or promptFile.", `${pointer}`, node.id),
        );
      }
      if (agent.promptFile !== undefined) {
        if (typeof agent.promptFile !== "string" || !promptFilePath(file, agent.promptFile)) {
          addError(
            issue(
              "error",
              "E_PROMPT_FILE",
              `promptFile '${String(agent.promptFile)}' must be a relative .md file inside '${file.id}.prompts/'.`,
              `${pointer}/promptFile`,
              node.id,
            ),
          );
        } else {
          addWarning(
            issue(
              "warning",
              "W_PROMPT_FILE",
              `promptFile '${agent.promptFile}' must be inlined by the host before normalizeWorkflow; the schema package never reads the filesystem.`,
              `${pointer}/promptFile`,
              node.id,
            ),
          );
        }
      }
      if (typeof agent.prompt === "string") {
        checkTemplate(agent, agent.prompt, allowed, `${pointer}/prompt`, false, "prompt");
        if (agent.prompt.trim() === "") {
          addWarning(
            issue(
              "warning",
              "W_EMPTY_PROMPT",
              "Agent prompt is empty.",
              `${pointer}/prompt`,
              node.id,
            ),
          );
        }
      }

      if (!isRecord(agent.output)) {
        addError(
          issue(
            "error",
            "E_OUTPUT_SCHEMA",
            "Agent output must be a JSON schema object.",
            `${pointer}/output`,
            node.id,
          ),
        );
      } else {
        const normalized = normalizeOutputSchema(agent.output);
        if (!normalized.ok) {
          addRelay(normalized.error, `${pointer}/output`, node.id);
        } else {
          const properties = normalized.value.properties;
          const closed = normalized.value.additionalProperties !== true;
          if (closed && (!isRecord(properties) || Object.keys(properties).length === 0)) {
            addWarning(
              issue(
                "warning",
                "W_EMPTY_OUTPUT",
                "Agent output schema has no properties.",
                `${pointer}/output`,
                node.id,
              ),
            );
          }
        }
      }

      if (!isRecord(agent.permissions)) {
        addError(
          issue(
            "error",
            "E_PERMISSIONS",
            "Agent permissions are required.",
            `${pointer}/permissions`,
            node.id,
          ),
        );
      } else {
        if (typeof agent.permissions.network !== "boolean") {
          addError(
            issue(
              "error",
              "E_PERMISSIONS",
              "permissions.network must be a boolean.",
              `${pointer}/permissions/network`,
              node.id,
            ),
          );
        }
        if (
          !Array.isArray(agent.permissions.write) ||
          agent.permissions.write.some((entry) => entry !== "workspace" && entry !== "project")
        ) {
          addError(
            issue(
              "error",
              "E_PERMISSIONS",
              "permissions.write must be an array of 'workspace'|'project'.",
              `${pointer}/permissions/write`,
              node.id,
            ),
          );
        } else if (agent.permissions.write.includes("project")) {
          addError(
            issue(
              "error",
              "E_WORKFLOW_INVALID",
              "Project write permission is not supported in P1; use workspace-only access with a scratch workspace.",
              `${pointer}/permissions/write`,
              node.id,
            ),
          );
        }
        if (agent.permissions.network && agent.permissions.write.includes("project")) {
          addWarning(
            issue(
              "warning",
              "W_NETWORK_WRITE",
              "Agent has network access and project write access.",
              `${pointer}/permissions`,
              node.id,
            ),
          );
        }
      }

      if (agent.workspace !== undefined) {
        const agentWorkspaceProblem = workspaceProblem(agent.workspace, ctx.projectKind);
        if (agentWorkspaceProblem !== undefined) {
          addError(
            issue(
              "error",
              isRecord(agent.workspace) ? "E_WORKFLOW_INVALID" : "E_WORKSPACE",
              `Agent workspace: ${agentWorkspaceProblem}`,
              `${pointer}/workspace`,
              node.id,
            ),
          );
        }
      }

      if (agent.limits !== undefined) {
        const timeout = timeoutBounds(agent.limits.timeoutMin, "limits.timeoutMin");
        const validationRetries = retryBounds(
          agent.limits.validationRetries,
          "limits.validationRetries",
        );
        const crashRetries = retryBounds(agent.limits.crashRetries, "limits.crashRetries");
        if (timeout !== undefined) {
          addError(issue("error", "E_LIMITS", timeout, `${pointer}/limits/timeoutMin`, node.id));
        }
        if (validationRetries !== undefined) {
          addError(
            issue(
              "error",
              "E_LIMITS",
              validationRetries,
              `${pointer}/limits/validationRetries`,
              node.id,
            ),
          );
        }
        if (crashRetries !== undefined) {
          addError(
            issue("error", "E_LIMITS", crashRetries, `${pointer}/limits/crashRetries`, node.id),
          );
        }
        if (agent.limits.maxQuotaWaitHours !== undefined) {
          addError(
            issue(
              "error",
              "E_WORKFLOW_INVALID",
              "limits.maxQuotaWaitHours is not implemented in P1.",
              `${pointer}/limits/maxQuotaWaitHours`,
              node.id,
            ),
          );
        }
      }

      if (agent.context !== undefined) {
        if (agent.context.project !== "none" || agent.context.workflow !== "none") {
          addError(
            issue(
              "error",
              "E_WORKFLOW_INVALID",
              "Agent context project/workflow access is not implemented in P1; use none for both.",
              `${pointer}/context`,
              node.id,
            ),
          );
        }
      }

      if (agent.cliOptions !== undefined && Object.keys(agent.cliOptions).length > 0) {
        addError(
          issue(
            "error",
            "E_WORKFLOW_INVALID",
            "Agent cliOptions are not implemented in P1; remove cliOptions.",
            `${pointer}/cliOptions`,
            node.id,
          ),
        );
      }
      continue;
    }

    if (node.type === "shell") {
      const shell = node as ShellNode;
      if (typeof shell.command !== "string" || shell.command.trim() === "") {
        addError(
          issue(
            "error",
            "E_SHELL_COMMAND",
            "Shell command must be a non-empty string.",
            `${pointer}/command`,
            node.id,
          ),
        );
      } else {
        checkTemplate(shell, shell.command, allowed, `${pointer}/command`, true, "command");
      }
      if (shell.workspace !== undefined) {
        const shellWorkspaceProblem = workspaceProblem(shell.workspace, ctx.projectKind);
        if (shellWorkspaceProblem !== undefined) {
          addError(
            issue(
              "error",
              isRecord(shell.workspace) ? "E_WORKFLOW_INVALID" : "E_WORKSPACE",
              `Shell workspace: ${shellWorkspaceProblem}`,
              `${pointer}/workspace`,
              node.id,
            ),
          );
        }
      }
      const timeout = timeoutBounds(shell.timeoutMin, "timeoutMin");
      if (timeout !== undefined) {
        addError(issue("error", "E_LIMITS", timeout, `${pointer}/timeoutMin`, node.id));
      }
      continue;
    }

    if (node.type === "gate") {
      const gate = node as GateNode;
      for (const branch of gate.branches) {
        if (branch.otherwise === true) continue;
        if (typeof branch.when !== "string" || branch.when.trim() === "") continue;
        const compiled = compileExpression(branch.when);
        if (!compiled.ok) {
          addRelay(compiled.error, `${pointer}/branches`, node.id);
        } else {
          checkRoots(
            compiled.value.roots,
            allowed,
            `${pointer}/branches`,
            node.id,
            `when: ${branch.when}`,
          );
        }
      }
      continue;
    }

    if (node.type === "join") {
      const join = node as JoinNode;
      if (join.output !== undefined) {
        if (!isRecord(join.output)) {
          addError(
            issue(
              "error",
              "E_OUTPUT_SCHEMA",
              "Join output must be a JSON schema object.",
              `${pointer}/output`,
              node.id,
            ),
          );
        } else {
          const normalized = normalizeOutputSchema(join.output);
          if (!normalized.ok) addRelay(normalized.error, `${pointer}/output`, node.id);
        }
      }
      continue;
    }

    if (node.type === "approval") {
      validateApproval(node as ApprovalNode, pointer, allowed, addError, addRelay);
      continue;
    }

    if (node.type === "end") {
      const end = node as EndNode;
      if (!["success", "failed", "rejected"].includes(end.status)) {
        addError(
          issue(
            "error",
            "E_END_STATUS",
            "End status must be success, failed or rejected.",
            `${pointer}/status`,
            node.id,
          ),
        );
      }
      if (typeof end.result !== "string" || end.result.trim() === "") {
        addError(
          issue(
            "error",
            "E_END_RESULT",
            "End result expression must be non-empty.",
            `${pointer}/result`,
            node.id,
          ),
        );
      } else {
        const compiled = compileExpression(end.result);
        if (!compiled.ok) {
          addRelay(compiled.error, `${pointer}/result`, node.id);
        } else {
          checkRoots(
            compiled.value.roots,
            allowed,
            `${pointer}/result`,
            node.id,
            `result: ${end.result}`,
          );
        }
      }
    }
  }

  nodes.forEach((node, index) => {
    if (node.type !== "join") return;
    const report = joinOutputIssues(file.graph, node, index, referencedRoots.has(node.id));
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    requires: buildRequires(nodes, file.budget),
  };
}
