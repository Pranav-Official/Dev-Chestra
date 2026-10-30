import { LOOP_OUTCOMES } from "@devchestra/core";
import { type JsonSchemaObject, LOOP_MAX_ITERATIONS, LOOP_MIN_ITERATIONS } from "./types.js";

/**
 * Envelope published to the parent scope: { result, iterations, outcome }.
 * `outcome` is `condition_met` or, when the loop's `.exhausted` output is wired,
 * `iteration_limit`. Separate module so join.ts and loop.ts can share it
 * without a cycle.
 */
export function loopEnvelopeSchema(output: JsonSchemaObject): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      result: structuredClone(output),
      iterations: { type: "integer", minimum: LOOP_MIN_ITERATIONS, maximum: LOOP_MAX_ITERATIONS },
      outcome: { type: "string", enum: [...LOOP_OUTCOMES] },
    },
    required: ["iterations", "outcome", "result"],
    additionalProperties: false,
  };
}
