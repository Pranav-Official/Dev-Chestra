import {
  type GateDecision,
  type GateNode,
  HANDLE_ID_PATTERN,
  MAX_GATE_BRANCHES,
  NODE_ID_PATTERN,
} from "@relay/schema";
import { coreErrorCodeSchema } from "./errors.js";
import { gateDecisionEntrySchema } from "./events.js";
import { jsonObjectSchema } from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const MAX_GATE_TEST_BRANCHES = MAX_GATE_BRANCHES;
/** Serialized scope cap; the HTTP body cap is 64 KiB. */
export const MAX_GATE_TEST_SCOPE_BYTES = 32 * 1024;

const gateBranchSchema = strict({
  id: z.string().regex(HANDLE_ID_PATTERN, "Branch id is invalid"),
  when: z.string().min(1).optional(),
  otherwise: z.literal(true).optional(),
});

const gateNodeSchema = strict({
  id: z.string().regex(NODE_ID_PATTERN, "Gate node id is invalid"),
  type: z.literal("gate"),
  name: z.string().min(1).max(200),
  ui: z.record(z.string(), z.unknown()).optional(),
  supervise: z.enum(["default", "checkpoint", "notify", "skip"]).optional(),
  env: z.array(z.string()).optional(),
  branches: z.array(gateBranchSchema).min(1).max(MAX_GATE_TEST_BRANCHES),
}).superRefine((gate, ctx) => {
  const seen = new Set<string>();
  let otherwise = 0;
  gate.branches.forEach((branch, index) => {
    if (seen.has(branch.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["branches", index, "id"],
        message: `Duplicate branch id '${branch.id}'.`,
      });
    }
    seen.add(branch.id);
    if (branch.otherwise === true) {
      otherwise += 1;
      if (index !== gate.branches.length - 1) {
        ctx.addIssue({
          code: "custom",
          path: ["branches", index],
          message: "The otherwise branch must be last.",
        });
      }
    } else if (branch.when === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["branches", index],
        message: "Every non-otherwise branch needs a when expression.",
      });
    }
    if (branch.otherwise === true && branch.when !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["branches", index],
        message: "A branch cannot be both otherwise and conditional.",
      });
    }
  });
  if (otherwise !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["branches"],
      message: "Exactly one otherwise branch is required.",
    });
  }
});

function scopeBytes(value: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const boundedScopeSchema = jsonObjectSchema.superRefine((scope, ctx) => {
  if (scopeBytes(scope) > MAX_GATE_TEST_SCOPE_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `Scope exceeds ${MAX_GATE_TEST_SCOPE_BYTES} bytes when serialized.`,
    });
  }
});

export interface GateTestRequest {
  gate: GateNode;
  scope: Record<string, unknown>;
}

export const gateTestRequestSchema = strict({
  gate: gateNodeSchema,
  scope: boundedScopeSchema,
}) as unknown as z.ZodType<GateTestRequest>;

/** Preview result is exactly the shared schema GateDecision. */
export type GateTestResult = GateDecision;

export const gateTestResultSchema = strict({
  branch: z.string().nullable(),
  evaluated: z.array(gateDecisionEntrySchema),
  error: strict({
    code: coreErrorCodeSchema,
    message: z.string().min(1),
  }).optional(),
}) as unknown as z.ZodType<GateTestResult>;
