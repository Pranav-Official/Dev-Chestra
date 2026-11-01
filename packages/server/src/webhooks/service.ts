import type {
  ExecutionSettings,
  ExecutionSettingsResponse,
  RunWorkspaceSelection,
  WebhookDeliveryResponse,
  WebhookIssue,
  WebhookSettings,
  WebhookTriggerResponse,
  WebhookTriggerStatus,
} from "@devchestra/api";
import { hashJson, isRecord, type JsonObject } from "@devchestra/core";
import {
  type NormalizedStartNode,
  type NormalizedWorkflow,
  normalizeWorkflow,
  resolveWebhookParams,
  type WorkflowFile,
  workflowNodes,
} from "@devchestra/schema";
import { EXECUTION_LIMITS, type TriggerRecord, type TriggerRuntime } from "@devchestra/store";
import type { BrowserWorkspacePort, ProjectView } from "../browser/ports.js";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { validateRunWorkspace } from "../browser/workspaces.js";
import { DevChestraError, devchestraErrorCode } from "../errors.js";
import type {
  ManagedWorkflowService,
  WorkflowDocumentView,
  WorkflowProject,
} from "../workflows/service.js";
import type { BrowserWebhookPorts, WebhookRunDelivery, WebhookRunLaunch } from "./ports.js";
import {
  digestEquals,
  hmacSha256Hex,
  isDeliveryId,
  newHookId,
  newSigningSecret,
  sha256Hex,
  signatureFromHeader,
} from "./secrets.js";

const NEW_WORKTREE: RunWorkspaceSelection = { mode: "new-worktree" };
const REFRESH_MESSAGE_MAX = 500;
const VALIDATION_CODE = "E_VALIDATION";

export interface WebhookServiceDeps {
  readonly ports: BrowserWebhookPorts;
  readonly workflows: ManagedWorkflowService;
  readonly dataDir: string;
  readonly getProject: (projectId: string) => ProjectView | null | Promise<ProjectView | null>;
  /** Current status of a run, or null when it is unknown. Used for duplicate responses. */
  readonly getRunStatus: (runId: string) => string | null | Promise<string | null>;
  readonly workspaceService?: BrowserWorkspacePort | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** Raw facts about one delivery, as read by the ingress route. Never logged. */
export interface WebhookDeliveryInput {
  readonly rawBody: Uint8Array;
  /** Raw values of the accepted signature headers, in the order they were checked. */
  readonly signatures: readonly (string | undefined)[];
  /** First present delivery-ID header value, if any. */
  readonly deliveryId: string | undefined;
  /** Allowlisted headers only, lowercase names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface WebhookDeliveryOutcome {
  readonly status: 200 | 202;
  readonly body: WebhookDeliveryResponse;
}

type StatusBase = Omit<WebhookTriggerStatus, "armed" | "state" | "issues">;

type SavedRead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "unreadable";
      readonly error: unknown;
      readonly code: string;
      readonly issues: WebhookIssue[];
    }
  | { readonly kind: "document"; readonly document: WorkflowDocumentView };

interface FrozenRevision {
  readonly snapshot: NormalizedWorkflow;
  readonly bundle: Record<string, unknown>;
  readonly revision: string;
}

/**
 * Webhook trigger lifecycle for saved workflows, and the delivery pipeline the
 * public ingress uses. Every state change goes through the store's transactional
 * methods. Credentials are returned only by the call that creates or rotates them.
 */
export class WebhookService {
  readonly #deps: WebhookServiceDeps;

  constructor(deps: WebhookServiceDeps) {
    this.#deps = deps;
  }

  get #store(): BrowserWebhookPorts["store"] {
    return this.#deps.ports.store;
  }

  /** The trigger for a hook ID, including server-only credentials. Never serialize it. */
  runtimeFor(hookId: string): TriggerRuntime | null {
    return this.#store.webhooks.runtimeFor(hookId);
  }

  async status(
    project: WorkflowProject,
    workflowId: string,
    origin: string,
  ): Promise<WebhookTriggerStatus> {
    const trigger = this.#store.webhooks.trigger(project.id, workflowId);
    const saved = this.#readSaved(project, workflowId);
    if (saved.kind === "missing" && trigger === null) {
      throw new DevChestraError("E_NOT_FOUND", `Workflow '${workflowId}' not found.`);
    }
    const supported = saved.kind === "document" && declaresWebhook(saved.document.workflow);
    const base = this.#statusBase(trigger, supported, origin);
    if (trigger === null || !trigger.armed) {
      return { ...base, armed: false, state: "off", issues: [] };
    }
    const invalid = (issues: WebhookIssue[]): WebhookTriggerStatus => ({
      ...base,
      armed: true,
      state: "invalid",
      issues,
    });
    if (saved.kind === "missing") {
      return invalid([{ code: "E_NOT_FOUND", message: "The saved workflow was not found." }]);
    }
    if (saved.kind === "unreadable") return invalid(saved.issues);
    const { document } = saved;
    if (!document.validation.ok) return invalid(issuesOf(document.validation.errors));
    if (!supported) {
      return invalid([
        {
          code: "E_WEBHOOK_NOT_ENABLED",
          message: "The saved workflow no longer enables webhook triggers.",
        },
      ]);
    }
    try {
      const frozen = await this.#frozen(project, workflowId, document);
      return {
        ...base,
        armed: true,
        state: frozen.revision === trigger.armedRevision ? "current" : "stale",
        issues: [],
      };
    } catch (error) {
      const code = devchestraErrorCode(error);
      if (code === null) throw error;
      return invalid([{ code, message: messageOf(error) }]);
    }
  }

  /** Arms the saved workflow. Creates the hook and credentials on the first arm only. */
  async arm(
    project: WorkflowProject,
    workflowId: string,
    origin: string,
  ): Promise<WebhookTriggerResponse> {
    return this.#deps.workflows.exclusive(project, async () => {
      const document = this.#requireDocument(project, workflowId);
      if (!declaresWebhook(document.workflow)) throw notSupported();
      await this.#requireNewWorktree(this.#projectRoot(project));
      const frozen = await this.#frozen(project, workflowId, document);
      const existing = this.#store.webhooks.trigger(project.id, workflowId);
      let hookId: string;
      // The secret is generated and returned once, when the hook is first created.
      let secret: string | null = null;
      if (existing === null) {
        hookId = newHookId();
        secret = newSigningSecret();
        this.#store.webhooks.create({
          hookId,
          projectId: project.id,
          workflowId,
          signingSecret: secret,
        });
      } else {
        hookId = existing.hookId;
      }
      this.#store.webhooks.arm(hookId, {
        armedRevision: frozen.revision,
        snapshot: frozen.snapshot,
        snapshotRaw: document.text,
        bundle: frozen.bundle,
      });
      return { status: await this.status(project, workflowId, origin), secret };
    });
  }

  /** Disarms the trigger. Idempotent: a workflow with no trigger reports `off`. */
  async disarm(
    project: WorkflowProject,
    workflowId: string,
    origin: string,
  ): Promise<WebhookTriggerStatus> {
    const trigger = this.#store.webhooks.trigger(project.id, workflowId);
    if (trigger?.armed === true) this.#store.webhooks.disarm(trigger.hookId);
    return this.status(project, workflowId, origin);
  }

  /** Replaces the secret. The old secret stops verifying when this returns. */
  async rotate(
    project: WorkflowProject,
    workflowId: string,
    origin: string,
  ): Promise<WebhookTriggerResponse> {
    const trigger = this.#store.webhooks.trigger(project.id, workflowId);
    if (trigger === null) {
      throw new DevChestraError("E_NOT_FOUND", "No webhook trigger exists for this workflow.");
    }
    const secret = newSigningSecret();
    this.#store.webhooks.rotateCredentials(trigger.hookId, secret);
    return { status: await this.status(project, workflowId, origin), secret };
  }

  /** Re-freezes an armed trigger from the saved files. Keeps the old revision on failure. */
  async refresh(
    project: WorkflowProject,
    workflowId: string,
    origin: string,
  ): Promise<WebhookTriggerStatus> {
    await this.#deps.workflows.exclusive(project, () => this.#refreshArmed(project, workflowId));
    return this.status(project, workflowId, origin);
  }

  /**
   * Best-effort refresh after a successful save of the root workflow. A failure is
   * recorded on the trigger and never reaches the save response.
   */
  async afterSave(project: WorkflowProject, workflowId: string): Promise<void> {
    try {
      await this.#deps.workflows.exclusive(project, async () => {
        const trigger = this.#store.webhooks.trigger(project.id, workflowId);
        if (trigger?.armed !== true) return;
        await this.#refreshArmed(project, workflowId);
      });
    } catch {
      this.#log(`webhook refresh after save did not complete for workflow ${workflowId}`);
    }
  }

  /** A deleted workflow must not keep an armed hook running its last revision. */
  afterDelete(project: WorkflowProject, workflowId: string): void {
    const trigger = this.#store.webhooks.trigger(project.id, workflowId);
    if (trigger?.armed === true) this.#store.webhooks.disarm(trigger.hookId);
  }

  /**
   * Authenticates and launches one delivery. Checks run in the contract order, so
   * a disarmed hook is refused before its body is parsed. Refusals throw a
   * DevChestraError; other engine refusals are re-thrown for the ingress to map by code.
   */
  async deliver(
    runtime: TriggerRuntime,
    input: WebhookDeliveryInput,
  ): Promise<WebhookDeliveryOutcome> {
    if (!authenticates(runtime, input)) {
      throw new DevChestraError("E_AUTH", "Webhook authentication failed.");
    }
    if (!runtime.armed || runtime.armedRevision === null || runtime.snapshotRaw === null) {
      throw new DevChestraError("E_CONFLICT", "The webhook trigger is disarmed.", {
        reason: "disarmed",
      });
    }
    const body = parseObjectBody(input.rawBody);
    if (input.deliveryId !== undefined && !isDeliveryId(input.deliveryId)) {
      throw new DevChestraError("E_VALIDATION", "Delivery ID is invalid.");
    }
    const project = await this.#deps.getProject(runtime.projectId);
    if (project === null) throw missingProject();
    await this.#requireNewWorktree(this.#projectRoot(project));
    const start = startOfSnapshot(runtime.snapshot);
    if (start === null) {
      throw new DevChestraError("E_INTERNAL", "The armed workflow has no start node.");
    }
    const params = resolveWebhookParams(start, { body, headers: input.headers });
    if (!params.ok) {
      throw new DevChestraError(
        "E_VALIDATION",
        "The webhook payload does not satisfy the workflow parameters.",
        { issues: params.errors },
      );
    }
    const delivery: WebhookRunDelivery = {
      hookId: runtime.hookId,
      fingerprint: sha256Hex(input.rawBody),
      armedRevision: runtime.armedRevision,
      ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
    };
    let launch: WebhookRunLaunch;
    try {
      launch = await this.#deps.ports.runs.launch({
        projectId: runtime.projectId,
        workflowId: runtime.workflowId,
        snapshot: runtime.snapshot as NormalizedWorkflow,
        snapshotRaw: runtime.snapshotRaw,
        params: params.value as JsonObject,
        workspace: { mode: "new-worktree" },
        workflowDependencies: runtime.bundle,
        delivery,
      });
    } catch (error) {
      // Anything without a specific mapping is re-thrown for the ingress to map by code.
      throw launchError(error) ?? error;
    }
    // The ingress answers before the run finishes; a failed run must not surface as unhandled.
    void launch.completion.then(undefined, () => undefined);
    if (launch.duplicate) {
      const status = (await this.#deps.getRunStatus(launch.runId)) ?? "queued";
      return { status: 200, body: { runId: launch.runId, duplicate: true, status } };
    }
    return { status: 202, body: { runId: launch.runId, duplicate: false, status: "queued" } };
  }

  executionSettings(): ExecutionSettingsResponse {
    return { settings: this.#store.executionSettings.get(), limits: executionLimits() };
  }

  /** Saves the limits, then lets the engine start queued runs that now fit. */
  saveExecutionSettings(input: ExecutionSettings): ExecutionSettingsResponse {
    const settings = this.#store.executionSettings.set(input);
    try {
      this.#deps.ports.runs.pumpQueue();
    } catch {
      this.#log("queue pump after an execution settings change did not complete");
    }
    return { settings, limits: executionLimits() };
  }

  webhookSettings(): WebhookSettings {
    return this.#store.webhookSettings.get();
  }

  saveWebhookSettings(input: WebhookSettings): WebhookSettings {
    return this.#store.webhookSettings.set(input);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #log(line: string): void {
    this.#deps.log?.(line);
  }

  #statusBase(trigger: TriggerRecord | null, supported: boolean, origin: string): StatusBase {
    const prefix = this.#store.webhookSettings.get().publicBaseUrl ?? origin;
    return {
      supported,
      hookId: trigger?.hookId ?? null,
      url: trigger === null ? null : `${prefix}/webhooks/${trigger.hookId}`,
      armedRevision: trigger?.armedRevision ?? null,
      armedAt: trigger?.armedAt ?? null,
      lastDeliveryAt: trigger?.lastDeliveryAt ?? null,
      refreshError: trigger?.refreshError ?? null,
    };
  }

  #readSaved(project: WorkflowProject, workflowId: string): SavedRead {
    try {
      return { kind: "document", document: this.#deps.workflows.get(project, workflowId) };
    } catch (error) {
      const code = devchestraErrorCode(error);
      if (code === null) throw error;
      if (code === "E_NOT_FOUND") return { kind: "missing" };
      return {
        kind: "unreadable",
        error,
        code,
        issues: [{ code, message: messageOf(error) }],
      };
    }
  }

  #requireDocument(project: WorkflowProject, workflowId: string): WorkflowDocumentView {
    const saved = this.#readSaved(project, workflowId);
    if (saved.kind === "missing") {
      throw new DevChestraError("E_NOT_FOUND", `Workflow '${workflowId}' not found.`);
    }
    if (saved.kind === "unreadable") {
      if (saved.code === VALIDATION_CODE) throw invalidWorkflow(saved.issues);
      throw saved.error;
    }
    if (!saved.document.validation.ok) {
      throw invalidWorkflow(issuesOf(saved.document.validation.errors));
    }
    return saved.document;
  }

  #projectRoot(project: WorkflowProject): string {
    if (project.missing) throw missingProject();
    try {
      return assertProjectPathAllowed(project.path, this.#deps.dataDir);
    } catch (error) {
      if (devchestraErrorCode(error) === "E_NOT_FOUND") throw missingProject();
      throw error;
    }
  }

  async #requireNewWorktree(root: string): Promise<void> {
    try {
      await validateRunWorkspace(this.#deps.workspaceService, root, NEW_WORKTREE);
    } catch (error) {
      if (devchestraErrorCode(error) === "E_NOT_SUPPORTED") throw error;
      throw new DevChestraError(
        "E_CONFLICT",
        "Webhook runs need a Git project, because each run starts in a new worktree.",
        { reason: "project_not_git" },
      );
    }
  }

  /**
   * The transitive freeze a real run would perform: the saved root plus every child
   * the engine's walk reaches. The revision covers both, so a child change is seen.
   */
  async #frozen(
    project: WorkflowProject,
    workflowId: string,
    document: WorkflowDocumentView,
  ): Promise<FrozenRevision> {
    const prompts = [...workflowNodes(document.workflow.graph)].filter(
      (node) => node.type === "agent" && node.promptFile !== undefined,
    );
    if (prompts.length > 0) {
      throw new DevChestraError(
        "E_NOT_SUPPORTED",
        "promptFile is not supported for webhook triggers yet; inline the prompt and save.",
        { nodeIds: prompts.map((node) => node.id) },
      );
    }
    const normalized = normalizeWorkflow(document.workflow);
    if (!normalized.ok) {
      throw invalidWorkflow([
        {
          code: devchestraErrorCode(normalized.error) ?? VALIDATION_CODE,
          message: normalized.error.message,
        },
      ]);
    }
    const snapshot = normalized.value;
    let bundle: Record<string, unknown>;
    try {
      bundle = await this.#deps.ports.freeze.freeze(project.id, workflowId, snapshot);
    } catch (error) {
      const code = devchestraErrorCode(error);
      if (code === null) throw error;
      throw invalidWorkflow([{ code, message: messageOf(error) }]);
    }
    const revision = await hashJson({ snapshot, bundle });
    return { snapshot, bundle, revision };
  }

  /** Caller holds the project's workflow lock. */
  async #refreshArmed(project: WorkflowProject, workflowId: string): Promise<void> {
    const trigger = this.#store.webhooks.trigger(project.id, workflowId);
    if (trigger === null || !trigger.armed || trigger.armedRevision === null) throw notArmed();
    let document: WorkflowDocumentView;
    let frozen: FrozenRevision;
    try {
      document = this.#requireDocument(project, workflowId);
      if (!declaresWebhook(document.workflow)) throw notSupported();
      frozen = await this.#frozen(project, workflowId, document);
    } catch (error) {
      this.#store.webhooks.setRefreshError(trigger.hookId, refreshFailureMessage(error));
      throw error;
    }
    const replaced = this.#store.webhooks.replaceRevision(trigger.hookId, trigger.armedRevision, {
      armedRevision: frozen.revision,
      snapshot: frozen.snapshot,
      snapshotRaw: document.text,
      bundle: frozen.bundle,
    });
    if (!replaced) {
      const current = this.#store.webhooks.trigger(project.id, workflowId);
      throw new DevChestraError(
        "E_CONFLICT",
        "The webhook trigger changed while it was refreshing. Retry the refresh.",
        { reason: current?.armed === true ? "revision_changed" : "not_armed" },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "The request could not be completed.";
}

function refreshFailureMessage(error: unknown): string {
  const text =
    devchestraErrorCode(error) === null
      ? "The saved workflow could not be frozen for refresh."
      : messageOf(error);
  return text.slice(0, REFRESH_MESSAGE_MAX);
}

function issuesOf(
  errors: readonly { readonly code: string; readonly message: string }[],
): WebhookIssue[] {
  return errors.map((issue) => ({ code: issue.code, message: issue.message }));
}

function invalidWorkflow(issues: readonly WebhookIssue[]): DevChestraError {
  const first = issues[0]?.message ?? "unknown error";
  return new DevChestraError("E_WORKFLOW_INVALID", `Workflow is invalid: ${first}`, {
    issues: [...issues],
  });
}

function notSupported(): DevChestraError {
  return new DevChestraError(
    "E_CONFLICT",
    "This workflow does not enable webhook triggers. Set webhook.enabled on its start node and save it.",
    { reason: "not_supported" },
  );
}

function notArmed(): DevChestraError {
  return new DevChestraError("E_CONFLICT", "The webhook trigger is not armed.", {
    reason: "not_armed",
  });
}

function missingProject(): DevChestraError {
  return new DevChestraError(
    "E_CONFLICT",
    "Project path is missing; relink the project before using webhook triggers.",
    { reason: "project_missing" },
  );
}

function declaresWebhook(workflow: WorkflowFile): boolean {
  const start = workflow.graph.nodes.find((node) => node.type === "start");
  return start?.type === "start" && start.webhook?.enabled === true;
}

function startOfSnapshot(snapshot: unknown): NormalizedStartNode | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph) || !Array.isArray(snapshot.graph.nodes)) {
    return null;
  }
  for (const node of snapshot.graph.nodes) {
    if (isRecord(node) && node.type === "start") return node as unknown as NormalizedStartNode;
  }
  return null;
}

function executionLimits(): ExecutionSettingsResponse["limits"] {
  const bounds = (key: "maxConcurrentRuns" | "maxQueueDepth") => ({
    min: EXECUTION_LIMITS[key].min,
    max: EXECUTION_LIMITS[key].max,
    default: EXECUTION_LIMITS[key].fallback,
  });
  return { maxConcurrentRuns: bounds("maxConcurrentRuns"), maxQueueDepth: bounds("maxQueueDepth") };
}

/**
 * A valid HMAC-SHA256 of the raw body, keyed by the trigger's secret, in one of the
 * accepted signature headers. This is the only credential a sender needs (GitHub's
 * `X-Hub-Signature-256`). The comparison is constant-time.
 */
function authenticates(runtime: TriggerRuntime, input: WebhookDeliveryInput): boolean {
  const provided = input.signatures
    .map((value) => signatureFromHeader(value))
    .filter((value): value is string => value !== null);
  if (provided.length === 0) return false;
  const expected = hmacSha256Hex(runtime.signingSecret, input.rawBody);
  return provided.some((candidate) => digestEquals(candidate, expected));
}

function parseObjectBody(raw: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new DevChestraError("E_VALIDATION", "Webhook body must be valid UTF-8 JSON.");
  }
  if (!isRecord(parsed)) {
    throw new DevChestraError("E_VALIDATION", "Webhook body must be a JSON object.");
  }
  return parsed;
}

/**
 * Maps the engine refusals that need a specific wire shape: queue-full (with its
 * Retry-After), conflicts (with their reason) and provider or workflow validation.
 * Null for every other refusal, which the ingress maps through the API error table.
 */
function launchError(error: unknown): DevChestraError | null {
  if (error instanceof DevChestraError) return error;
  const code = devchestraErrorCode(error);
  if (code === "E_QUEUE_FULL") {
    return new DevChestraError("E_QUEUE_FULL", "The run queue is full. Retry the delivery later.");
  }
  if (code === "E_CONFLICT") {
    const reason = reasonOf(error);
    return new DevChestraError(
      "E_CONFLICT",
      messageOf(error),
      reason === undefined ? undefined : { reason },
    );
  }
  if (code === "E_CLI_DISABLED" || code === "E_WORKFLOW_INVALID" || code === "E_VALIDATION") {
    return new DevChestraError(code, messageOf(error));
  }
  return null;
}

function reasonOf(error: unknown): string | undefined {
  const details = (error as { details?: unknown }).details;
  return isRecord(details) && typeof details.reason === "string" ? details.reason : undefined;
}
