import type { DevChestraError } from "@devchestra/core";
import { compileExpression } from "./expression.js";
import { joinOutputIssues } from "./join.js";
import { normalizeOutputSchema } from "./output-schema.js";
import { validateParamDefinitions, validateWebhookConfig } from "./params.js";
import { validatePollingConfig } from "./poll.js";
import { shellPolicyIssues } from "./shell-policy.js";
import { compileTemplate } from "./template.js";
import type {
  AgentNode,
  ApprovalNode,
  DecisionNode,
  EndNode,
  GateNode,
  Graph,
  Issue,
  JoinNode,
  ShellNode,
  StartNode,
  WorkflowNode,
} from "./types.js";
import { MCP_SCOPES, PROD_CLI_LABELS, PROD_CLIS, type ValidationContext } from "./types.js";
import { validateApproval } from "./validate-approval.js";
import { validateDecision } from "./validate-decision.js";
import {
  isRecord,
  issue,
  promptFilePath,
  retryBounds,
  timeoutBounds,
  workspaceProblem,
} from "./validate-support.js";

const MCP_SERVER_NAME_MAX = 128;
const MCP_SERVERS_MAX = 32;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const MCP_SERVER_NAME_CONTROL = /[\u0000-\u001f\u007f]/;
const MCP_SCOPE_SET: ReadonlySet<string> = new Set(MCP_SCOPES);

function validateMcpServers(
  value: unknown,
  pointer: string,
  nodeId: string,
  addError: (item: Issue) => void,
): void {
  if (value === undefined) return;
  const base = `${pointer}/mcpServers`;
  if (!Array.isArray(value)) {
    addError(issue("error", "E_MCP_SERVERS", "Agent mcpServers must be an array.", base, nodeId));
    return;
  }
  if (value.length > MCP_SERVERS_MAX) {
    addError(
      issue(
        "error",
        "E_MCP_SERVERS",
        `Agent mcpServers must have at most ${MCP_SERVERS_MAX} entries.`,
        base,
        nodeId,
      ),
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = `${base}/${index}`;
    const selection = value[index];
    if (!isRecord(selection)) {
      addError(
        issue("error", "E_MCP_SERVERS", "Agent mcpServers entries must be objects.", entry, nodeId),
      );
      continue;
    }
    const { name, scope } = selection as { name?: unknown; scope?: unknown };
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > MCP_SERVER_NAME_MAX ||
      MCP_SERVER_NAME_CONTROL.test(name)
    ) {
      addError(
        issue(
          "error",
          "E_MCP_SERVERS",
          `Agent mcpServers[${index}].name must be 1-${MCP_SERVER_NAME_MAX} characters with no control characters.`,
          `${entry}/name`,
          nodeId,
        ),
      );
      continue;
    }
    if (name === "devchestra") {
      addError(
        issue(
          "error",
          "E_MCP_SERVERS",
          "Agent mcpServers name 'devchestra' is reserved for DevChestra's own server.",
          `${entry}/name`,
          nodeId,
        ),
      );
      continue;
    }
    if (typeof scope !== "string" || !MCP_SCOPE_SET.has(scope)) {
      addError(
        issue(
          "error",
          "E_MCP_SERVERS",
          `Agent mcpServers[${index}].scope must be one of ${MCP_SCOPES.join(", ")}.`,
          `${entry}/scope`,
          nodeId,
        ),
      );
      continue;
    }
    const key = `${scope}:${name}`;
    if (seen.has(key)) {
      addError(
        issue(
          "error",
          "E_MCP_SERVERS",
          `Agent mcpServers[${index}] duplicates '${key}'.`,
          entry,
          nodeId,
        ),
      );
    } else {
      seen.add(key);
    }
  }
}

export interface NodeCheckHelpers {
  checkRoots: (
    roots: readonly string[],
    allowed: Set<string>,
    pointer: string,
    nodeId: string,
    expression: string,
  ) => void;
  checkTemplate: (
    node: WorkflowNode,
    template: string,
    allowed: Set<string>,
    pointer: string,
    shell: boolean,
    label: string,
  ) => void;
  addError: (item: Issue) => void;
  addWarning: (item: Issue) => void;
  addDevChestra: (error: DevChestraError, pointer: string, nodeId?: string) => void;
  fileId: string;
  ctx: ValidationContext;
}

/** Common fields also checked when a loop is validated in isolation. */
export function validateNodeBase(
  node: { id?: unknown; name?: unknown; supervise?: unknown; env?: unknown },
  pointer: string,
  addError: (issue: Issue) => void,
): void {
  const nodeId = typeof node.id === "string" ? node.id : undefined;
  if (typeof node.name !== "string" || node.name.trim() === "" || node.name.length > 200) {
    addError(
      issue(
        "error",
        "E_NODE_NAME",
        `Node '${node.id}' name must be a non-empty string.`,
        `${pointer}/name`,
        nodeId,
      ),
    );
  }
  if (node.supervise !== undefined && node.supervise !== "default") {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        `Node supervise mode '${node.supervise}' is not supported; use 'default' or omit it.`,
        `${pointer}/supervise`,
        nodeId,
      ),
    );
  }
  if (node.env !== undefined && (!Array.isArray(node.env) || node.env.length > 0)) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        "env passthrough is not supported; remove node.env.",
        `${pointer}/env`,
        nodeId,
      ),
    );
  }
}

/** Ordinary node rules, shared by parent graphs and loop bodies. */
export function validateSingleNode(
  node: WorkflowNode,
  pointer: string,
  allowed: Set<string>,
  helpers: NodeCheckHelpers,
): void {
  const { checkRoots, checkTemplate, addError, addWarning, addDevChestra, fileId, ctx } = helpers;
  validateNodeBase(node, pointer, addError);
  if (node.type === "start") {
    const start = node as StartNode;
    const paramIssues = validateParamDefinitions(start.params, `${pointer}/params`, node.id);
    for (const paramIssue of paramIssues) addError(paramIssue);
    for (const webhookIssue of validateWebhookConfig(start, `${pointer}/webhook`)) {
      addError(webhookIssue);
    }
    for (const pollIssue of validatePollingConfig(start, `${pointer}/polling`, {
      fileId,
      ctx,
    })) {
      if (pollIssue.severity === "warning") addWarning(pollIssue);
      else addError(pollIssue);
    }
    return;
  }

  if (node.type === "agent") {
    const agent = node as AgentNode;
    const prodClis: readonly string[] = PROD_CLIS;
    if (!prodClis.includes(agent.cli)) {
      if (agent.cli === ("fake" as string)) {
        addWarning(
          issue(
            "warning",
            "W_FAKE_CLI",
            "Agent CLI 'fake' is test-only (requires DEVCHESTRA_ALLOW_FAKE=1 at run time); do not use it for a real run.",
            `${pointer}/cli`,
            node.id,
          ),
        );
      } else {
        addError(
          issue(
            "error",
            "E_WORKFLOW_INVALID",
            `Agent CLI '${String(agent.cli)}' is not supported; use ${PROD_CLIS.join(", ")}. Fake is test-only behind DEVCHESTRA_ALLOW_FAKE=1.`,
            `${pointer}/cli`,
            node.id,
          ),
        );
      }
    }
    if (ctx.disabledClis?.includes(agent.cli)) {
      const label = PROD_CLI_LABELS[agent.cli] ?? agent.cli;
      addWarning(
        issue(
          "warning",
          "W_CLI_DISABLED",
          `Provider '${label}' is turned off in Settings > Providers. Runs that use this node are blocked.`,
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
      if (
        typeof agent.promptFile !== "string" ||
        !promptFilePath({ id: fileId } as never, agent.promptFile)
      ) {
        addError(
          issue(
            "error",
            "E_PROMPT_FILE",
            `promptFile '${String(agent.promptFile)}' must be a relative .md file inside '${fileId}.prompts/'.`,
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
        addDevChestra(normalized.error, `${pointer}/output`, node.id);
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
            "Project write permission is not supported; use workspace-only access with a scratch workspace.",
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
      if (agent.permissions.shell !== undefined && typeof agent.permissions.shell !== "boolean") {
        addError(
          issue(
            "error",
            "E_PERMISSIONS",
            "permissions.shell must be a boolean.",
            `${pointer}/permissions/shell`,
            node.id,
          ),
        );
      }
      for (const policyIssue of shellPolicyIssues(
        agent.permissions,
        `${pointer}/permissions`,
        node.id,
      )) {
        addError(policyIssue);
      }
    }

    validateMcpServers(agent.mcpServers, pointer, node.id, addError);

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
            "limits.maxQuotaWaitHours is not supported.",
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
            "Agent context project/workflow access is not supported; use none for both.",
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
          "Agent cliOptions are not supported; remove cliOptions.",
          `${pointer}/cliOptions`,
          node.id,
        ),
      );
    }
    return;
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
    return;
  }

  if (node.type === "gate") {
    const gate = node as GateNode;
    for (const branch of gate.branches) {
      if (branch.otherwise === true) continue;
      if (typeof branch.when !== "string" || branch.when.trim() === "") continue;
      const compiled = compileExpression(branch.when);
      if (!compiled.ok) {
        addDevChestra(compiled.error, `${pointer}/branches`, node.id);
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
    return;
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
        if (!normalized.ok) addDevChestra(normalized.error, `${pointer}/output`, node.id);
      }
    }
    return;
  }

  if (node.type === "approval") {
    validateApproval(node as ApprovalNode, pointer, allowed, addError, addDevChestra);
    return;
  }

  if (node.type === "decision") {
    validateDecision(node as DecisionNode, pointer, allowed, addError, addDevChestra);
    return;
  }

  if (node.type === "workflow") {
    const ref = node as unknown as {
      workflowId?: unknown;
      inputs?: unknown;
      output?: unknown;
    };
    if (typeof ref.workflowId !== "string" || ref.workflowId.trim() === "") {
      addError(
        issue(
          "error",
          "E_WORKFLOW_NODE_ID",
          "Workflow node workflowId must be a non-empty string.",
          `${pointer}/workflowId`,
          node.id,
        ),
      );
    }
    if (!isRecord(ref.inputs)) {
      addError(
        issue(
          "error",
          "E_WORKFLOW_NODE_INPUTS",
          "Workflow node inputs must be an object.",
          `${pointer}/inputs`,
          node.id,
        ),
      );
    } else {
      for (const [key, expr] of Object.entries(ref.inputs)) {
        if (typeof expr !== "string" || expr.trim() === "") {
          addError(
            issue(
              "error",
              "E_WORKFLOW_NODE_INPUTS",
              `Workflow input '${key}' must be a non-empty JSONata expression.`,
              `${pointer}/inputs/${key}`,
              node.id,
            ),
          );
          continue;
        }
        const compiled = compileExpression(expr);
        if (!compiled.ok) {
          addDevChestra(compiled.error, `${pointer}/inputs/${key}`, node.id);
        } else {
          checkRoots(
            compiled.value.roots,
            allowed,
            `${pointer}/inputs/${key}`,
            node.id,
            `inputs.${key}: ${expr}`,
          );
        }
      }
    }
    if (ref.output !== undefined) {
      if (!isRecord(ref.output)) {
        addError(
          issue(
            "error",
            "E_OUTPUT_SCHEMA",
            "Workflow output must be a JSON schema object.",
            `${pointer}/output`,
            node.id,
          ),
        );
      } else {
        const normalized = normalizeOutputSchema(ref.output);
        if (!normalized.ok) addDevChestra(normalized.error, `${pointer}/output`, node.id);
      }
    }
    return;
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
        addDevChestra(compiled.error, `${pointer}/result`, node.id);
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

export interface BodyChildHelpers extends NodeCheckHelpers {
  scopeOf: (nodeId: string) => Set<string>;
  base: string;
}

/**
 * Ordinary per-child validation for a loop body plus R17 join checks.
 * `extraReferenced` seeds the reference set with loop-level expression roots
 * (result/until/nextState) so body joins referenced only from the controller
 * still require an output schema. Body expression roots are collected locally
 * and never leak into the parent workflow's reference set.
 */
export function validateLoopBodyChildren(
  body: Graph,
  opts: {
    scopeOf: (nodeId: string) => Set<string>;
    base: string;
    extraReferenced: Set<string>;
    fileId: string;
    ctx: ValidationContext;
    addError: (item: Issue) => void;
    addWarning: (item: Issue) => void;
    addDevChestra: (error: DevChestraError, pointer: string, nodeId?: string) => void;
  },
): void {
  const { scopeOf, base, extraReferenced, fileId, ctx, addError, addWarning, addDevChestra } = opts;
  const bodyReferenced = new Set<string>();
  const checkRoots = (
    roots: readonly string[],
    allowed: Set<string>,
    pointer: string,
    nodeId: string,
    expression: string,
  ): void => {
    for (const root of roots) {
      bodyReferenced.add(root);
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
      addDevChestra(compiled.error, pointer, node.id);
      return;
    }
    for (const part of compiled.value.parts) {
      if (part.kind !== "expression") continue;
      checkRoots(part.compiled.roots, allowed, pointer, node.id, `${label}: {{ ${part.source} }}`);
    }
  };
  const helpers: NodeCheckHelpers = {
    checkRoots,
    checkTemplate,
    addError,
    addWarning,
    addDevChestra,
    fileId,
    ctx,
  };
  body.nodes.forEach((child, index) => {
    validateSingleNode(child, `${base}/body/nodes/${index}`, scopeOf(child.id), helpers);
  });
  const fullRef = new Set<string>([...bodyReferenced, ...extraReferenced]);
  body.nodes.forEach((child, index) => {
    if (child.type !== "join") return;
    const report = joinOutputIssues(body, child as never, index, fullRef.has(child.id));
    for (const item of [...report.errors, ...report.warnings]) {
      const remapped =
        item.pointer === undefined
          ? `${base}/body/nodes/${index}/output`
          : item.pointer.replace(/^\/graph\/nodes\/\d+/, `${base}/body/nodes/${index}`);
      if (item.severity === "error") addError({ ...item, pointer: remapped });
      else addWarning({ ...item, pointer: remapped });
    }
  });
}
