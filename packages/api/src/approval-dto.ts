import {
  cursorQuerySchema,
  epochMsSchema,
  limitQuerySchema,
  nonEmptyPathSchema,
  pathSchema,
  runIdSchema,
} from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const approvalDecisionSchema = z.enum(["approve", "reject"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalStatusSchema = z.enum([
  "waiting_approval",
  "succeeded",
  "rejected",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Human approval summary as projected from executions + last requested event. */
export interface ApprovalSummary {
  runId: string;
  path: string;
  nodeId: string;
  projectId: string;
  runNumber: number;
  status: ApprovalStatus;
  message: string;
  criteria: string[] | null;
  irreversible: boolean;
  requestedAt: number;
  attempt: number;
  generation: number;
  /** Server-issued fence identity for stale-tab safe resolve (store stable requestId). */
  requestId: string;
  expectedAttempt: number;
  expectedGeneration: number;
  requestEventId: number;
}

export const approvalSummarySchema = strict({
  runId: runIdSchema,
  path: pathSchema,
  nodeId: z.string().min(1),
  projectId: z.string().min(1),
  runNumber: z.number().int().positive(),
  status: approvalStatusSchema,
  message: z.string(),
  criteria: z.array(z.string()).nullable(),
  irreversible: z.boolean(),
  requestedAt: epochMsSchema,
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  requestId: z.string().min(1),
  expectedAttempt: z.number().int().positive(),
  expectedGeneration: z.number().int().positive(),
  requestEventId: z.number().int().nonnegative(),
}) as unknown as z.ZodType<ApprovalSummary>;

export interface ApprovalListResponse {
  items: ApprovalSummary[];
  nextCursor: string | null;
}

export const approvalListResponseSchema = strict({
  items: z.array(approvalSummarySchema),
  nextCursor: z.string().nullable(),
}) as unknown as z.ZodType<ApprovalListResponse>;

export const approvalListQuerySchema = strict({
  project: z.string().min(1).max(128).optional(),
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

export const approvalDetailResponseSchema = strict({
  approval: approvalSummarySchema,
  execution: z.unknown(),
  requestedEvent: z.unknown(),
  resolvedEvent: z.unknown().nullable().optional(),
}) as unknown as z.ZodType<{
  approval: ApprovalSummary;
  execution: unknown;
  requestedEvent: unknown;
  resolvedEvent?: unknown | null;
}>;

export const approvalResolveRequestSchema = strict({
  requestId: z.string().min(1).max(200),
  decision: approvalDecisionSchema,
  note: z.string().max(4096).optional(),
  expectedAttempt: z.number().int().positive(),
  expectedGeneration: z.number().int().positive(),
});
export type ApprovalResolveRequest = z.infer<typeof approvalResolveRequestSchema>;

export interface ApprovalResolveResponse {
  runId: string;
  path: string;
  decision: ApprovalDecision;
  note: string | null;
  by: string;
  duplicate: boolean;
  status: string;
  eventId: number;
}

export const approvalResolveResponseSchema = strict({
  runId: runIdSchema,
  path: nonEmptyPathSchema,
  decision: approvalDecisionSchema,
  note: z.string().nullable(),
  by: z.string().min(1),
  duplicate: z.boolean(),
  status: z.string(),
  eventId: z.number().int().nonnegative(),
}) as unknown as z.ZodType<ApprovalResolveResponse>;
