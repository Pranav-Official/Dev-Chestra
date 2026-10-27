import type { RelayError } from "@relay/core";
import { compileTemplate } from "./template.js";
import type { ApprovalNode, Issue } from "./types.js";
import { issue } from "./validate-support.js";

export function validateApproval(
  node: ApprovalNode,
  pointer: string,
  allowed: Set<string>,
  addError: (i: Issue) => void,
  addRelay: (e: RelayError, p: string, n?: string) => void,
): void {
  if (typeof node.message !== "string" || node.message.trim() === "") {
    addError(
      issue(
        "error",
        "E_APPROVAL_MESSAGE",
        "Approval message must be a non-empty string (max 4096).",
        `${pointer}/message`,
        node.id,
      ),
    );
  } else if (node.message.length > 4096) {
    addError(
      issue(
        "error",
        "E_APPROVAL_MESSAGE",
        "Approval message must be at most 4096 characters.",
        `${pointer}/message`,
        node.id,
      ),
    );
  } else {
    const c = compileTemplate(node.message, { shell: false });
    if (!c.ok) addRelay(c.error, `${pointer}/message`, node.id);
    else
      for (const p of c.value.parts)
        if (p.kind === "expression")
          for (const r of p.compiled.roots)
            if (!allowed.has(r))
              addError(
                issue(
                  "error",
                  "E_EXPR_SCOPE",
                  `Expression root '${r}' is not in scope. Allowed: ${[...allowed].sort().join(", ") || "(none)"}. Expression: message: {{ ${p.source} }}`,
                  `${pointer}/message`,
                  node.id,
                ),
              );
  }
  if (node.criteria !== undefined) {
    if (!Array.isArray(node.criteria))
      addError(
        issue(
          "error",
          "E_APPROVAL_CRITERIA",
          "Approval criteria must be an array of strings.",
          `${pointer}/criteria`,
          node.id,
        ),
      );
    else {
      if (node.criteria.length > 32)
        addError(
          issue(
            "error",
            "E_APPROVAL_CRITERIA",
            "Approval criteria must have at most 32 entries.",
            `${pointer}/criteria`,
            node.id,
          ),
        );
      for (let i = 0; i < node.criteria.length; i++) {
        const e = node.criteria[i];
        if (typeof e !== "string" || e.trim() === "" || e.length > 256)
          addError(
            issue(
              "error",
              "E_APPROVAL_CRITERIA",
              "Approval criteria entries must be non-empty strings (max 256).",
              `${pointer}/criteria/${i}`,
              node.id,
            ),
          );
      }
    }
  }
  if (typeof node.irreversible !== "boolean")
    addError(
      issue(
        "error",
        "E_APPROVAL_IRREVERSIBLE",
        "Approval irreversible must be a boolean.",
        `${pointer}/irreversible`,
        node.id,
      ),
    );
}
