import type {
  AgentCli,
  Issue,
  RequiresSummary,
  ValidationReport,
  WorkflowFile,
} from "@relay/schema";
import { PROD_CLIS, parseWorkflowDraft } from "@relay/schema";
import { relativeWorkflowFileSchema } from "./dto.js";
import {
  cursorQuerySchema,
  epochMsSchema,
  etagSchema,
  jsonObjectSchema,
  limitQuerySchema,
  workflowFileIdSchema,
} from "./primitives.js";
import { type RunWorkspaceSelection, runWorkspaceSelectionSchema } from "./workspace-dto.js";
import { z } from "./zod.js";

const strict = z.strictObject;

// ---------------------------------------------------------------------------
// Workflows (managed files)
// ---------------------------------------------------------------------------

// Structural allow-list: fake parses everywhere so browser DTO validation can
// display it with a warning. Run-time layers (CLI startup/run gates, adapter
// registry) enforce the RELAY_ALLOW_FAKE=1 test-only requirement.
export const agentCliSchema = z.enum([...PROD_CLIS, "fake"]);

export const workflowBudgetSchema = strict({
  maxUsd: z.number().optional(),
  maxTokens: z.number().optional(),
  maxActiveMinutes: z.number().optional(),
});

export const workflowIssueSchema = strict({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1),
  message: z.string(),
  pointer: z.string().optional(),
  nodeId: z.string().optional(),
}) as unknown as z.ZodType<Issue>;

export const requiresSummarySchema = strict({
  clis: z.array(agentCliSchema) as unknown as z.ZodType<AgentCli[]>,
  networkNodes: z.array(strict({ nodeId: z.string(), name: z.string() })),
  shellCommands: z.array(
    strict({ nodeId: z.string(), command: z.string(), rawSubstitution: z.boolean() }),
  ),
  projectWriteNodes: z.array(strict({ nodeId: z.string(), name: z.string() })),
  worktreeNodes: z.array(z.string()),
  providers: z.array(z.string()),
  envVars: z.array(z.string()),
  irreversibleApprovals: z.array(z.string()),
  budget: workflowBudgetSchema,
}) as unknown as z.ZodType<RequiresSummary>;

export const validationReportSchema = strict({
  ok: z.boolean(),
  errors: z.array(workflowIssueSchema),
  warnings: z.array(workflowIssueSchema),
  requires: requiresSummarySchema,
}) as unknown as z.ZodType<ValidationReport>;

/**
 * A structurally valid draft: unknown fields are rejected by the schema
 * package's strict parser, but the graph may be incomplete (no start/end/edges).
 * Semantic validity and execution readiness are checked by `validateWorkflow`.
 */
export const workflowDraftSchema = z.unknown().superRefine((value, ctx) => {
  const parsed = parseWorkflowDraft(value);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error.message });
}) as unknown as z.ZodType<WorkflowFile>;

export const workflowTemplateSchema = z.enum(["blank", "linear", "linear-fake"]);
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

export interface CreateWorkflowRequest {
  name: string;
  id?: string;
  template?: WorkflowTemplate;
}

export const createWorkflowRequestSchema = strict({
  name: z.string().trim().min(1).max(200),
  id: workflowFileIdSchema.optional(),
  template: workflowTemplateSchema.optional(),
}) as unknown as z.ZodType<CreateWorkflowRequest>;

export interface SaveWorkflowRequest {
  workflow: WorkflowFile;
}

export const saveWorkflowRequestSchema = strict({
  workflow: workflowDraftSchema,
}) as unknown as z.ZodType<SaveWorkflowRequest>;

export interface ValidateWorkflowRequest {
  workflow: WorkflowFile;
}

export const validateWorkflowRequestSchema = strict({
  workflow: workflowDraftSchema,
}) as unknown as z.ZodType<ValidateWorkflowRequest>;

export interface ValidateWorkflowResponse {
  validation: ValidationReport;
}

export const validateWorkflowResponseSchema = strict({
  validation: validationReportSchema,
}) as unknown as z.ZodType<ValidateWorkflowResponse>;

export interface WorkflowDocumentResponse {
  workflow: WorkflowFile;
  /** Exact saved file text (for diffing and the editor buffer). */
  text: string;
  /** Unquoted strong validator; the HTTP header carries it quoted. */
  etag: string;
  relativeFile: string;
  validation: ValidationReport;
}

export const workflowDocumentResponseSchema = strict({
  workflow: workflowDraftSchema,
  text: z.string(),
  etag: etagSchema,
  relativeFile: relativeWorkflowFileSchema,
  validation: validationReportSchema,
}) as unknown as z.ZodType<WorkflowDocumentResponse>;

export interface WorkflowValidationSummary {
  ok: boolean;
  errors: number;
  warnings: number;
}

export const workflowValidationSummarySchema = strict({
  ok: z.boolean(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
}) as unknown as z.ZodType<WorkflowValidationSummary>;

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  relativeFile: string;
  etag: string;
  updatedAt: number;
  validationSummary?: WorkflowValidationSummary;
}

export const workflowListItemSchema = strict({
  id: workflowFileIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  relativeFile: relativeWorkflowFileSchema,
  etag: etagSchema,
  updatedAt: epochMsSchema,
  validationSummary: workflowValidationSummarySchema.optional(),
}) as unknown as z.ZodType<WorkflowListItem>;

export interface WorkflowListResponse {
  items: WorkflowListItem[];
  nextCursor: string | null;
}

export const workflowListResponseSchema = strict({
  items: z.array(workflowListItemSchema),
  nextCursor: z.string().nullable(),
}) as unknown as z.ZodType<WorkflowListResponse>;

export const workflowListQuerySchema = strict({
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
});

export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;

/**
 * Bounded run-from-saved-revision request. `etag` is the exact revision the
 * editor read; the server checks it atomically against the file it snapshots.
 * No workflow-controlled script or provider opt-in is accepted.
 */
export interface StartWorkflowRunRequest {
  params?: Record<string, import("@relay/core").JsonValue>;
  etag: string;
  /** Run-level workspace; omitted means the registered project root. */
  workspace?: RunWorkspaceSelection;
}

export const startWorkflowRunRequestSchema = strict({
  params: jsonObjectSchema.optional(),
  etag: etagSchema,
  workspace: runWorkspaceSelectionSchema.optional(),
}) as unknown as z.ZodType<StartWorkflowRunRequest>;
