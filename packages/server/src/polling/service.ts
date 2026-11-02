import { randomBytes } from "node:crypto";
import {
  POLL_INTERVAL_LIMITS as LIMITS,
  type PollIssue,
  type PollProbeResult,
  type PollTriggerState,
  type PollTriggerStatus,
  type RunWorkspaceSelection,
} from "@devchestra/api";
import { isRecord } from "@devchestra/core";
import {
  type NormalizedStartNode,
  type NormalizedWorkflow,
  normalizeWorkflow,
  type PollProbeOutput,
  pollProbeTimeoutMin,
  resolvePollResult,
  type WorkflowFile,
  workflowNodes,
} from "@devchestra/schema";
import type { PollTriggerRecord } from "@devchestra/store";
import type { BrowserWorkspacePort, ProjectView } from "../browser/ports.js";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { validateRunWorkspace } from "../browser/workspaces.js";
import { DevChestraError, devchestraErrorCode } from "../errors.js";
import { hashJson } from "../hash.js";
import type {
  ManagedWorkflowService,
  WorkflowDocumentView,
  WorkflowProject,
} from "../workflows/service.js";
import type { BrowserPollPorts } from "./ports.js";

const NEW_WORKTREE: RunWorkspaceSelection = { mode: "new-worktree" };
const REFRESH_MESSAGE_MAX = 500;
const VALIDATION_CODE = "E_VALIDATION";
/** Upper bound for an on-demand probe-now run. Armed ticks are bound by their interval. */
const PROBE_NOW_TIMEOUT_MS = 5 * 60 * 1000;

/** `pol_` plus 16 random bytes in base64url. Poller IDs are routing keys, not credentials. */
export function newPollerId(): string {
  return `pol_${randomBytes(16).toString("base64url")}`;
}

export interface PollServiceDeps {
  readonly ports: BrowserPollPorts;
  readonly workflows: ManagedWorkflowService;
  readonly dataDir: string;
  readonly getProject: (projectId: string) => ProjectView | null | Promise<ProjectView | null>;
  readonly workspaceService?: BrowserWorkspacePort | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

type SavedRead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "unreadable";
      readonly error: unknown;
      readonly code: string;
      readonly issues: PollIssue[];
    }
  | { readonly kind: "document"; readonly document: WorkflowDocumentView };

interface FrozenRevision {
  readonly snapshot: NormalizedWorkflow;
  readonly bundle: Record<string, unknown>;
  readonly revision: string;
}

/**
 * Polling trigger lifecycle for saved workflows, plus the on-demand probe.
 * The timer lives in the scheduler; every state change goes through the
 * store's transactional methods. Modelled on the webhook service: the freeze,
 * revision and saved-file helpers below are minimal copies kept local so the
 * webhook path stays untouched.
 */
export class PollService {
  readonly #deps: PollServiceDeps;

  constructor(deps: PollServiceDeps) {
    this.#deps = deps;
  }

  get #store(): BrowserPollPorts["store"] {
    return this.#deps.ports.store;
  }

  async status(project: WorkflowProject, workflowId: string): Promise<PollTriggerStatus> {
    const trigger = this.#store.pollTriggers.trigger(project.id, workflowId);
    const saved = this.#readSaved(project, workflowId);
    if (saved.kind === "missing" && trigger === null) {
      throw new DevChestraError("E_NOT_FOUND", `Workflow '${workflowId}' not found.`);
    }
    const supported = saved.kind === "document" && declaresPolling(saved.document.workflow);
    const base = this.#statusBase(trigger, supported);
    if (trigger === null || !trigger.armed) {
      return { ...base, armed: false, state: "off", issues: [] };
    }
    const invalid = (issues: PollIssue[]): PollTriggerStatus => ({
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
          code: "E_POLL_NOT_ENABLED",
          message: "The saved workflow no longer enables polling triggers.",
        },
      ]);
    }
    let state: PollTriggerState;
    try {
      const frozen = await this.#frozen(project, workflowId, document);
      if (frozen.revision !== trigger.armedRevision) state = "stale";
      else if (trigger.lastOutcome === "failed") state = "failing";
      else state = "current";
    } catch (error) {
      const code = devchestraErrorCode(error);
      if (code === null) throw error;
      return invalid([{ code, message: messageOf(error) }]);
    }
    return { ...base, armed: true, state, issues: [] };
  }

  /**
   * Arms the saved workflow with an interval. Arming again with a new interval
   * updates it; the poller row is created on the first arm only.
   */
  async arm(
    project: WorkflowProject,
    workflowId: string,
    intervalSeconds: number,
  ): Promise<PollTriggerStatus> {
    return this.#deps.workflows.exclusive(project, async () => {
      const document = this.#requireDocument(project, workflowId);
      const polling = pollingOf(document.workflow);
      if (polling === null) throw notSupported();
      checkInterval(polling.probe.type, intervalSeconds);
      await this.#requireNewWorktree(this.#projectRoot(project));
      const frozen = await this.#frozen(project, workflowId, document);
      const existing = this.#store.pollTriggers.trigger(project.id, workflowId);
      let pollerId: string;
      if (existing === null) {
        pollerId = newPollerId();
        this.#store.pollTriggers.create({ pollerId, projectId: project.id, workflowId });
      } else {
        pollerId = existing.pollerId;
      }
      this.#store.pollTriggers.arm(pollerId, {
        armedRevision: frozen.revision,
        snapshot: frozen.snapshot,
        snapshotRaw: document.text,
        bundle: frozen.bundle,
        intervalSeconds,
      });
      return this.status(project, workflowId);
    });
  }

  /** Disarms the trigger. Idempotent: a workflow with no trigger reports `off`. */
  async disarm(project: WorkflowProject, workflowId: string): Promise<PollTriggerStatus> {
    const trigger = this.#store.pollTriggers.trigger(project.id, workflowId);
    if (trigger?.armed === true) this.#store.pollTriggers.disarm(trigger.pollerId);
    return this.status(project, workflowId);
  }

  /** Re-freezes an armed trigger from the saved files. Keeps the old revision on failure. */
  async refresh(project: WorkflowProject, workflowId: string): Promise<PollTriggerStatus> {
    await this.#deps.workflows.exclusive(project, () => this.#refreshArmed(project, workflowId));
    return this.status(project, workflowId);
  }

  /**
   * Runs one probe against the SAVED workflow, armed or not. It never starts a
   * workflow run and never writes a dedupe claim, and it counts toward neither
   * the failure streak nor `lastTickAt`.
   */
  async probeNow(project: WorkflowProject, workflowId: string): Promise<PollProbeResult> {
    const began = Date.now();
    const finish = (result: Omit<PollProbeResult, "durationMs">): PollProbeResult => ({
      ...result,
      durationMs: Date.now() - began,
    });
    const document = this.#requireDocument(project, workflowId);
    const polling = pollingOf(document.workflow);
    if (polling === null) throw notSupported();
    const normalized = normalizeWorkflow(document.workflow);
    if (!normalized.ok) {
      throw invalidWorkflow([
        {
          code: devchestraErrorCode(normalized.error) ?? VALIDATION_CODE,
          message: normalized.error.message,
        },
      ]);
    }
    const start = startOfSnapshot(normalized.value);
    if (start === null || start.polling === undefined) throw notSupported();
    const probe = start.polling.probe;
    const timeoutMs = Math.min(pollProbeTimeoutMin(probe) * 60_000, PROBE_NOW_TIMEOUT_MS);
    let raw: PollProbeOutput;
    try {
      const outcome = await this.#deps.ports.runs.probe({
        projectId: project.id,
        workflowId,
        snapshot: normalized.value,
        probe,
        workspace: start.polling.workspace ?? "project",
        timeoutMs,
        timeoutMin: Math.max(1, Math.min(480, Math.floor(timeoutMs / 60_000))),
      });
      raw = outcome.raw;
    } catch (error) {
      return finish({
        outcome: "failed",
        params: null,
        dedupeKey: null,
        wouldSkipAsDuplicate: false,
        error: messageOf(error),
      });
    }
    const resolved = resolvePollResult(start, raw);
    if (!resolved.ok) {
      return finish({
        outcome: "failed",
        params: null,
        dedupeKey: null,
        wouldSkipAsDuplicate: false,
        error: resolved.error.message,
      });
    }
    if (!resolved.value.found) {
      return finish({
        outcome: "nothing",
        params: null,
        dedupeKey: null,
        wouldSkipAsDuplicate: false,
        error: null,
      });
    }
    const key = resolved.value.dedupeKey ?? hashJson(resolved.value.params);
    return finish({
      outcome: "found",
      params: resolved.value.params as PollProbeResult["params"],
      dedupeKey: key,
      wouldSkipAsDuplicate: this.#wouldSkip(project.id, workflowId, start, key),
      error: null,
    });
  }

  /**
   * Best-effort refresh after a successful save of the root workflow. A failure is
   * recorded on the trigger and never reaches the save response.
   */
  async afterSave(project: WorkflowProject, workflowId: string): Promise<void> {
    try {
      await this.#deps.workflows.exclusive(project, async () => {
        const trigger = this.#store.pollTriggers.trigger(project.id, workflowId);
        if (trigger?.armed !== true) return;
        await this.#refreshArmed(project, workflowId);
      });
    } catch {
      this.#log(`polling refresh after save did not complete for workflow ${workflowId}`);
    }
  }

  /**
   * A deleted workflow must not keep an armed poller running its last revision.
   * The poller row goes too, so its dedupe claims stop applying and a recreated
   * workflow gets a fresh poller.
   */
  afterDelete(project: WorkflowProject, workflowId: string): void {
    const trigger = this.#store.pollTriggers.trigger(project.id, workflowId);
    if (trigger !== null) this.#store.pollTriggers.remove(trigger.pollerId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #log(line: string): void {
    this.#deps.log?.(line);
  }

  #statusBase(
    trigger: PollTriggerRecord | null,
    supported: boolean,
  ): Omit<PollTriggerStatus, "armed" | "state" | "issues"> {
    return {
      supported,
      intervalSeconds: trigger?.intervalSeconds ?? null,
      armedRevision: trigger?.armedRevision ?? null,
      armedAt: trigger?.armedAt ?? null,
      nextDueAt: trigger?.nextDueAt ?? null,
      lastTickAt: trigger?.lastTickAt ?? null,
      lastOutcome: trigger?.lastOutcome ?? null,
      lastRunId: trigger?.lastRunId ?? null,
      consecutiveFailures: trigger?.consecutiveFailures ?? 0,
      lastError: trigger?.lastError ?? null,
      refreshError: trigger?.refreshError ?? null,
    };
  }

  /** Read-only duplicate check for probe-now: never writes a claim. */
  #wouldSkip(
    projectId: string,
    workflowId: string,
    start: NormalizedStartNode,
    key: string,
  ): boolean {
    if (start.polling?.dedupe === false) return false;
    const trigger = this.#store.pollTriggers.trigger(projectId, workflowId);
    if (trigger === null) return false;
    return this.#store.pollTriggers.dedupeRunFor(trigger.pollerId, key) !== null;
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
        "Polling runs need a Git project, because each run starts in a new worktree.",
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
        "promptFile is not supported for polling triggers yet; inline the prompt and save.",
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
    const revision = hashJson({ snapshot, bundle });
    return { snapshot, bundle, revision };
  }

  /** Caller holds the project's workflow lock. */
  async #refreshArmed(project: WorkflowProject, workflowId: string): Promise<void> {
    const trigger = this.#store.pollTriggers.trigger(project.id, workflowId);
    if (trigger === null || !trigger.armed || trigger.armedRevision === null) throw notArmed();
    let document: WorkflowDocumentView;
    let frozen: FrozenRevision;
    try {
      document = this.#requireDocument(project, workflowId);
      if (pollingOf(document.workflow) === null) throw notSupported();
      frozen = await this.#frozen(project, workflowId, document);
    } catch (error) {
      this.#store.pollTriggers.setRefreshError(trigger.pollerId, refreshFailureMessage(error));
      throw error;
    }
    const replaced = this.#store.pollTriggers.replaceRevision(
      trigger.pollerId,
      trigger.armedRevision,
      {
        armedRevision: frozen.revision,
        snapshot: frozen.snapshot,
        snapshotRaw: document.text,
        bundle: frozen.bundle,
        intervalSeconds: trigger.intervalSeconds ?? 60,
      },
    );
    if (!replaced) {
      const current = this.#store.pollTriggers.trigger(project.id, workflowId);
      throw new DevChestraError(
        "E_CONFLICT",
        "The polling trigger changed while it was refreshing. Retry the refresh.",
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
): PollIssue[] {
  return errors.map((issue) => ({ code: issue.code, message: issue.message }));
}

function invalidWorkflow(issues: readonly PollIssue[]): DevChestraError {
  const first = issues[0]?.message ?? "unknown error";
  return new DevChestraError("E_WORKFLOW_INVALID", `Workflow is invalid: ${first}`, {
    issues: [...issues],
  });
}

function notSupported(): DevChestraError {
  return new DevChestraError(
    "E_CONFLICT",
    "This workflow does not enable polling triggers. Set polling.enabled on its start node and save it.",
    { reason: "not_supported" },
  );
}

function notArmed(): DevChestraError {
  return new DevChestraError("E_CONFLICT", "The polling trigger is not armed.", {
    reason: "not_armed",
  });
}

function missingProject(): DevChestraError {
  return new DevChestraError(
    "E_CONFLICT",
    "Project path is missing; relink the project before using polling triggers.",
    { reason: "project_missing" },
  );
}

function declaresPolling(workflow: WorkflowFile): boolean {
  return pollingOf(workflow) !== null;
}

function pollingOf(workflow: WorkflowFile): { probe: { type: "shell" | "agent" } } | null {
  const start = workflow.graph.nodes.find((node) => node.type === "start");
  if (start?.type !== "start" || start.polling?.enabled !== true) return null;
  return { probe: { type: start.polling.probe.type } };
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

function checkInterval(probeType: "shell" | "agent", intervalSeconds: number): void {
  const bounds = LIMITS[probeType];
  if (
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < bounds.min ||
    intervalSeconds > bounds.max
  ) {
    throw new DevChestraError(
      "E_VALIDATION",
      `intervalSeconds must be a whole number of seconds from ${bounds.min} to ${bounds.max} for ${probeType} probes.`,
    );
  }
}
