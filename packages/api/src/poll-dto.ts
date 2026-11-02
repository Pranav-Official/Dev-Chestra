import { z } from "./zod.js";

const strict = z.strictObject;

// ---------------------------------------------------------------------------
// Polling triggers (per saved workflow)
// ---------------------------------------------------------------------------

/** Interval bounds in seconds. A shell probe may poll faster than an agent probe. */
export const POLL_INTERVAL_LIMITS = {
  shell: { min: 10, max: 86_400 },
  agent: { min: 60, max: 86_400 },
} as const;

/** Consecutive probe failures after which an armed poller disarms itself. */
export const POLL_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * off: not armed. current: armed and matching the saved workflow.
 * stale: armed, but the saved workflow or a child changed since arming (refresh to apply).
 * invalid: armed, but the saved workflow is invalid or no longer declares polling.
 * failing: armed and current, but the last probe failed. The poller keeps trying until it auto-disarms.
 * The last valid armed revision keeps polling in the stale and invalid states.
 */
export const pollTriggerStateSchema = z.enum(["off", "current", "stale", "invalid", "failing"]);
export type PollTriggerState = z.infer<typeof pollTriggerStateSchema>;

export const pollIssueSchema = strict({
  code: z.string(),
  message: z.string(),
});
export type PollIssue = z.infer<typeof pollIssueSchema>;

/** What the last probe tick did. `skipped` means a previous probe was still running. */
export const pollOutcomeSchema = z.enum(["nothing", "triggered", "duplicate", "failed", "skipped"]);
export type PollOutcome = z.infer<typeof pollOutcomeSchema>;

export const pollTriggerStatusSchema = strict({
  /** Whether the saved workflow's start node declares polling. */
  supported: z.boolean(),
  armed: z.boolean(),
  state: pollTriggerStateSchema,
  /** Null until the first arm. Kept across disarm and re-arm. */
  intervalSeconds: z.number().int().nullable(),
  armedRevision: z.string().nullable(),
  armedAt: z.number().nullable(),
  /** When the next probe is due, or null when not armed. */
  nextDueAt: z.number().nullable(),
  lastTickAt: z.number().nullable(),
  lastOutcome: pollOutcomeSchema.nullable(),
  /** Run started by the last `triggered` tick. */
  lastRunId: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  /** Last probe failure, or the reason the poller disarmed itself. Cleared by the next success. */
  lastError: z.string().nullable(),
  /** The last automatic refresh failure after a valid save, cleared by the next success. */
  refreshError: z.string().nullable(),
  /** Saved-workflow issues when state is invalid. Empty otherwise. */
  issues: z.array(pollIssueSchema),
});
export type PollTriggerStatus = z.infer<typeof pollTriggerStatusSchema>;

export const pollArmRequestSchema = strict({
  intervalSeconds: z.number().int().min(POLL_INTERVAL_LIMITS.shell.min).max(86_400),
});
export type PollArmRequest = z.infer<typeof pollArmRequestSchema>;

/** Result of `probe-now`: one probe, run on demand. It never starts a workflow run. */
export const pollProbeResultSchema = strict({
  outcome: z.enum(["nothing", "found", "failed"]),
  /** The start parameters the probe returned, when outcome is `found`. */
  params: z.record(z.string(), z.unknown()).nullable(),
  dedupeKey: z.string().nullable(),
  /** Whether a real tick would skip this result as a repeat. */
  wouldSkipAsDuplicate: z.boolean(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});
export type PollProbeResult = z.infer<typeof pollProbeResultSchema>;
