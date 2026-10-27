import type { GlobalStreamMessage } from "@relay/api";

export type HintQueryKey = readonly [string, ...string[]];

/** Global hints are invalidations only; they are never reducer input. */
export function hintInvalidations(message: GlobalStreamMessage): HintQueryKey[] {
  switch (message.event) {
    case "run.status":
      return [["runs"], ["execution", message.data.runId], ["bootstrap"], ["approvals"]];
    case "inbox":
      return [["bootstrap"], ["approvals"]];
    case "provider":
    case "config":
      return [["bootstrap"]];
    case "notification":
      return message.data.runId === undefined ? [] : [["execution", message.data.runId]];
    default:
      return [];
  }
}

/** A hint stream is not durable, so reconnect refreshes derived server state. */
export const RECONNECT_INVALIDATIONS: HintQueryKey[] = [["bootstrap"], ["runs"], ["approvals"]];
