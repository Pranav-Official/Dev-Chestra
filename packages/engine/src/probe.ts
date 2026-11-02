import { DevChestraError } from "@devchestra/core";
import {
  buildPollAgentOutputSchema,
  buildPollPromptPreamble,
  type NormalizedStartNode,
  type NormalizedWorkflow,
  type PollProbe,
} from "@devchestra/schema";

/** Node id of the probe step inside a synthesized probe snapshot. */
export const POLL_PROBE_NODE_ID = "probe";

/**
 * Finds the start node of an armed snapshot. The probe result is validated
 * against its params, so a snapshot without one cannot be probed.
 */
export function probeStartNode(snapshot: NormalizedWorkflow): NormalizedStartNode {
  const start = snapshot.graph.nodes.find((node) => node.type === "start");
  if (start === undefined || start.type !== "start") {
    throw new DevChestraError("E_WORKFLOW_INVALID", "Probe snapshot has no start node");
  }
  return start;
}

/**
 * Synthesizes a start -> probe -> end snapshot from the armed start node and
 * its polling probe. The probe runs as an ordinary node: a shell probe fails
 * the run on a non-zero exit, and an agent probe submits the generated output
 * schema. The end result stays empty; callers read the probe node's output.
 */
export function buildProbeSnapshot(
  workflowId: string,
  start: NormalizedStartNode,
  probe: PollProbe,
  timeoutMin: number,
): NormalizedWorkflow {
  const startNode: NormalizedStartNode = {
    id: "start",
    type: "start",
    name: "Start",
    supervise: "default",
    env: [],
    params: [],
  };
  const probeNode =
    probe.type === "shell"
      ? {
          id: POLL_PROBE_NODE_ID,
          type: "shell" as const,
          name: "Poll probe",
          supervise: "default" as const,
          env: [],
          command: probe.command,
          workspace: { mode: "scratch" as const },
          timeoutMin,
          allowFailure: false,
        }
      : {
          id: POLL_PROBE_NODE_ID,
          type: "agent" as const,
          name: "Poll probe",
          supervise: "default" as const,
          env: [],
          cli: probe.cli,
          ...(probe.model === undefined ? {} : { model: probe.model }),
          prompt: `${buildPollPromptPreamble(start)}\n\n${probe.prompt}`,
          output: buildPollAgentOutputSchema(start),
          // Read-only: network reads are allowed, but no workspace or project
          // writes, and no shell beyond what read-only implies.
          permissions: { network: true, write: [] as ("workspace" | "project")[] },
          workspace: { mode: "scratch" as const },
          limits: { timeoutMin, validationRetries: 2, crashRetries: 1 },
          context: { project: "none" as const, workflow: "none" as const },
        };
  return {
    schemaVersion: 1,
    id: workflowId,
    name: `Poll probe for ${workflowId}`,
    graph: {
      nodes: [
        startNode,
        probeNode,
        {
          id: "end",
          type: "end",
          name: "End",
          supervise: "default",
          env: [],
          status: "success",
          result: "{}",
        },
      ],
      edges: [
        { id: "e1", from: "start", to: POLL_PROBE_NODE_ID },
        { id: "e2", from: POLL_PROBE_NODE_ID, to: "end" },
      ],
    },
  };
}
