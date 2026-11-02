import type {
  ExecStatus,
  NodeKind,
  Path,
  RunId,
  RunPauseReason,
  RunStatus,
} from "@devchestra/core";
import type { NormalizedWorkflow } from "@devchestra/schema";
import { type ApiErrorCode, apiErrorCodeSchema } from "./errors.js";
import {
  cursorQuerySchema,
  epochMsSchema,
  execStatusSchema,
  jsonObjectSchema,
  jsonValueSchema,
  limitQuerySchema,
  nodeKindSchema,
  pathSchema,
  projectIdSchema,
  runIdSchema,
  runKindSchema,
  runPauseReasonSchema,
  runStatusSchema,
} from "./primitives.js";
import { normalizedWorkflowSchema, runViewSchema } from "./view.js";
import { type RunWorkspaceSelection, runWorkspaceSelectionSchema } from "./workspace-dto.js";
import { z } from "./zod.js";

const strict = z.strictObject;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  kind: "git" | "folder";
  missing: boolean;
  addedAt: number;
}

export const projectViewSchema = strict({
  id: z.string().min(1),
  name: z.string(),
  path: z.string().min(1),
  kind: z.enum(["git", "folder"]),
  missing: z.boolean(),
  addedAt: epochMsSchema,
}) as unknown as z.ZodType<ProjectView>;

/**
 * Registration is the only place an absolute filesystem path is accepted
 * (relink is the same explicit exception). Everything else uses project ids.
 */
export const registerProjectRequestSchema = strict({
  path: z.string().min(1).max(4096),
});

export const relinkProjectRequestSchema = strict({
  path: z.string().min(1).max(4096),
});

export type RegisterProjectRequest = z.infer<typeof registerProjectRequestSchema>;
export type RelinkProjectRequest = z.infer<typeof relinkProjectRequestSchema>;

export interface ListProjectsResponse {
  items: ProjectView[];
  nextCursor: string | null;
}

export const listProjectsResponseSchema = strict({
  items: z.array(projectViewSchema),
  nextCursor: z.string().nullable(),
}) as unknown as z.ZodType<ListProjectsResponse>;

export const listProjectsQuerySchema = strict({
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
});

export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// ---------------------------------------------------------------------------
// Health and bootstrap
// ---------------------------------------------------------------------------

export interface CliListItem {
  id: string;
  label: string;
  experimental: boolean;
  /** Provider switch from Settings. A turned-off provider is hidden from pickers and blocked at run start. */
  enabled: boolean;
}

export const cliListItemSchema = strict({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  experimental: z.boolean(),
  enabled: z.boolean(),
}) as unknown as z.ZodType<CliListItem>;

export interface CliListResponse {
  clis: CliListItem[];
}

export const cliListResponseSchema = strict({
  clis: z.array(cliListItemSchema).max(32),
}) as unknown as z.ZodType<CliListResponse>;

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
  instanceId: string;
  /** False when a readiness check fails; absent on older servers. */
  ready?: boolean;
  /** Per-check readiness; absent on older servers. */
  checks?: { store: "ok" | "error" };
}

export const healthResponseSchema = strict({
  ok: z.literal(true),
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  instanceId: z.string(),
  ready: z.boolean().optional(),
  checks: strict({ store: z.enum(["ok", "error"]) }).optional(),
}) as unknown as z.ZodType<HealthResponse>;

export interface CliProbeSummary {
  name: string;
  available: boolean;
  version: string | null;
  signedIn: boolean | null;
}

export const cliProbeSummarySchema = strict({
  name: z.string(),
  available: z.boolean(),
  version: z.string().nullable(),
  signedIn: z.boolean().nullable(),
}) as unknown as z.ZodType<CliProbeSummary>;

export interface BootstrapSettings {
  server: { port: number };
  defaults: { agentTimeoutMin: number; shellTimeoutMin: number };
}

export const bootstrapSettingsSchema = strict({
  server: strict({ port: z.number().int().min(1).max(65_535) }),
  defaults: strict({
    agentTimeoutMin: z.number().nonnegative(),
    shellTimeoutMin: z.number().nonnegative(),
  }),
}) as unknown as z.ZodType<BootstrapSettings>;

export interface BootstrapResponse {
  version: string;
  instanceId: string;
  projects: ProjectView[];
  counts: { runs: number; activeRuns: number; inbox: number };
  providers: string[];
  clis: CliProbeSummary[];
  settings: BootstrapSettings;
}

export const bootstrapResponseSchema = strict({
  version: z.string(),
  instanceId: z.string(),
  projects: z.array(projectViewSchema),
  counts: strict({
    runs: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative(),
    inbox: z.number().int().nonnegative(),
  }),
  providers: z.array(z.string()),
  clis: z.array(cliProbeSummarySchema),
  settings: bootstrapSettingsSchema,
}) as unknown as z.ZodType<BootstrapResponse>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunSummary {
  archivedAt?: number | null;
  id: RunId;
  projectId: string;
  projectName: string;
  workflowId: string;
  /** Normalized workflow name; null if it cannot be read from the snapshot. */
  workflowName: string | null;
  runNumber: number;
  kind: "run" | "node_test";
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pauseReason: RunPauseReason | null;
  costUsd: number;
  tokens: number;
  activeMs: number;
}

export const runSummarySchema = strict({
  archivedAt: epochMsSchema.nullable().optional(),
  id: runIdSchema,
  projectId: z.string().min(1),
  projectName: z.string(),
  workflowId: z.string().min(1),
  workflowName: z.string().nullable(),
  runNumber: z.number().int().positive(),
  kind: runKindSchema,
  status: runStatusSchema,
  createdAt: epochMsSchema,
  startedAt: epochMsSchema.nullable(),
  endedAt: epochMsSchema.nullable(),
  pauseReason: runPauseReasonSchema.nullable(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
}) as unknown as z.ZodType<RunSummary>;

export interface RunListResponse {
  items: RunSummary[];
  nextCursor: string | null;
}

export const runListResponseSchema = strict({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
}) as unknown as z.ZodType<RunListResponse>;

export const runListQuerySchema = strict({
  archived: z.enum(["true", "false"]).optional(),
  project: projectIdSchema.optional(),
  workflow: z.string().min(1).max(64).optional(),
  status: runStatusSchema.optional(),
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
});

export type RunListQuery = z.infer<typeof runListQuerySchema>;

/** Node coordinates captured from the immutable run snapshot's `ui` data. */
export const runLayoutSchema = z.record(
  z.string().min(1),
  strict({ x: z.number(), y: z.number() }),
);

export type RunLayout = z.infer<typeof runLayoutSchema>;

export interface RunDetailResponse {
  run: RunSummary;
  view: import("@devchestra/core").RunView;
  snapshot: NormalizedWorkflow;
  /** Last event id included in `view` (atomic capture). */
  watermark: number;
  /** Editor coordinates from the raw run snapshot; never the live file. */
  layout?: RunLayout;
  /**
   * Frozen run-level workspace selection. Null for legacy runs that used the
   * historical per-node workspace. The internal projectRoot is never exposed.
   */
  workspace: RunWorkspaceSelection | null;
}

export const runDetailResponseSchema = strict({
  run: runSummarySchema,
  view: runViewSchema,
  snapshot: normalizedWorkflowSchema,
  watermark: z.number().int().nonnegative(),
  layout: runLayoutSchema.optional(),
  workspace: runWorkspaceSelectionSchema.nullable(),
}) as unknown as z.ZodType<RunDetailResponse>;

export const relativeWorkflowFileSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/"), "workflowFile must be relative")
  .refine((value) => !/^[A-Za-z]:[\\/]/u.test(value), "workflowFile must not be a drive path")
  .refine((value) => !value.includes("\\"), "workflowFile must use '/' separators")
  .refine((value) => !value.includes("\0"), "workflowFile must not contain NUL")
  .refine(
    (value) =>
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "workflowFile must not contain empty, '.' or '..' segments",
  );

/**
 * Start request. Trusted CLI startup settings (fake script,
 * experimental adapters, provider overrides) are deliberately not accepted
 * over the browser API.
 */
export const startRunRequestSchema = strict({
  workflowFile: relativeWorkflowFileSchema,
  params: jsonObjectSchema.optional(),
  workspace: runWorkspaceSelectionSchema.optional(),
});

export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export interface StartRunResponse {
  runId: RunId;
  /** True when this request replayed an existing idempotent start. */
  duplicate: boolean;
  status: RunStatus;
}

export const startRunResponseSchema = strict({
  runId: runIdSchema,
  duplicate: z.boolean(),
  status: runStatusSchema,
}) as unknown as z.ZodType<StartRunResponse>;

export interface CommandResponse {
  runId: RunId;
  status: RunStatus;
}

export const commandResponseSchema = strict({
  runId: runIdSchema,
  status: runStatusSchema,
}) as unknown as z.ZodType<CommandResponse>;

// ---------------------------------------------------------------------------
// Execution detail
// ---------------------------------------------------------------------------

export interface ExecutionSummary {
  runId: RunId;
  path: Path;
  nodeId: string;
  status: ExecStatus;
  attempt: number;
  generation: number;
  kind: NodeKind | null;
  validationAttempts: number;
  validationLimit: number;
  crashAttempts: number;
  startedAt: number | null;
  endedAt: number | null;
  cli: string | null;
  sessionId: string | null;
  sessionCwd: string | null;
  model: string | null;
  outputId: string | null;
  errorCode: ApiErrorCode | null;
  errorMessage: string | null;
  branch: string | null;
  lastEventId: number;
}

export const executionSummarySchema = strict({
  runId: runIdSchema,
  path: pathSchema,
  nodeId: z.string(),
  status: execStatusSchema,
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  kind: nodeKindSchema.nullable(),
  validationAttempts: z.number().int().nonnegative(),
  validationLimit: z.number().int().nonnegative(),
  crashAttempts: z.number().int().nonnegative(),
  startedAt: epochMsSchema.nullable(),
  endedAt: epochMsSchema.nullable(),
  cli: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionCwd: z.string().nullable(),
  model: z.string().nullable(),
  outputId: z.string().nullable(),
  errorCode: apiErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  branch: z.string().nullable(),
  lastEventId: z.number().int().nonnegative(),
}) as unknown as z.ZodType<ExecutionSummary>;

export interface AttemptView {
  attempt: number;
  generation: number;
  mode: "fresh" | "resume";
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: "exited" | "killed" | "grace_timeout" | "crash" | null;
  exitCode: number | null;
  cli: string | null;
  model: string | null;
  sessionId: string | null;
}

export const attemptViewSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  mode: z.enum(["fresh", "resume"]),
  startedAt: epochMsSchema.nullable(),
  stoppedAt: epochMsSchema.nullable(),
  stopReason: z.enum(["exited", "killed", "grace_timeout", "crash"]).nullable(),
  exitCode: z.number().int().nullable(),
  cli: z.string().nullable(),
  model: z.string().nullable(),
  sessionId: z.string().nullable(),
}) as unknown as z.ZodType<AttemptView>;

export interface OutputPreview {
  id: string;
  hash: string;
  bytes: number;
  /** True when the value exceeded the inline preview cap (64 KiB). */
  truncated: boolean;
  data: import("@devchestra/core").JsonValue | null;
  contentType: "json";
}

export const outputPreviewSchema = strict({
  id: z.string(),
  hash: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  data: jsonValueSchema.nullable(),
  contentType: z.literal("json"),
}) as unknown as z.ZodType<OutputPreview>;

export interface ExecutionUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costSource: "reported" | "estimated" | "none";
}

export const executionUsageSchema = strict({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costSource: z.enum(["reported", "estimated", "none"]),
}) as unknown as z.ZodType<ExecutionUsage>;

export interface ProcessView {
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
  startedAt: number;
  stoppedAt: number | null;
  stopReason: "exited" | "killed" | "grace_timeout" | "crash" | null;
  exitCode: number | null;
}

export const processViewSchema = strict({
  pid: z.number().int().positive(),
  pidStart: z.string(),
  binary: z.string(),
  cwd: z.string(),
  startedAt: epochMsSchema,
  stoppedAt: epochMsSchema.nullable(),
  stopReason: z.enum(["exited", "killed", "grace_timeout", "crash"]).nullable(),
  exitCode: z.number().int().nullable(),
}) as unknown as z.ZodType<ProcessView>;

export interface WorkspaceView {
  dir: string;
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

export const workspaceViewSchema = strict({
  dir: z.string(),
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  commitSha: z.string().nullable(),
  filesChanged: z.number().int().nonnegative().nullable(),
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
}) as unknown as z.ZodType<WorkspaceView>;

export interface ExecutionDetailResponse {
  execution: ExecutionSummary;
  attempts: AttemptView[];
  input: OutputPreview | null;
  output: OutputPreview | null;
  usage: ExecutionUsage;
  process: ProcessView | null;
  workspace: WorkspaceView | null;
}

export const executionDetailResponseSchema = strict({
  execution: executionSummarySchema,
  attempts: z.array(attemptViewSchema),
  input: outputPreviewSchema.nullable(),
  output: outputPreviewSchema.nullable(),
  usage: executionUsageSchema,
  process: processViewSchema.nullable(),
  workspace: workspaceViewSchema.nullable(),
}) as unknown as z.ZodType<ExecutionDetailResponse>;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const transcriptKindSchema = z.enum([
  "text",
  "tool",
  "tool_result",
  "stderr",
  "notice",
  "raw",
  "system",
]);

export type TranscriptKind = z.infer<typeof transcriptKindSchema>;

export const transcriptStateSchema = z.enum(["pending", "available", "unavailable"]);

export type TranscriptState = z.infer<typeof transcriptStateSchema>;

export interface TranscriptLine {
  /** ISO timestamp from the JSONL transcript; null when the writer had none. */
  ts: string | null;
  kind: TranscriptKind;
  text: string;
}

export const transcriptLineSchema = strict({
  ts: z.string().nullable(),
  kind: transcriptKindSchema,
  text: z.string(),
}) as unknown as z.ZodType<TranscriptLine>;

export interface TranscriptPageResponse {
  state: TranscriptState;
  lines: TranscriptLine[];
  nextCursor: string | null;
  hasMore: boolean;
  attempt: number | null;
  generation: number | null;
  bytes: number | null;
}

export const transcriptPageResponseSchema = strict({
  state: transcriptStateSchema,
  lines: z.array(transcriptLineSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  attempt: z.number().int().positive().nullable(),
  generation: z.number().int().positive().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
}) as unknown as z.ZodType<TranscriptPageResponse>;

export const transcriptQuerySchema = strict({
  cursor: cursorQuerySchema,
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;

export interface OutputMetadata {
  id: string;
  runId: string;
  path: string;
  attempt: number;
  generation: number;
  kind: string;
  hash: string;
  bytes: number;
  createdAt: number;
}

export const outputMetadataSchema = strict({
  id: z.string(),
  runId: z.string(),
  path: z.string(),
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  kind: z.string(),
  hash: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
}) as unknown as z.ZodType<OutputMetadata>;

export interface RunContextEntry {
  path: string;
  nodeId: string;
  kind: string | null;
  status: string;
  attempt: number;
  generation: number;
  /** Enclosing loop round for body executions; controller iteration for loop controllers. */
  loopRound: number | null;
  output: { id: string; hash: string; bytes: number } | null;
  /** Reference-backed parent capture id for loop controllers. */
  captureId: string | null;
}

export const runContextEntrySchema = strict({
  path: z.string(),
  nodeId: z.string(),
  kind: z.string().nullable(),
  status: z.string(),
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  loopRound: z.number().int().positive().nullable(),
  output: z
    .strictObject({ id: z.string(), hash: z.string(), bytes: z.number().int().nonnegative() })
    .nullable(),
  captureId: z.string().nullable(),
}) as unknown as z.ZodType<RunContextEntry>;

export interface RunContextResponse {
  entries: RunContextEntry[];
  nextCursor: string | null;
}

export const runContextResponseSchema = strict({
  entries: z.array(runContextEntrySchema),
  nextCursor: z.string().nullable(),
}) as unknown as z.ZodType<RunContextResponse>;

export const runContextQuerySchema = strict({
  pathPrefix: z.string().max(4096).optional(),
  status: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: cursorQuerySchema,
});

export type RunContextQuery = z.infer<typeof runContextQuerySchema>;

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

export interface UsageModelSummary {
  model: string;
  usd: number;
  tokens: number;
}

export const usageModelSummarySchema = strict({
  model: z.string().min(1),
  usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
}) as unknown as z.ZodType<UsageModelSummary>;

export interface UsageProviderSummary {
  provider: string;
  usd: number;
  tokens: number;
  byModel: UsageModelSummary[];
}

export const usageProviderSummarySchema = strict({
  provider: z.string().min(1),
  usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  byModel: z.array(usageModelSummarySchema),
}) as unknown as z.ZodType<UsageProviderSummary>;

export interface UsageSummary {
  total: { usd: number; tokens: number };
  byProvider: UsageProviderSummary[];
}

export const usageSummarySchema = strict({
  total: strict({
    usd: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }),
  byProvider: z.array(usageProviderSummarySchema),
}) as unknown as z.ZodType<UsageSummary>;

/** Shared response schema registered as UsageSummaryResponse in contracts. */
export const usageSummaryResponseSchema = usageSummarySchema;

export const usageQuerySchema = strict({
  scope: z.enum(["global", "project"]).optional(),
  projectId: projectIdSchema.optional(),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** Acknowledgement is fenced to the exact interrupted shell and run watermark. */
export const resumeRunRequestSchema = strict({
  uncertaintyFence: strict({
    path: z.string().min(1),
    attempt: z.number().int().positive(),
    generation: z.number().int().positive(),
    eventId: z.number().int().nonnegative(),
  }).optional(),
});
export type ResumeRunRequest = z.infer<typeof resumeRunRequestSchema>;
