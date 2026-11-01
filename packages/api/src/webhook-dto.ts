import { z } from "./zod.js";

const strict = z.strictObject;

// ---------------------------------------------------------------------------
// Webhook triggers (per saved workflow) and execution settings (global)
// ---------------------------------------------------------------------------

/**
 * off: not armed. current: armed and matching the saved workflow.
 * stale: armed, but the saved workflow or a child changed since arming (refresh to apply).
 * invalid: armed, but the saved workflow is invalid or no longer declares webhook support.
 * The last valid armed revision keeps running in the stale and invalid states.
 */
export const webhookTriggerStateSchema = z.enum(["off", "current", "stale", "invalid"]);
export type WebhookTriggerState = z.infer<typeof webhookTriggerStateSchema>;

export const webhookIssueSchema = strict({
  code: z.string(),
  message: z.string(),
});
export type WebhookIssue = z.infer<typeof webhookIssueSchema>;

export const webhookTriggerStatusSchema = strict({
  /** Whether the saved workflow's start node declares webhook support. */
  supported: z.boolean(),
  armed: z.boolean(),
  state: webhookTriggerStateSchema,
  /** Null until the first arm. Stable across disarm, rotate and re-arm. */
  hookId: z.string().nullable(),
  /** Copyable delivery URL, built from the public base URL when one is set. */
  url: z.string().nullable(),
  armedRevision: z.string().nullable(),
  armedAt: z.number().nullable(),
  lastDeliveryAt: z.number().nullable(),
  /** The last automatic refresh failure after a valid save, cleared by the next success. */
  refreshError: z.string().nullable(),
  /** Saved-workflow issues when state is invalid. Empty otherwise. */
  issues: z.array(webhookIssueSchema),
});
export type WebhookTriggerStatus = z.infer<typeof webhookTriggerStatusSchema>;

export const webhookSecretsSchema = strict({
  bearerToken: z.string(),
  signingSecret: z.string(),
});
export type WebhookSecrets = z.infer<typeof webhookSecretsSchema>;

export const webhookTriggerResponseSchema = strict({
  status: webhookTriggerStatusSchema,
  /** Plaintext credentials. Present only in the response that created or rotated them. */
  secrets: webhookSecretsSchema.nullable(),
});
export type WebhookTriggerResponse = z.infer<typeof webhookTriggerResponseSchema>;

/** Response of the public ingress route. 202 for a new run, 200 for a duplicate delivery. */
export const webhookDeliveryResponseSchema = strict({
  runId: z.string(),
  duplicate: z.boolean(),
  status: z.string(),
});
export type WebhookDeliveryResponse = z.infer<typeof webhookDeliveryResponseSchema>;

export const executionSettingsSchema = strict({
  maxConcurrentRuns: z.number().int().min(1).max(32),
  maxQueueDepth: z.number().int().min(10).max(1000),
});
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;

const limitSchema = strict({
  min: z.number().int(),
  max: z.number().int(),
  default: z.number().int(),
});

export const executionSettingsResponseSchema = strict({
  settings: executionSettingsSchema,
  limits: strict({
    maxConcurrentRuns: limitSchema,
    maxQueueDepth: limitSchema,
  }),
});
export type ExecutionSettingsResponse = z.infer<typeof executionSettingsResponseSchema>;

export const webhookSettingsSchema = strict({
  /** Origin and optional path prefix for copyable URLs, e.g. https://hooks.example.com. */
  publicBaseUrl: z.string().max(2048).nullable(),
});
export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;

/** Header names the public ingress reads its delivery ID from, in precedence order. */
export const WEBHOOK_DELIVERY_ID_HEADERS = [
  "x-github-delivery",
  "x-webhook-id",
  "idempotency-key",
] as const;
