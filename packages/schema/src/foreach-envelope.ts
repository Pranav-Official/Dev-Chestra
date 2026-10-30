import type { JsonSchemaObject } from "./types.js";

/**
 * Envelope published to the parent scope:
 * { total, processed, succeeded, failed, rejected, resultsRef }.
 * `resultsRef` points at the durable per-item table (engine store),
 * never a hydrated array. Separate module so join.ts and discovery.ts
 * can share it without a cycle.
 */
export function foreachEnvelopeSchema(perItem: JsonSchemaObject): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      total: { type: "integer", minimum: 0 },
      processed: { type: "integer", minimum: 0 },
      succeeded: { type: "integer", minimum: 0 },
      failed: { type: "integer", minimum: 0 },
      rejected: { type: "integer", minimum: 0 },
      resultsRef: { type: "string" },
      // Honest per-item shape for pickers; runtime stores rows separately.
      perItem: structuredClone(perItem),
    },
    required: ["total", "processed", "succeeded", "failed", "rejected", "resultsRef"],
    additionalProperties: false,
  };
}
