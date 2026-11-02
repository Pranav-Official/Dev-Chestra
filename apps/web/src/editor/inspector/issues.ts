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
  // Polling probe rows show their own E_POLL_* issues.
  "/polling/",
];

/** True for validation issues that belong to the derived probe node. */
export function isProbeIssue(issue: Issue): boolean {
  if (issue.code === "E_POLL_PROBE") return true;
  const pointer = issue.pointer;
  return typeof pointer === "string" && pointer.includes("/polling/probe");
}

/** Probe issues for one start node (nodeId matches the start). */
export function probeIssuesForStart(issues: readonly Issue[], startId: string): Issue[] {
  return issues.filter((issue) => issue.nodeId === startId && isProbeIssue(issue));
}

/** Start-node issues with probe issues removed (probe badge owns those). */
export function nonProbeIssuesForStart(issues: readonly Issue[], startId: string): Issue[] {
  return issues.filter((issue) => !(issue.nodeId === startId && isProbeIssue(issue)));
}

function isShownByAField(issue: Issue): boolean {
  // E_POLL_PROBE is shown at the top of the probe inspector form,
  // wherever its pointer lands.
  if (issue.code === "E_POLL_PROBE") return true;
  const pointer = issue.pointer;
  if (typeof pointer !== "string") return false;
  if (pointer.endsWith("/name") && !pointer.includes("/params/")) return true;
  return FIELD_PATHS.some((part) => pointer.includes(part));
}

/** Errors/warnings that have no dedicated field, e.g. E_PROMPT on the node. */
export function summaryIssues(issues: readonly Issue[], nodeId: string): Issue[] {
  return issuesForNode(issues, nodeId).filter((issue) => !isShownByAField(issue));
}
