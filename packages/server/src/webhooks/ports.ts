import type { JsonObject, RunWorkspaceSelection } from "@devchestra/core";
import type { NormalizedWorkflow } from "@devchestra/schema";
import type { ExecutionSettingsApi, WebhookSettingsApi, WebhooksApi } from "@devchestra/store";

/** Identity and armed revision of one accepted webhook delivery. */
export interface WebhookRunDelivery {
  readonly hookId: string;
  /** Absent when the provider sent no delivery ID: no dedupe, but the armed check still runs. */
  readonly deliveryId?: string;
  /** sha256 of the raw body, lowercase hex. */
  readonly fingerprint: string;
  readonly armedRevision: string;
}

/** A run the webhook ingress asks the engine to queue. Always a new worktree. */
export interface WebhookRunCommand {
  readonly projectId: string;
  readonly workflowId: string;
  readonly snapshot: NormalizedWorkflow;
  readonly snapshotRaw: string;
  readonly params: JsonObject;
  readonly workspace: RunWorkspaceSelection;
  /** The armed transitive child bundle. Passing it keeps the run on the armed revision. */
  readonly workflowDependencies: Readonly<Record<string, unknown>>;
  readonly delivery: WebhookRunDelivery;
}

export interface WebhookRunLaunch {
  readonly runId: string;
  readonly duplicate: boolean;
  /** Settles when the run finishes. The ingress never awaits it. */
  readonly completion: Promise<unknown>;
}

/** Engine access for webhook runs. `launch` throws the engine's DevChestraError when refused. */
export interface BrowserWebhookRunPort {
  launch(input: WebhookRunCommand): Promise<WebhookRunLaunch>;
  /** Starts queued runs that fit under a changed concurrency limit. */
  pumpQueue(): void;
}

/**
 * The transitive child freeze the engine runs for a managed run. Arm and refresh
 * call it so the armed bundle matches what a real run would freeze. Resolves to
 * the id -> normalized snapshot map.
 */
export interface BrowserWebhookFreezePort {
  freeze(
    projectId: string,
    workflowId: string,
    snapshot: NormalizedWorkflow,
  ): Promise<Record<string, unknown>>;
}

/** Everything the webhook surface needs from the composition root. */
export interface BrowserWebhookPorts {
  /** The store, narrowed to the webhook, execution and webhook-settings APIs. */
  readonly store: {
    readonly webhooks: WebhooksApi;
    readonly executionSettings: ExecutionSettingsApi;
    readonly webhookSettings: WebhookSettingsApi;
  };
  readonly runs: BrowserWebhookRunPort;
  readonly freeze: BrowserWebhookFreezePort;
}
