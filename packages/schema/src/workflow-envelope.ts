import type { JsonSchemaObject } from "./types.js";

/**
 * Envelope published under a `workflow` (child-workflow) node id:
 * { childRunId, status, result }. `result` is the child's successful result
 * (or null when failed/rejected); per-item typing comes from the optional
 * node.output schema. No hydration: child rows stay in the run store.
 */
export function workflowEnvelopeSchema(childResult: JsonSchemaObject | null): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      childRunId: { type: "string" },
      status: { type: "string", enum: ["succeeded", "failed", "rejected"] },
      result: childResult === null ? {} : structuredClone(childResult),
    },
    required: ["childRunId", "status", "result"],
    additionalProperties: false,
  };
}
