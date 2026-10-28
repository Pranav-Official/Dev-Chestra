import type { AdapterRegistry, ResolvedMcpServer, RunRequest } from "@relay/adapters";
import type {
  Clock,
  EventEnvelope,
  ExecutionIdentity,
  JsonObject,
  RelayError,
  Result,
  RunStatus,
  RunView,
  RunWorkspaceSelection,
  SerializedError,
} from "@relay/core";
import type { DecisionService } from "@relay/decisions";
import type { McpScope, McpSelection, NormalizedWorkflow, ProdCliId } from "@relay/schema";
import type { Store } from "@relay/store";
import type {
  AcquireScratchRequest,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  PrepareRunWorkspaceRequest,
  RunWorkspaceIdentity,
  ScratchWorkspace,
} from "@relay/workspaces";

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
 * servers off. Mirrors the discovery contract (`@relay/adapters`
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
 * `@relay/adapters`; tests use an in-test fake. `list` never fails the node,
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
    Result<{ extra: ResolvedMcpServer[]; known: NonNullable<RunRequest["knownMcp"]> }, RelayError>
  >;
}

export interface WorkspacePort {
  /** Run-level preflight. Optional for legacy/test ports. */
  prepare?(request: PrepareRunWorkspaceRequest): Promise<Result<RunWorkspaceIdentity, RelayError>>;
  acquire(request: AcquireScratchRequest): Promise<Result<ScratchWorkspace, RelayError>>;
  finalize(
    workspace: ScratchWorkspace,
    request: FinalizeScratchRequest,
  ): Promise<Result<FinalizeScratchInfo, RelayError>>;
  release(workspace: ScratchWorkspace): void;
}

export interface OutputValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type OutputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly OutputValidationIssue[] };

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
  /** Caller-owned opt-in for unverified real CLI profiles. Fake is test-only behind RELAY_ALLOW_FAKE. */
  readonly allowExperimentalClis?: readonly ProdCliId[];
  readonly prompts?: Readonly<Record<string, string>>;
  /** Explicit non-secret env names the caller wants preserved (e.g. fake fixture path). */
  readonly extraEnvNames?: readonly string[];
  /** Caller-owned tightening for tests/ops; never raises the workflow timeout. */
  readonly maxNodeTimeoutMs?: number;
  /** Join output validation; required (fail closed) only when a join declares output. */
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
  stop(options?: { graceMs?: number }): Promise<void>;
  /** Durable create + async dispatch; resolves before the run completes. */
  launch(input: StartRunInput): Promise<Result<LaunchResult, RelayError>>;
  /** Durable resume + async dispatch; resolves before the run completes. */
  launchResume(runId: string, options?: ResumeOptions): Promise<Result<LaunchResult, RelayError>>;
  /** Compatibility: awaits launch(...).completion. */
  run(input: StartRunInput): Promise<Result<RunOutcome, RelayError>>;
  /** Compatibility: awaits launchResume(...).completion. */
  resume(runId: string, options?: ResumeOptions): Promise<Result<RunOutcome, RelayError>>;
  cancel(runId: string): Promise<Result<void, RelayError>>;
  subscribe(callback: (event: EventEnvelope) => void): () => void;
  view(runId: string): RunView;
  getRun(runId: string): Promise<RunOutcome | null>;
}
