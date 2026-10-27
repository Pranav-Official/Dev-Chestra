import type { AgentCli, RequiresSummary, WorkflowBudget, WorkflowNode } from "./types.js";

function byNodeId<T extends { nodeId: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function buildRequires(
  nodes: readonly WorkflowNode[],
  budget?: WorkflowBudget,
): RequiresSummary {
  const clis = new Set<AgentCli>();
  const envVars = new Set<string>();
  const networkNodes: { nodeId: string; name: string }[] = [];
  const shellCommands: { nodeId: string; command: string; rawSubstitution: boolean }[] = [];
  const projectWriteNodes: { nodeId: string; name: string }[] = [];
  const worktreeNodes: string[] = [];

  const irreversibleApprovals: string[] = [];
  for (const node of nodes) {
    for (const name of node.env ?? []) envVars.add(name);
    if (node.type === "approval" && (node as { irreversible?: boolean }).irreversible === true) {
      irreversibleApprovals.push(node.id);
    }
    if (node.type === "agent") {
      clis.add(node.cli);
      if (node.permissions.network) {
        networkNodes.push({ nodeId: node.id, name: node.name });
      }
      if (node.workspace?.mode === "project" && node.workspace.access === "write") {
        projectWriteNodes.push({ nodeId: node.id, name: node.name });
      }
      if (node.workspace?.mode === "worktree") worktreeNodes.push(node.id);
    } else if (node.type === "shell") {
      if (node.workspace?.mode === "worktree") worktreeNodes.push(node.id);
      shellCommands.push({
        nodeId: node.id,
        command: node.command,
        rawSubstitution: node.command.includes("{{{"),
      });
    }
  }

  return {
    clis: [...clis].sort(),
    networkNodes: byNodeId(networkNodes),
    shellCommands: byNodeId(shellCommands),
    projectWriteNodes: byNodeId(projectWriteNodes),
    worktreeNodes: worktreeNodes.sort(),
    providers: [],
    envVars: [...envVars].sort(),
    irreversibleApprovals: irreversibleApprovals.sort(),
    budget: budget === undefined ? {} : { ...budget },
  };
}
