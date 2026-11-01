import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Clock,
  type EventDraft,
  type EventEnvelope,
  type ExecutionIdentity,
  type IdGen,
  type Path,
  type RunId,
  type RunView,
  systemClock,
  systemIds,
} from "@devchestra/core";
import {
  consumeApprovalWake,
  getApproval,
  listOutstandingApprovalWakes,
  listPendingApprovals,
  requestApproval,
  resolveApproval,
} from "./approvals.js";
import { EventBus } from "./bus.js";
import { archiveWorkflowRuns, removeProject, setRunArchived } from "./cleanup.js";
import {
  createContextCapture,
  getContextCapture,
  resolveCaptureScope,
} from "./context-captures.js";
import type { SqliteDb } from "./driver.js";
import { betterSqliteDriver } from "./driver-better-sqlite3.js";
import { appendEvents, type ListEventsOptions } from "./events.js";
import {
  type ExecutionSettings,
  getExecutionSettings,
  getWebhookSettings,
  setExecutionSettings,
  setWebhookSettings,
  type WebhookSettings,
} from "./execution-settings.js";
import {
  beginInvocation,
  completeExecution,
  ensureExecution,
  getExecution,
  listExecutions,
} from "./executions.js";
import {
  createForeachSource,
  getForeachSource,
  getForeachSourceByAttempt,
  getForeachSourceMeta,
  listForeachItemRefs,
  listForeachItems,
} from "./foreach.js";
import { decideLoop, startLoop } from "./loops.js";
import { applyMigrations } from "./migrate.js";
import { getOutput, recordDeterministic } from "./outputs.js";
import {
  activeProcesses,
  completeAcceptedAfterRecovery,
  getProcess,
  recordProcessStopped,
  recordSpawned,
  recordWorkspaceFinalized,
} from "./processes.js";
import { getView, listEvents, rebuildProjection } from "./projection.js";
import {
  ensureProject,
  findProjectByPath,
  getProject,
  listProjects,
  relinkProject,
} from "./projects.js";
import {
  disabledClis,
  listProviderSettings,
  type ProviderSettingRecord,
  setProviderEnabled,
} from "./provider-settings.js";
import {
  executionHistory,
  getOutputById,
  getOutputMetadataById,
  listOutputsByProvenance,
  listOutputsMetadata,
  listRuns,
  pageEvents,
  snapshotRun,
  workflowRunSummaries,
} from "./read-ports.js";
import { recover } from "./recovery.js";
import { recordDecision, recordGateDecision, recordJoinResolution } from "./routing.js";
import {
  getChildLink,
  getParentLink,
  getRunBundle,
  listChildLinks,
  putRunBundle,
} from "./run-children.js";
import { createRun, getRun, listActiveRuns, listQueuedRuns } from "./runs.js";
import { now, type Runtime } from "./runtime.js";
import { type SecretFinding, SecretRegistry } from "./secrets.js";
import {
  countNoSubmit,
  getAcceptedOutput,
  readReceipt,
  submit,
  validationLeft,
} from "./submissions.js";
import type {
  AcceptedOutput,
  ActiveProcess,
  ApprovalRecord,
  ApprovalWake,
  BeginInvocationInput,
  CompleteAcceptedAfterRecoveryInput,
  CompleteExecutionInput,
  CompleteExecutionResult,
  ContextCaptureRecord,
  CreateContextCaptureInput,
  CreateRunInput,
  CreateRunResult,
  DecideLoopInput,
  DecideLoopResult,
  EnsureExecutionInput,
  EnsureProjectInput,
  EventPage,
  EventPageOptions,
  ExecutionHistory,
  ExecutionRow,
  OpenStoreOptions,
  OutputMetadata,
  OutputMetadataPage,
  OutputProvenancePage,
  OutputProvenanceQuery,
  OutputRecord,
  ProcessRecord,
  ProjectRecord,
  Receipt,
  RecordDecisionInput,
  RecordDeterministicOutputInput,
  RecordDeterministicOutputResult,
  RecordGateDecisionInput,
  RecordJoinResolutionInput,
  RecordProcessStoppedInput,
  RecordSpawnedInput,
  RecordWorkspaceFinalizedInput,
  RecoveryReport,
  RelinkProjectInput,
  RequestApprovalInput,
  RequestApprovalResult,
  ResolveApprovalInput,
  ResolveApprovalResult,
  RoutingCommitResult,
  RunListFilters,
  RunListPage,
  RunRecord,
  RunSnapshot,
  RunSummary,
  StartLoopInput,
  StartLoopResult,
  SubmitInput,
  SubmitOutcome,
  UsageFilter,
  UsageSummary,
} from "./types.js";
import { getUsageSummary } from "./usage.js";
import { fail } from "./util.js";
import {
  type ArmTriggerInput,
  armTrigger,
  assertArmedRevision,
  bindDeliveryRun,
  type CreateTriggerInput,
  claimDelivery,
  createTrigger,
  disarmProjectTriggers,
  disarmTrigger,
  getTrigger,
  getTriggerRuntime,
  listTriggerSecrets,
  pruneExpiredDeliveries,
  replaceArmedRevision,
  rotateTriggerCredentials,
  setTriggerRefreshError,
  type TriggerRecord,
  type TriggerRuntime,
  type WebhookClaim,
  type WebhookClaimInput,
} from "./webhooks.js";
import {
  recordForeachItemDecided,
  recordForeachStarted,
  recordWorkflowCompleted,
  recordWorkflowLinked,
} from "./workflow-events.js";

export interface ProjectsApi {
  ensure(input: EnsureProjectInput): void;
  remove(projectId: string): void;
  list(): ProjectRecord[];
  get(projectId: string): ProjectRecord | null;
  findByPath(path: string): ProjectRecord | null;
  relink(input: RelinkProjectInput): ProjectRecord;
}

export interface ProviderSettingsApi {
  list(): ProviderSettingRecord[];
  setEnabled(cli: string, enabled: boolean): void;
  disabled(): ReadonlySet<string>;
}

export interface ExecutionSettingsApi {
  get(): ExecutionSettings;
  set(input: ExecutionSettings): ExecutionSettings;
}

export interface WebhookSettingsApi {
  get(): WebhookSettings;
  set(input: WebhookSettings): WebhookSettings;
}

/**
 * Webhook trigger state. Writes run inside the caller's transaction when they
 * are part of a delivery, so a disarm and a delivery claim cannot interleave.
 */
export interface WebhooksApi {
  trigger(projectId: string, workflowId: string): TriggerRecord | null;
  /** Includes credentials and the armed bundle. Never serialize the result. */
  runtimeFor(hookId: string): TriggerRuntime | null;
  create(input: CreateTriggerInput): void;
  arm(hookId: string, input: ArmTriggerInput): void;
  replaceRevision(hookId: string, expectedRevision: string, input: ArmTriggerInput): boolean;
  disarm(hookId: string): void;
  rotateCredentials(hookId: string, tokenHash: string, signingSecret: string): void;
  setRefreshError(hookId: string, message: string | null): void;
  claimDelivery(input: WebhookClaimInput): WebhookClaim;
  bindDelivery(hookId: string, deliveryId: string, runId: string): void;
  assertArmedRevision(hookId: string, revision: string): void;
  pruneExpiredDeliveries(limit: number): number;
  signingSecrets(): string[];
}

export interface RunsApi {
  create(input: CreateRunInput): CreateRunResult;
  /** Top-level launch: records `run.created` only and waits for an execution slot. */
  enqueue(input: CreateRunInput): CreateRunResult;
  listQueued(): RunRecord[];
  setArchived(runId: RunId, archived: boolean): void;
  archiveWorkflow(projectId: string, workflowId: string): void;
  workflowSummaries(projectId: string): RunSummary[];
  get(runId: RunId): RunRecord | null;
  list(filters?: RunListFilters): RunListPage;
  listActive(): RunRecord[];
}

export interface ProcessesApi {
  active(): ActiveProcess[];
}

export interface UsageApi {
  summary(filter?: UsageFilter): UsageSummary;
}

export interface OutputsApi {
  recordDeterministic(input: RecordDeterministicOutputInput): RecordDeterministicOutputResult;
  get(identity: Pick<ExecutionIdentity, "runId" | "path" | "attempt">): AcceptedOutput | null;
  getById(id: string): OutputRecord | null;
  listByProvenance(query: OutputProvenanceQuery): OutputProvenancePage;
  getMetadataById(id: string): OutputMetadata | null;
  listMetadata(query: OutputProvenanceQuery): OutputMetadataPage;
}

export interface ExecutionsApi {
  ensure(input: EnsureExecutionInput): ExecutionRow;
  get(runId: RunId, path: Path): ExecutionRow | null;
  list(runId: RunId): ExecutionRow[];
  history(runId: RunId, path: Path): ExecutionHistory;
  getProcess(identity: ExecutionIdentity): ProcessRecord | null;
  recordSpawned(input: RecordSpawnedInput): ProcessRecord;
  beginInvocation(input: BeginInvocationInput): ExecutionIdentity;
  recordProcessStopped(input: RecordProcessStoppedInput): void;
  recordWorkspaceFinalized(input: RecordWorkspaceFinalizedInput): void;
  complete(input: CompleteExecutionInput): CompleteExecutionResult;
  completeAcceptedAfterRecovery(input: CompleteAcceptedAfterRecoveryInput): CompleteExecutionResult;
}

export interface SubmissionsApi {
  submit(input: SubmitInput): SubmitOutcome;
  get(identity: ExecutionIdentity, callId: string): Receipt | null;
  accepted(identity: Pick<ExecutionIdentity, "runId" | "path" | "attempt">): AcceptedOutput | null;
  validationLeft(identity: ExecutionIdentity): number;
  /** Counts committed E_NO_SUBMIT rejected receipts across generations of one logical attempt. */
  countNoSubmit(identity: Pick<ExecutionIdentity, "runId" | "path" | "attempt">): number;
}

export interface EventsApi {
  append(runId: RunId, drafts: readonly EventDraft[]): EventEnvelope[];
  list(runId: RunId, options?: ListEventsOptions): EventEnvelope[];
  page(runId: RunId, options?: EventPageOptions): EventPage;
}

export interface ViewApi {
  get(runId: RunId): RunView;
  snapshot(runId: RunId): RunSnapshot;
  rebuild(runId: RunId): RunView;
}

export interface RecoveryApi {
  recover(runId: RunId): RecoveryReport;
}

export interface RoutingApi {
  recordGateDecision(input: RecordGateDecisionInput): RoutingCommitResult;
  recordDecision(input: RecordDecisionInput): RoutingCommitResult;
  recordJoinResolution(input: RecordJoinResolutionInput): RoutingCommitResult;
}

export interface LoopsApi {
  start(input: StartLoopInput): StartLoopResult;
  decide(input: DecideLoopInput): DecideLoopResult;
}

export interface WorkflowCallsApi {
  link(input: {
    identity: import("@devchestra/core").ExecutionIdentity;
    childRunId: string;
    workflowId: string;
    workflowHash: string;
  }): { eventId: number | null; duplicate: boolean };
  complete(input: {
    identity: import("@devchestra/core").ExecutionIdentity;
    childRunId: string;
    status: "succeeded" | "failed" | "rejected" | "cancelled";
    resultRef: string | null;
  }): { eventId: number | null; duplicate: boolean };
  getLink(
    parentRunId: import("@devchestra/core").RunId,
    parentPath: import("@devchestra/core").Path,
    parentAttempt: number,
  ): import("./run-children.js").ChildLink | null;
  getParent(childRunId: string): import("./run-children.js").ChildLink | null;
  listByParent(
    parentRunId: import("@devchestra/core").RunId,
  ): import("./run-children.js").ChildLink[];
  putBundle(
    runId: import("@devchestra/core").RunId,
    bundle: Record<string, unknown>,
    hash: string,
  ): void;
  getBundle(runId: import("@devchestra/core").RunId): import("./run-children.js").RunBundle | null;
}

export interface ForeachApi {
  createSource(input: {
    identity: import("@devchestra/core").ExecutionIdentity;
    kind: "expression" | "csv";
    items: unknown[];
    maxItems: number;
    parentCaptureId?: string;
  }): { source: import("./foreach.js").ForeachSource; duplicate: boolean };
  getSource(sourceId: string): import("./foreach.js").ForeachSource | null;
  /** Metadata-only source read (no items JSON parsed). */
  getSourceMeta(sourceId: string): import("./foreach.js").ForeachSourceMeta | null;
  listItems(sourceId: string): import("./foreach.js").ForeachItem[];
  /** Bounded item refs (no result_json selected). */
  listItemRefs(
    sourceId: string,
    options?: { offset?: number; limit?: number },
  ): import("./foreach.js").ForeachItemRef[];
  getSourceByAttempt(
    runId: import("@devchestra/core").RunId,
    path: import("@devchestra/core").Path,
    attempt: number,
  ): import("./foreach.js").ForeachSource | null;
  start(input: {
    identity: import("@devchestra/core").ExecutionIdentity;
    total: number;
    maxItems: number;
    sourceId: string;
    sourceHash: string;
  }): { eventId: number | null; duplicate: boolean };
  decideItem(input: {
    identity: import("@devchestra/core").ExecutionIdentity;
    sourceId: string;
    index: number;
    status: "succeeded" | "failed" | "rejected" | "skipped";
    result?: unknown;
  }): { eventId: number | null; duplicate: boolean };
}

export interface ContextCapturesApi {
  create(input: CreateContextCaptureInput): ContextCaptureRecord;
  get(captureId: string): ContextCaptureRecord | null;
  /** Verified hydration of a capture to its parent scope (fresh object per call). */
  resolve(runId: RunId, captureId: string): Record<string, unknown>;
}

export interface ApprovalsApi {
  request(input: RequestApprovalInput): RequestApprovalResult;
  resolve(input: ResolveApprovalInput): ResolveApprovalResult;
  get(identity: ExecutionIdentity): ApprovalRecord | null;
  listPending(filter?: { projectId?: string; runId?: RunId }): ApprovalRecord[];
  listOutstandingWakes(runId?: RunId): ApprovalWake[];
  consumeWake(identity: ExecutionIdentity, requestId: string): boolean;
}

export interface SecurityApi {
  /** Registers a value for reject/redact checks; returns an unregister function. */
  registerSecret(value: string, name?: string): () => void;
  scan(value: unknown): SecretFinding | null;
}

/**
 * @devchestra/store owns the only SQLite connection. Every write goes through tx();
 * appendEvents is the only writer of run_views/executions/run status.
 */
/**
 * The database holds recoverable webhook signing secrets, so on POSIX it stays
 * readable only by its owner. Files SQLite has not created yet are skipped.
 */
function restrictDatabaseFile(file: string): void {
  if (process.platform === "win32") return;
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not created yet, or not ours to change. The data directory is still 0700.
    }
  }
}

export class Store {
  readonly bus = new EventBus();
  readonly projects: ProjectsApi;
  readonly providerSettings: ProviderSettingsApi;
  readonly executionSettings: ExecutionSettingsApi;
  readonly webhookSettings: WebhookSettingsApi;
  readonly webhooks: WebhooksApi;
  readonly runs: RunsApi;
  readonly executions: ExecutionsApi;
  readonly processes: ProcessesApi;
  readonly usage: UsageApi;
  readonly outputs: OutputsApi;
  readonly submissions: SubmissionsApi;
  readonly events: EventsApi;
  readonly view: ViewApi;
  readonly recovery: RecoveryApi;
  readonly routing: RoutingApi;
  readonly loops: LoopsApi;
  readonly workflowCalls: WorkflowCallsApi;
  readonly foreach: ForeachApi;
  readonly contextCaptures: ContextCapturesApi;
  readonly approvals: ApprovalsApi;
  readonly security: SecurityApi;

  readonly #runtime: Runtime;

  constructor(options: OpenStoreOptions) {
    const driver = options.driver ?? betterSqliteDriver;
    const clock: Clock = options.clock ?? systemClock;
    const idGen: IdGen = options.idGen ?? systemIds;
    if (options.file !== ":memory:") mkdirSync(dirname(options.file), { recursive: true });
    const secrets = new SecretRegistry(options.secrets ?? []);
    this.#runtime = {
      db: driver.open(options.file),
      clock,
      idGen,
      bus: this.bus,
      secrets,
      depth: 0,
      pending: [],
      poisoned: false,
      poisonError: undefined,
    };
    if (options.file !== ":memory:") restrictDatabaseFile(options.file);
    try {
      this.#configure(this.#runtime.db);
      applyMigrations(this.#runtime.db, clock.now());
      this.#quickCheck(this.#runtime.db);
    } catch (error) {
      this.#runtime.db.close();
      throw error;
    }

    this.projects = {
      // Removing or relinking a project disarms its webhook triggers in the same
      // transaction, so a trigger never runs against a different directory.
      remove: (projectId) =>
        this.tx(() => {
          disarmProjectTriggers(this.#runtime, projectId);
          return removeProject(this.#runtime, projectId);
        }),
      ensure: (input) => this.tx(() => ensureProject(this.#runtime, input)),
      list: () => listProjects(this.#runtime),
      get: (projectId) => getProject(this.#runtime, projectId),
      findByPath: (path) => findProjectByPath(this.#runtime, path),
      relink: (input) =>
        this.tx(() => {
          disarmProjectTriggers(this.#runtime, input.projectId);
          return relinkProject(this.#runtime, input);
        }),
    };
    this.providerSettings = {
      list: () => listProviderSettings(this.#runtime),
      setEnabled: (cli, enabled) =>
        this.tx(() => setProviderEnabled(this.#runtime, cli, enabled, now(this.#runtime))),
      disabled: () => disabledClis(this.#runtime),
    };
    this.executionSettings = {
      get: () => getExecutionSettings(this.#runtime),
      set: (input) => this.tx(() => setExecutionSettings(this.#runtime, input)),
    };
    this.webhookSettings = {
      get: () => getWebhookSettings(this.#runtime),
      set: (input) => this.tx(() => setWebhookSettings(this.#runtime, input)),
    };
    this.webhooks = {
      trigger: (projectId, workflowId) => getTrigger(this.#runtime, projectId, workflowId),
      runtimeFor: (hookId) => getTriggerRuntime(this.#runtime, hookId),
      create: (input) => this.tx(() => createTrigger(this.#runtime, input)),
      arm: (hookId, input) => this.tx(() => armTrigger(this.#runtime, hookId, input)),
      replaceRevision: (hookId, expectedRevision, input) =>
        this.tx(() => replaceArmedRevision(this.#runtime, hookId, expectedRevision, input)),
      disarm: (hookId) => this.tx(() => disarmTrigger(this.#runtime, hookId)),
      rotateCredentials: (hookId, tokenHash, signingSecret) =>
        this.tx(() => rotateTriggerCredentials(this.#runtime, hookId, tokenHash, signingSecret)),
      setRefreshError: (hookId, message) =>
        this.tx(() => setTriggerRefreshError(this.#runtime, hookId, message)),
      claimDelivery: (input) => this.tx(() => claimDelivery(this.#runtime, input)),
      bindDelivery: (hookId, deliveryId, runId) =>
        this.tx(() => bindDeliveryRun(this.#runtime, hookId, deliveryId, runId)),
      assertArmedRevision: (hookId, revision) =>
        assertArmedRevision(this.#runtime, hookId, revision),
      pruneExpiredDeliveries: (limit) =>
        this.tx(() => pruneExpiredDeliveries(this.#runtime, limit)),
      signingSecrets: () => listTriggerSecrets(this.#runtime),
    };
    this.runs = {
      setArchived: (runId, archived) =>
        this.tx(() => setRunArchived(this.#runtime, runId, archived)),
      archiveWorkflow: (projectId, workflowId) =>
        this.tx(() => archiveWorkflowRuns(this.#runtime, projectId, workflowId)),
      workflowSummaries: (projectId) => workflowRunSummaries(this.#runtime, projectId),
      create: (input) => this.tx(() => createRun(this.#runtime, input)),
      enqueue: (input) => this.tx(() => createRun(this.#runtime, input, { queued: true })),
      listQueued: () => listQueuedRuns(this.#runtime),
      get: (runId) => getRun(this.#runtime, runId),
      list: (filters) => listRuns(this.#runtime, filters),
      listActive: () => listActiveRuns(this.#runtime),
    };
    this.processes = {
      active: () => activeProcesses(this.#runtime),
    };
    this.usage = {
      summary: (filter) => getUsageSummary(this.#runtime, filter ?? {}),
    };
    this.outputs = {
      recordDeterministic: (input) => this.tx(() => recordDeterministic(this.#runtime, input)),
      get: (identity) => getOutput(this.#runtime, identity.runId, identity.path, identity.attempt),
      getById: (id) => getOutputById(this.#runtime, id),
      listByProvenance: (query) => listOutputsByProvenance(this.#runtime, query),
      getMetadataById: (id) => getOutputMetadataById(this.#runtime, id),
      listMetadata: (query) => listOutputsMetadata(this.#runtime, query),
    };
    this.executions = {
      ensure: (input) => this.tx(() => ensureExecution(this.#runtime, input)),
      get: (runId, path) => getExecution(this.#runtime, runId, path),
      list: (runId) => listExecutions(this.#runtime, runId),
      history: (runId, path) => executionHistory(this.#runtime, runId, path),
      getProcess: (identity) => getProcess(this.#runtime, identity),
      recordSpawned: (input) => this.tx(() => recordSpawned(this.#runtime, input)),
      beginInvocation: (input) => this.tx(() => beginInvocation(this.#runtime, input)),
      recordProcessStopped: (input) => this.tx(() => recordProcessStopped(this.#runtime, input)),
      recordWorkspaceFinalized: (input) =>
        this.tx(() => recordWorkspaceFinalized(this.#runtime, input)),
      complete: (input) => this.tx(() => completeExecution(this.#runtime, input)),
      completeAcceptedAfterRecovery: (input) =>
        this.tx(() => completeAcceptedAfterRecovery(this.#runtime, input)),
    };
    this.submissions = {
      submit: (input) => this.tx(() => submit(this.#runtime, input)),
      get: (identity, callId) => readReceipt(this.#runtime, identity, callId),
      accepted: (identity) =>
        getAcceptedOutput(this.#runtime, identity.runId, identity.path, identity.attempt),
      validationLeft: (identity) => validationLeft(this.#runtime, identity),
      countNoSubmit: (identity) =>
        countNoSubmit(this.#runtime, identity.runId, identity.path, identity.attempt),
    };
    this.events = {
      append: (runId, drafts) => this.tx(() => appendEvents(this.#runtime, runId, drafts)),
      list: (runId, options) => listEvents(this.#runtime, runId, options),
      page: (runId, options) => pageEvents(this.#runtime, runId, options),
    };
    this.view = {
      get: (runId) => getView(this.#runtime, runId),
      snapshot: (runId) => snapshotRun(this.#runtime, runId),
      rebuild: (runId) => this.tx(() => rebuildProjection(this.#runtime, runId)),
    };
    this.recovery = {
      recover: (runId) => this.tx(() => recover(this.#runtime, runId)),
    };
    this.routing = {
      recordGateDecision: (input) => this.tx(() => recordGateDecision(this.#runtime, input)),
      recordDecision: (input) => this.tx(() => recordDecision(this.#runtime, input)),
      recordJoinResolution: (input) => this.tx(() => recordJoinResolution(this.#runtime, input)),
    };
    this.loops = {
      start: (input) => this.tx(() => startLoop(this.#runtime, input)),
      decide: (input) => this.tx(() => decideLoop(this.#runtime, input)),
    };
    this.workflowCalls = {
      link: (input) => this.tx(() => recordWorkflowLinked(this.#runtime, input)),
      complete: (input) => this.tx(() => recordWorkflowCompleted(this.#runtime, input)),
      getLink: (parentRunId, parentPath, parentAttempt) =>
        getChildLink(this.#runtime, parentRunId, parentPath, parentAttempt),
      getParent: (childRunId) => getParentLink(this.#runtime, childRunId),
      listByParent: (parentRunId) => listChildLinks(this.#runtime, parentRunId),
      putBundle: (runId, bundle, hash) =>
        this.tx(() => putRunBundle(this.#runtime, runId, bundle, hash)),
      getBundle: (runId) => getRunBundle(this.#runtime, runId),
    };
    this.foreach = {
      createSource: (input) => this.tx(() => createForeachSource(this.#runtime, input)),
      getSource: (sourceId) => getForeachSource(this.#runtime, sourceId),
      getSourceMeta: (sourceId) => getForeachSourceMeta(this.#runtime, sourceId),
      getSourceByAttempt: (runId, path, attempt) =>
        getForeachSourceByAttempt(this.#runtime, runId, path, attempt),
      listItems: (sourceId) => listForeachItems(this.#runtime, sourceId),
      listItemRefs: (sourceId, options) => listForeachItemRefs(this.#runtime, sourceId, options),
      start: (input) => this.tx(() => recordForeachStarted(this.#runtime, input)),
      decideItem: (input) => this.tx(() => recordForeachItemDecided(this.#runtime, input)),
    };
    this.contextCaptures = {
      create: (input) => this.tx(() => createContextCapture(this.#runtime, input)),
      get: (captureId) => getContextCapture(this.#runtime, captureId),
      resolve: (runId, captureId) => resolveCaptureScope(this.#runtime, runId, captureId),
    };
    this.approvals = {
      request: (input) => this.tx(() => requestApproval(this.#runtime, input)),
      resolve: (input) => this.tx(() => resolveApproval(this.#runtime, input)),
      get: (identity) => getApproval(this.#runtime, identity),
      listPending: (filter) => listPendingApprovals(this.#runtime, filter),
      listOutstandingWakes: (runId) => listOutstandingApprovalWakes(this.#runtime, runId),
      consumeWake: (identity, requestId) => {
        if (this.#runtime.depth > 0) return consumeApprovalWake(this.#runtime, identity, requestId);
        return this.tx(() => consumeApprovalWake(this.#runtime, identity, requestId));
      },
    };
    this.security = {
      registerSecret: (value, name) => secrets.register(value, name),
      scan: (value) => secrets.scanValue(value),
    };
  }

  /** All writes. The callback is synchronous; nested calls join the outer transaction. */
  tx<T>(fn: (store: Store) => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
    const runtime = this.#runtime;
    if (fn.constructor.name === "AsyncFunction") {
      fail("E_INTERNAL", "store.tx callbacks must be synchronous; async callbacks are rejected");
    }
    if (runtime.depth > 0) {
      if (runtime.poisoned) {
        throw runtime.poisonError instanceof Error
          ? runtime.poisonError
          : new Error("Outer transaction is poisoned by an earlier nested failure");
      }
      try {
        return this.#syncResult(fn(this));
      } catch (error) {
        // Even if the caller catches, the outer transaction must not commit
        // rows written before the failure.
        runtime.poisoned = true;
        runtime.poisonError = error;
        throw error;
      }
    }
    runtime.poisoned = false;
    runtime.poisonError = undefined;
    runtime.db.exec("BEGIN IMMEDIATE");
    runtime.depth = 1;
    try {
      const result = this.#syncResult(fn(this));
      if (runtime.poisoned) {
        throw runtime.poisonError instanceof Error
          ? runtime.poisonError
          : new Error("Outer transaction is poisoned by an earlier nested failure");
      }
      runtime.db.exec("COMMIT");
      runtime.depth = 0;
      const committed = runtime.pending;
      runtime.pending = [];
      runtime.poisoned = false;
      runtime.poisonError = undefined;
      this.bus.publish(committed);
      return result;
    } catch (error) {
      try {
        runtime.db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
      runtime.pending = [];
      runtime.depth = 0;
      runtime.poisoned = false;
      runtime.poisonError = undefined;
      throw error;
    }
  }

  #syncResult<T>(result: T): T {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      fail(
        "E_INTERNAL",
        "store.tx callbacks must be synchronous; a promise was returned and the transaction was rolled back",
      );
    }
    return result;
  }

  close(): void {
    if (this.#runtime.depth > 0) {
      fail("E_INTERNAL", "Cannot close the store inside a transaction");
    }
    this.#runtime.db.close();
  }

  #configure(db: SqliteDb): void {
    const pragmas = [
      "journal_mode = WAL",
      "synchronous = NORMAL",
      "foreign_keys = ON",
      "busy_timeout = 5000",
      "wal_autocheckpoint = 1000",
      "temp_store = MEMORY",
      "trusted_schema = OFF",
    ];
    for (const pragma of pragmas) db.pragma(pragma);
    const fts = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS present").get() as
      | { present?: number }
      | undefined;
    if (!fts?.present) {
      fail("E_INTERNAL", "This SQLite build lacks FTS5; DevChestra store refuses to start");
    }
  }

  #quickCheck(db: SqliteDb): void {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check && row.quick_check !== "ok") {
      fail("E_INTERNAL", `SQLite quick_check failed: ${row.quick_check}`);
    }
  }
}

export function openStore(options: OpenStoreOptions): Store {
  return new Store(options);
}
