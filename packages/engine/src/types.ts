import type { AdapterRegistry, ResolvedMcpServer, RunRequest } from "@devchestra/adapters";
import type {
  Clock,
  DevChestraError,
  EventEnvelope,
  ExecutionIdentity,
  JsonObject,
  Result,
  RunStatus,
  RunView,
  RunWorkspaceSelection,
  SerializedError,
} from "@devchestra/core";
import type { DecisionService } from "@devchestra/decisions";
import type { McpScope, McpSelection, NormalizedWorkflow, ProdCliId } from "@devchestra/schema";
import type { Store } from "@devchestra/store";
import type {
  AcquireScratchRequest,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  PrepareRunWorkspaceRequest,
  RunWorkspaceIdentity,
  ScratchWorkspace,
} from "@devchestra/workspaces";

export type EngineCli = ProdCliId | "fake";

export interface GatewayScope {
  readonly identity: ExecutionIdentity;
  readonly outputSchema: Record<string, unknown>;
  readonly outputSchemaHash: string;
  readonly validationLimit: number;
  readonly expiresAt: number;
}

export interface IssuedToken {
  readonly token: string;
  revoke(): void;
}

export interface GatewayPort {
  readonly url: string;
  issue(scope: GatewayScope): IssuedToken;
}

/**
 * Names-only view of an MCP server the CLI knows, for switching unselected
 * servers off. Mirrors the discovery contract (`@devchestra/adapters`
 * `McpResolver`); method syntax keeps the real implementation assignable to
 * this structural slot.
 */
export interface KnownMcpServer {
  readonly name: string;
  readonly scope: McpScope;
  readonly connectorId?: string;
}

/**
 * Structural resolver the engine calls right before an agent launch. The real
 * implementation is built by the discovery worker and exported from
 * `@devchestra/adapters`; tests use an in-test fake. `list` never fails the node,
 * `resolve` fails it fast (never silent skip).
 */
export interface McpResolver {
  /** Everything the CLI knows for this project. Names only (no secrets). */
  list(cli: string, projectDir: string): Promise<{ servers: KnownMcpServer[]; warnings: string[] }>;
  /** Selected servers with launch details. Fails (never skips) when one is missing. */
  resolve(
    cli: string,
    projectDir: string,
    selection: readonly McpSelection[],
  ): Promise<
    Result<
      { extra: ResolvedMcpServer[]; known: NonNullable<RunRequest["knownMcp"]> },
      DevChestraError
    >
  >;
}

export interface WorkspacePort {
  /** Run-level preflight. Optional for legacy/test ports. */
  prepare?(
    request: PrepareRunWorkspaceRequest,
  ): Promise<Result<RunWorkspaceIdentity, DevChestraError>>;
  acquire(request: AcquireScratchRequest): Promise<Result<ScratchWorkspace, DevChestraError>>;
  finalize(
    workspace: ScratchWorkspace,
    request: FinalizeScratchRequest,
  ): Promise<Result<FinalizeScratchInfo, DevChestraError>>;
  release(workspace: ScratchWorkspace): void;
}

export interface OutputValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type OutputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly OutputValidationIssue[] };

/**
 * Single workflow definition resolved by workflowId within one project.
 * `normalized` is the frozen NormalizedWorkflow snapshot (typed as unknown
 * here so the engine never depends on schema-package validation timing).
 */
export interface ResolvedChildWorkflow {
  readonly id: string;
  readonly normalized: unknown;
  readonly hash: string;
  readonly text: string;
}

/**
 * Project-bound single-id reader. The server/CLI injects the safe loader
 * (parse+validate+normalize); the engine owns the transitive freeze walker.
 * Same-project is enforced by the caller passing the parent projectId.
 */
export interface WorkflowResolver {
  resolve(
    projectId: string,
    workflowId: string,
  ): Promise<Result<ResolvedChildWorkflow, DevChestraError>>;
}

export interface EngineDeps {
  readonly store: Store;
  readonly adapters: AdapterRegistry;
  readonly workspaces: WorkspacePort;
  readonly gateway: GatewayPort;
  readonly dataDir: string;
  readonly nodeBin: string;
  readonly mcpShimEntry: string;
  readonly clock?: Clock;
  readonly finishGraceMs?: number;
  readonly shutdownGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Caller-owned opt-in for unverified real CLI profiles. Fake is test-only behind DEVCHESTRA_ALLOW_FAKE. */
  readonly allowExperimentalClis?: readonly ProdCliId[];
  readonly prompts?: Readonly<Record<string, string>>;
  /** Explicit non-secret env names the caller wants preserved (e.g. fake fixture path). */
  readonly extraEnvNames?: readonly string[];
  /** Caller-owned tightening for tests/ops; never raises the workflow timeout. */
  readonly maxNodeTimeoutMs?: number;
  /** Required for loops and joins that declare output schemas. */
  readonly validateOutput?: (schema: Record<string, unknown>, value: unknown) => OutputValidation;
  /**
   * Decision-model service for `decision` nodes. Composition roots pass a
   * real `createDecisionService()`; when it is missing a decision node fails
   * with an actionable `E_PROVIDER` error instead of hanging or defaulting.
   */
  readonly decisions?: DecisionService;
  /**
   * MCP resolver for agent `mcpServers` selections. The coordinator wires the
   * real implementation; when a selection exists but no resolver is
   * configured, the node fails with an actionable error.
   */
  readonly mcpResolver?: McpResolver;
  /** Project-bound child workflow reader; required when a plan contains workflow/foreach bodies. */
  readonly workflowResolver?: WorkflowResolver;
}

export interface RunIdempotency {
  /** Caller-owned namespace; defaults to projectId in the store. */
  readonly scope: string;
  readonly key: string;
  /** Canonical fingerprint of the normalized snapshot + params. */
  readonly fingerprint: string;
}

export interface StartRunInput {
  readonly projectId: string;
  readonly workflowId: string;
  readonly snapshot: NormalizedWorkflow | unknown;
  readonly snapshotRaw: string;
  readonly params?: JsonObject;
  readonly budgets?: JsonObject;
  readonly baseSha?: string;
  /** One workspace per run; defaults to the registered project root. */
  readonly workspace?: RunWorkspaceSelection;
  readonly idempotency?: RunIdempotency;
  /** Frozen transitive child workflow snapshots (id -> NormalizedWorkflow). Composed by server/CLI or the engine freeze walker. */
  readonly workflowDependencies?: Readonly<Record<string, unknown>>;
}

export interface RunOutcome {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: unknown;
  readonly pausedReason?: string;
  readonly error?: SerializedError;
}

/**
 * Returned as soon as the run is durable, before any node completes. A
 * duplicate id is the original run: completion is the active run's promise
 * when this engine owns it, otherwise the current (non-dispatched) outcome.
 */
export interface LaunchResult {
  readonly runId: string;
  readonly duplicate: boolean;
  readonly completion: Promise<RunOutcome>;
}

export interface ResumeOptions {
  readonly allowUncertainSideEffectRetry?: boolean;
  readonly approvedBy?: string;
}

export interface Engine {
  start(): Promise<void>;
  /**
   * Abort active drives and wait for them to settle, at most `graceMs`
   * (else `shutdownGraceMs`, else 30s). Returns after the deadline even if
   * a drive is still settling; late outcomes resolve in the background.
   */
  stop(options?: { graceMs?: number }): Promise<void>;
  /** Durable create + async dispatch; resolves before the run completes. */
  launch(input: StartRunInput): Promise<Result<LaunchResult, DevChestraError>>;
  /** Durable resume + async dispatch; resolves before the run completes. */
  launchResume(
    runId: string,
    options?: ResumeOptions,
  ): Promise<Result<LaunchResult, DevChestraError>>;
  /** Compatibility: awaits launch(...).completion. */
  run(input: StartRunInput): Promise<Result<RunOutcome, DevChestraError>>;
  /** Compatibility: awaits launchResume(...).completion. */
  resume(runId: string, options?: ResumeOptions): Promise<Result<RunOutcome, DevChestraError>>;
  cancel(runId: string): Promise<Result<void, DevChestraError>>;
  subscribe(callback: (event: EventEnvelope) => void): () => void;
  view(runId: string): RunView;
  getRun(runId: string): Promise<RunOutcome | null>;
}
