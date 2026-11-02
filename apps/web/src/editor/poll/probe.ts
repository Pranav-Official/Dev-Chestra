import type { AgentCli, Issue, PollProbe } from "@devchestra/schema";
import { POLL_PROBE_ID } from "@devchestra/schema";
import { PROBE_NODE_SUFFIX, probeStartId } from "../canvas/nodes.js";
import {
  isProbeIssue as isProbeIssueFromIssues,
  nonProbeIssuesForStart as nonProbeFromIssues,
  probeIssuesForStart as probeIssuesFromIssues,
} from "../inspector/issues.js";

export { POLL_PROBE_ID };
export const PROBE_NAME_DEFAULT = "Poll probe";

/** Canvas id of the derived probe node for a start node. */
export function probeNodeId(startId: string): string {
  return `${startId}${PROBE_NODE_SUFFIX}`;
}

/** The start id when a selection/canvas id is a derived probe node. */
export function startIdForProbeNode(nodeId: string): string | null {
  return probeStartId(nodeId);
}

export function defaultShellProbe(): PollProbe {
  return { id: POLL_PROBE_ID, type: "shell", name: PROBE_NAME_DEFAULT, command: "" };
}

export function defaultAgentProbe(firstCli: AgentCli): PollProbe {
  return {
    id: POLL_PROBE_ID,
    type: "agent",
    name: PROBE_NAME_DEFAULT,
    cli: firstCli,
    prompt: "",
    permissions: { network: true, write: [], shell: true },
  };
}

/** True for validation issues that belong to the probe, not the start node itself. */
export function isProbeIssue(issue: Issue): boolean {
  return isProbeIssueFromIssues(issue);
}

/** Probe issues for one start node (nodeId matches the start). */
export function probeIssuesForStart(issues: readonly Issue[], startId: string): Issue[] {
  return probeIssuesFromIssues(issues, startId);
}

/** Start-node issues with probe issues removed. */
export function nonProbeIssuesForStart(issues: readonly Issue[], startId: string): Issue[] {
  return nonProbeFromIssues(issues, startId);
}
