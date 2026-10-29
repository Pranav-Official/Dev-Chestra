import { type JsonSchemaObject, LOOP_MAX_ITERATIONS, LOOP_MIN_ITERATIONS } from "./types.js";

/**
 * Envelope published to the parent scope: { result, iterations }.
 * Separate module so join.ts and loop.ts can share it without a cycle.
 */
export function loopEnvelopeSchema(output: JsonSchemaObject): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      result: structuredClone(output),
      iterations: { type: "integer", minimum: LOOP_MIN_ITERATIONS, maximum: LOOP_MAX_ITERATIONS },
    },
    required: ["iterations", "result"],
    additionalProperties: false,
  };
}
