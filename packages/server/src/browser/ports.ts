import type {
  ApprovalListResponse,
  ApprovalResolveResponse,
  AttemptView,
  BootstrapSettings,
  CatalogCli,
  CliMcpServers,
  CliModelCatalog,
  CliModelItem,
  CliProbeSummary,
  CommandResponse,
  EventPageResponse,
  ExecutionDetailResponse,
  ExecutionSummary,
  ExecutionUsage,
  HealthResponse,
  ListProjectsResponse,
  OutputPreview,
  ProcessView,
  ProjectView,
  ProjectWorkspacesResponse,
  RunDetailResponse,
  RunListResponse,
  RunSummary,
  RunWorkspaceSelection,
  StartRunResponse,
  TranscriptLine,
  TranscriptPageResponse,
  WorkspaceView,
} from "@devchestra/api";
import type { EventType, JsonObject, RunStatus } from "@devchestra/core";
import type { NormalizedWorkflow } from "@devchestra/schema";
import type { AcceptedOutput, ExecutionHistory, ExecutionRow } from "@devchestra/store";
import type { Hono } from "hono";

export type {
  AttemptView,
  BootstrapSettings,
  CatalogCli,
  CliMcpServers,
  CliModelCatalog,
  CliModelItem,
  CliProbeSummary,
  CommandResponse,
  EventPageResponse,
  ExecutionDetailResponse,
  ExecutionSummary,
  ExecutionUsage,
  HealthResponse,
  ListProjectsResponse,
  OutputPreview,
  ProcessView,
  ProjectView,
  ProjectWorkspacesResponse,
  RunDetailResponse,
  RunListResponse,
  RunSummary,
  RunWorkspaceSelection,
  StartRunResponse,
  TranscriptLine,
  TranscriptPageResponse,
  WorkspaceView,
};

export type ProjectKind = "git" | "folder";
export type RunListPage = RunListResponse;
export type RunDetailView = RunDetailResponse;
export type EventPage = EventPageResponse;
export type ExecutionDetailView = ExecutionDetailResponse;
export type TranscriptPage = TranscriptPageResponse;
export type StopReason = "exited" | "killed" | "grace_timeout" | "crash";

export interface ListRunsQuery {
  archived?: boolean;
  projectId?: string;
  workflowId?: string;
  status?: readonly RunStatus[];
  cursor?: string;
  limit: number;
}

export interface EventsQuery {
  after?: number;
  upTo?: number;
  limit: number;
  types?: readonly EventType[];
  pathPrefix?: string;
}

export interface RegisterProjectCommand {
  path: string;
  name: string;
  kind: ProjectKind;
}

export interface RelinkProjectCommand {
  projectId: string;
  path: string;
  name: string;
  kind: ProjectKind;
}

export interface RunContextEntry {
  path: string;
  nodeId: string;
  kind: string | null;
  status: string;
  attempt: number;
  generation: number;
  loopRound: number | null;
  output: {
    id: string;
    hash: string;
    bytes: number;
  } | null;
  captureId: string | null;
}

export interface RunContextQuery {
  pathPrefix?: string;
  status?: string;
  limit: number;
  cursor?: string;
}

export interface BrowserQueryPort {
  removeProject?(projectId: string): void | Promise<void>;
  setRunArchived?(runId: string, archived: boolean): void | Promise<void>;
  archiveWorkflowRuns?(projectId: string, workflowId: string): void | Promise<void>;
  projectRunSummaries?(projectId: string): RunListPage | Promise<RunListPage>;
  listProjects(): Promise<ProjectView[]> | ProjectView[];
  getProject(projectId: string): Promise<ProjectView | null> | ProjectView | null;
  registerProject(input: RegisterProjectCommand): Promise<ProjectView> | ProjectView;
  relinkProject(input: RelinkProjectCommand): Promise<ProjectView> | ProjectView;
  listRuns(input: ListRunsQuery): Promise<RunListPage> | RunListPage;
  getRun(runId: string): Promise<RunSummary | null> | RunSummary | null;
  runDetail(runId: string): Promise<RunDetailView | null> | RunDetailView | null;
  eventsPage(runId: string, input: EventsQuery): Promise<EventPage> | EventPage;
  getExecution(runId: string, path: string): Promise<ExecutionRow | null> | ExecutionRow | null;
  executionHistory(runId: string, path: string): Promise<ExecutionHistory> | ExecutionHistory;
  getOutput(
    runId: string,
    path: string,
    attempt: number,
  ): Promise<AcceptedOutput | null> | AcceptedOutput | null;
  listOutputMetadata?(
    runId: string,
    input: { path?: string; limit: number; cursor?: string },
  ): Promise<{ items: Array<{ id: string; path: string; attempt: number; generation: number; kind: string; hash: string; bytes: number; createdAt: number }>; nextCursor: string | null }> | { items: Array<{ id: string; path: string; attempt: number; generation: number; kind: string; hash: string; bytes: number; createdAt: number }>; nextCursor: string | null };
  getOutputMetadataById?(
    outputId: string,
  ): Promise<{ id: string; runId: string; path: string; attempt: number; generation: number; hash: string; bytes: number } | null> | { id: string; runId: string; path: string; attempt: number; generation: number; hash: string; bytes: number } | null;
  getOutputById?(
    outputId: string,
  ): Promise<AcceptedOutput | null> | AcceptedOutput | null;
  runContext?(
    runId: string,
    query: RunContextQuery,
  ): Promise<{ entries: RunContextEntry[]; nextCursor: string | null }> | { entries: RunContextEntry[]; nextCursor: string | null };
  counts():
    | Promise<{ runs: number; activeRuns: number; inbox: number }>
    | {
        runs: number;
        activeRuns: number;
        inbox: number;
      };
  listApprovals(input: {
    projectId?: string;
    runId?: string;
    cursor?: string;
    limit: number;
  }): Promise<ApprovalListResponse> | ApprovalListResponse;
  getApproval(
    runId: string,
    path: string,
  ):
    | Promise<{
        approval: import("@devchestra/api").ApprovalSummary;
        requestedEvent: unknown;
        resolvedEvent: unknown | null;
        execution: ExecutionRow | null;
      } | null>
    | {
        approval: import("@devchestra/api").ApprovalSummary;
        requestedEvent: unknown;
        resolvedEvent: unknown | null;
        execution: ExecutionRow | null;
      }
    | null;
}

export interface StartRunCommand {
  projectId: string;
  workflowId: string;
  workflowFile: string;
  snapshot: NormalizedWorkflow;
  snapshotRaw: string;
  params: JsonObject;
  /** Normalized run-level workspace; the server always sends a selection for fresh runs. */
  workspace?: RunWorkspaceSelection;
  idempotencyKey?: string;
}

/**
 * Read-only workspace catalog and selection validation. Implemented by the CLI
 * (which may touch Git). The server never creates a worktree before the run is
 * durable: `validate` only inspects the trusted project's worktree list.
 */
export interface BrowserWorkspacePort {
  catalog(projectRoot: string): Promise<ProjectWorkspacesResponse> | ProjectWorkspacesResponse;
  validate(
    projectRoot: string,
    selection: RunWorkspaceSelection,
  ): Promise<RunWorkspaceSelection> | RunWorkspaceSelection;
}

export interface BrowserRunControllerPort {
  startRun(input: StartRunCommand): Promise<StartRunResponse> | StartRunResponse;
  cancelRun(runId: string): Promise<CommandResponse> | CommandResponse;
  resumeRun(runId: string): Promise<CommandResponse> | CommandResponse;
  resolveApproval(input: {
    runId: string;
    path: string;
    requestId: string;
    decision: "approve" | "reject";
    note?: string;
    expectedAttempt: number;
    expectedGeneration: number;
  }): Promise<ApprovalResolveResponse> | ApprovalResolveResponse;
}

export interface BrowserStreamPort {
  mountRoutes(app: Hono): void;
  close?(): void;
}

/** Adapter-backed model catalog, composed by the CLI outside the server. */
export interface BrowserModelCatalogPort {
  get(projectId: string, cli: CatalogCli): Promise<CliModelCatalog>;
  refresh(projectId: string, cli: CatalogCli): Promise<CliModelCatalog>;
  close?(): void | Promise<void>;
}

/** Read-only MCP server discovery, composed by the CLI outside the server. */
export interface BrowserMcpServersPort {
  list(projectId: string, cli: CatalogCli): Promise<CliMcpServers>;
}
