import {
  DECISION_PROVIDER_LABELS,
  DECISION_PROVIDERS,
  type DecisionProviderId,
} from "@devchestra/schema";
import { decisionOutputSchema, decisionRoutingSchema } from "./events.js";
import { z } from "./zod.js";

const strict = z.strictObject;

// ---------------------------------------------------------------------------
// Decision providers (GET /api/decision-providers)
// ---------------------------------------------------------------------------

/** One fixed provider preset; readiness exposes missing secret NAMES only. */
export interface DecisionProviderView {
  id: DecisionProviderId;
  label: string;
  ready: boolean;
  missing: string[];
}

export const decisionProviderSchema = strict({
  id: z.enum(DECISION_PROVIDERS),
  label: z.string(),
  ready: z.boolean(),
  missing: z.array(z.string()),
}) as unknown as z.ZodType<DecisionProviderView>;

export type DecisionProvidersResponse = DecisionProviderView[];

export const decisionProvidersResponseSchema = z.array(
  decisionProviderSchema,
) as unknown as z.ZodType<DecisionProvidersResponse>;

/** Labels keyed by provider id; kept here so the mapping is declared once. */
export const DECISION_PROVIDER_LABELS_DTO: Record<DecisionProviderId, string> =
  DECISION_PROVIDER_LABELS;

// ---------------------------------------------------------------------------
// Decision test (POST /api/projects/:pid/decisions/test)
// ---------------------------------------------------------------------------

/** Serialized state cap; the HTTP body cap is 64 KiB. */
export const MAX_DECISION_TEST_STATE_BYTES = 64 * 1024;

const decisionTestModeSchema = z.discriminatedUnion("kind", [
  strict({
    kind: z.literal("boolean"),
    trueAt: z.number().optional(),
    falseAt: z.number().optional(),
  }),
  strict({
    kind: z.literal("choice"),
    options: z.array(strict({ value: z.string(), description: z.string().optional() })),
    branches: z.array(strict({ id: z.string(), values: z.array(z.string()) })),
    minConfidence: z.number().optional(),
  }),
  strict({
    kind: z.literal("score"),
    levels: z.array(strict({ label: z.string(), description: z.string().optional() })),
    bands: z.array(strict({ id: z.string(), atLeast: z.union([z.number(), z.null()]) })),
    minConfidence: z.number().optional(),
  }),
]);

function stateBytes(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface DecisionTestRequest {
  provider: DecisionProviderId;
  model?: string;
  state: string;
  instructions: string;
  mode: z.infer<typeof decisionTestModeSchema>;
}

export const decisionTestRequestSchema = strict({
  provider: z.enum(DECISION_PROVIDERS),
  model: z.string().optional(),
  state: z.string().min(1),
  instructions: z.string().min(1).max(4000),
  mode: decisionTestModeSchema,
}).superRefine((body, ctx) => {
  if (stateBytes(body.state) > MAX_DECISION_TEST_STATE_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["state"],
      message: `State exceeds ${MAX_DECISION_TEST_STATE_BYTES} bytes when serialized.`,
    });
  }
}) as unknown as z.ZodType<DecisionTestRequest>;

export interface DecisionTestResult {
  output: z.infer<typeof decisionOutputSchema>;
  routing: z.infer<typeof decisionRoutingSchema>;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export const decisionTestResultSchema = strict({
  output: decisionOutputSchema,
  routing: decisionRoutingSchema,
  latencyMs: z.number().nonnegative(),
  usage: strict({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).optional(),
}) as unknown as z.ZodType<DecisionTestResult>;
