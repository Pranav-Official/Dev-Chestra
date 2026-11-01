import type { Issue } from "@devchestra/schema";

export function issuesForNode(issues: readonly Issue[], nodeId: string): Issue[] {
  return issues.filter((issue) => issue.nodeId === nodeId);
}

function endsWithPointer(issue: Issue, suffix: string): boolean {
  const pointer = issue.pointer;
  if (typeof pointer !== "string") return false;
  return pointer === suffix || pointer.endsWith(suffix);
}

export function nodeNameIssue(issues: readonly Issue[]): string | null {
  const found = issues.filter(
    (issue) =>
      issue.severity === "error" &&
      typeof issue.pointer === "string" &&
      issue.pointer.endsWith("/name") &&
      !issue.pointer.includes("/params/") &&
      !issue.pointer.includes("/properties/"),
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

export function fieldIssue(issues: readonly Issue[], suffix: string): string | null {
  const found = issues.filter(
    (issue) => issue.severity === "error" && endsWithPointer(issue, suffix),
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

export function fieldWarning(issues: readonly Issue[], suffix: string): string | null {
  const found = issues.filter(
    (issue) => issue.severity === "warning" && endsWithPointer(issue, suffix),
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

export function containingIssue(issues: readonly Issue[], segment: string): string | null {
  const found = issues.filter(
    (issue) =>
      issue.severity === "error" &&
      typeof issue.pointer === "string" &&
      issue.pointer.includes(segment),
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

const FIELD_PATHS = [
  "/params/",
  "/prompt",
  "/promptFile",
  "/output",
  "/permissions",
  "/limits",
  "/branches",
  "/inputs",
  "/mode",
  "/command",
  "/timeoutMin",
  "/allowFailure",
  "/status",
  "/result",
  "/cli",
  "/model",
  "/provider",
  "/state",
  "/instructions",
  "/options",
  "/bands",
  "/levels",
  "/onError",
  "/minConfidence",
  "/trueAt",
  "/falseAt",
  "/maxIterations",
  "/initialState",
  "/nextState",
  "/until",
  "/body",
  // Webhook mapping rows show their own E_WEBHOOK_* issues.
  "/webhook/paramMapping/",
];

function isShownByAField(issue: Issue): boolean {
  const pointer = issue.pointer;
  if (typeof pointer !== "string") return false;
  if (pointer.endsWith("/name") && !pointer.includes("/params/")) return true;
  return FIELD_PATHS.some((part) => pointer.includes(part));
}

/** Errors/warnings that have no dedicated field, e.g. E_PROMPT on the node. */
export function summaryIssues(issues: readonly Issue[], nodeId: string): Issue[] {
  return issuesForNode(issues, nodeId).filter((issue) => !isShownByAField(issue));
}
