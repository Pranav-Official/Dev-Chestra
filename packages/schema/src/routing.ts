import { MAX_GATE_BRANCHES } from "./gate.js";
import { HANDLE_ID_PATTERN } from "./ids.js";
import type { Issue, WorkflowNode } from "./types.js";

function issue(code: string, message: string, pointer: string, nodeId?: string): Issue {
  return {
    severity: "error",
    code,
    message,
    pointer,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

export function validateGate(node: WorkflowNode, pointer: string): Issue[] {
  if (node.type !== "gate") return [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  let otherwise = 0;
  node.branches.forEach((branch, index) => {
    const at = `${pointer}/branches/${index}`;
    if (typeof branch.id !== "string" || !HANDLE_ID_PATTERN.test(branch.id)) {
      issues.push(
        issue(
          "E_GATE_BRANCH_ID",
          `Gate '${node.id}' branch id '${String(branch.id)}' must match ${HANDLE_ID_PATTERN.source}.`,
          `${at}/id`,
          node.id,
        ),
      );
    } else if (seen.has(branch.id)) {
      issues.push(
        issue(
          "E_GATE_BRANCH_DUPLICATE",
          `Gate '${node.id}' has duplicate branch id '${branch.id}'.`,
          `${at}/id`,
          node.id,
        ),
      );
    }
    seen.add(branch.id);
    if (branch.otherwise === true) {
      otherwise += 1;
      if (index !== node.branches.length - 1) {
        issues.push(
          issue(
            "E_GATE_OTHERWISE",
            `Gate '${node.id}' otherwise branch must be last.`,
            at,
            node.id,
          ),
        );
      }
      if (branch.when !== undefined) {
        issues.push(
          issue(
            "E_GATE_OTHERWISE",
            `Gate '${node.id}' otherwise branch cannot also declare when.`,
            at,
            node.id,
          ),
        );
      }
    } else {
      if (typeof branch.when !== "string" || branch.when.trim() === "") {
        issues.push(
          issue(
            "E_GATE_WHEN",
            `Gate '${node.id}' branch '${branch.id}' must declare a when expression or be the otherwise branch.`,
            at,
            node.id,
          ),
        );
      }
      if (branch.otherwise !== undefined) {
        issues.push(
          issue(
            "E_GATE_OTHERWISE",
            `Gate '${node.id}' branch otherwise must be true when used.`,
            `${at}/otherwise`,
            node.id,
          ),
        );
      }
    }
  });
  if (otherwise !== 1) {
    issues.push(
      issue(
        "E_GATE_OTHERWISE",
        `Gate '${node.id}' must have exactly one otherwise branch (found ${otherwise}).`,
        pointer,
        node.id,
      ),
    );
  }
  if (node.branches.length === 0) {
    issues.push(
      issue(
        "E_GATE_BRANCHES",
        `Gate '${node.id}' must declare at least one branch.`,
        pointer,
        node.id,
      ),
    );
  } else if (node.branches.length > MAX_GATE_BRANCHES) {
    issues.push(
      issue(
        "E_GATE_BRANCHES",
        `Gate '${node.id}' declares ${node.branches.length} branches; the maximum is ${MAX_GATE_BRANCHES}.`,
        pointer,
        node.id,
      ),
    );
  }
  return issues;
}

export function validateJoin(
  node: WorkflowNode,
  pointer: string,
): { issues: Issue[]; inputs: Set<string> } {
  if (node.type !== "join") return { issues: [], inputs: new Set() };
  const issues: Issue[] = [];
  const inputs = new Set<string>();
  if (node.mode !== "first" && node.mode !== "all") {
    issues.push(
      issue(
        "E_JOIN_MODE",
        `Join '${node.id}' mode must be 'first' or 'all'.`,
        `${pointer}/mode`,
        node.id,
      ),
    );
  }
  if (node.inputs.length === 0) {
    issues.push(
      issue(
        "E_JOIN_INPUTS",
        `Join '${node.id}' must declare at least one input.`,
        pointer,
        node.id,
      ),
    );
  }
  node.inputs.forEach((input, index) => {
    if (typeof input !== "string" || !HANDLE_ID_PATTERN.test(input)) {
      issues.push(
        issue(
          "E_JOIN_INPUT_NAME",
          `Join '${node.id}' input '${String(input)}' must match ${HANDLE_ID_PATTERN.source}.`,
          `${pointer}/inputs/${index}`,
          node.id,
        ),
      );
    } else if (inputs.has(input)) {
      issues.push(
        issue(
          "E_JOIN_INPUT_DUPLICATE",
          `Join '${node.id}' has duplicate input '${input}'.`,
          `${pointer}/inputs/${index}`,
          node.id,
        ),
      );
    }
    inputs.add(input);
  });
  return { issues, inputs };
}
