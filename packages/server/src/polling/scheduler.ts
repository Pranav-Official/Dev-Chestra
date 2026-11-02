import { POLL_MAX_CONSECUTIVE_FAILURES } from "@devchestra/api";
import type { JsonObject } from "@devchestra/core";
import {
  type NormalizedStartNode,
  type NormalizedWorkflow,
  resolvePollResult,
} from "@devchestra/schema";
import type { PollTriggerRuntime } from "@devchestra/store";
import { devchestraErrorCode } from "../errors.js";
import { hashJson } from "../hash.js";
import type { BrowserPollPorts, PollProbeOutcome } from "./ports.js";

/** Probe runs kept per workflow when ticks keep triggering. Quiet ticks delete theirs. */
export const POLL_PROBE_RUN_KEEP = 20;

export interface PollSchedulerDeps {
  readonly ports: BrowserPollPorts;
  readonly now?: () => number;
  readonly tickIntervalMs?: number;
  readonly log?: ((line: string) => void) | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "The request could not be completed.";
}

function startOfSnapshot(snapshot: unknown): NormalizedStartNode | null {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("graph" in snapshot) ||
    typeof (snapshot as { graph?: unknown }).graph !== "object"
  ) {
    return null;
  }
  const nodes = (snapshot as { graph: { nodes?: unknown } }).graph.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (
      typeof node === "object" &&
      node !== null &&
      (node as { type?: unknown }).type === "start"
    ) {
      return node as NormalizedStartNode;
    }
  }
  return null;
}

/**
 * Owns the polling timer. Each loop reads the due pollers, probes them with
 * single-flight per workflow, and records the tick: probe -> resolve ->
 * dedupe claim (unless off) -> launch on the armed snapshot -> recordTick.
 * A tick never throws; failures are recorded on the poller and logged.
 */
export class PollScheduler {
  readonly #deps: PollSchedulerDeps;
  readonly #inflight = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: PollSchedulerDeps) {
    this.#deps = deps;
  }

  get #ports(): BrowserPollPorts {
    return this.#deps.ports;
  }

  get #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #log(line: string): void {
    this.#deps.log?.(line);
  }

  /**
   * Starts the timer. Armed pollers that missed more than a full interval
   * while down skip the catch-up and resume on schedule; the rest probe on
   * their next loop. Idempotent.
   */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#bootReschedule();
    const intervalMs = this.#deps.tickIntervalMs ?? 1000;
    this.#timer = setInterval(() => {
      void this.tick(this.#now).catch((error: unknown) => {
        this.#log(`poll tick failed: ${messageOf(error)}`);
      });
    }, intervalMs);
    this.#timer.unref?.();
  }

  /** Stops the timer. In-flight ticks drain through the engine shutdown. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #bootReschedule(): void {
    const now = this.#now;
    let due: PollTriggerRuntime[];
    try {
      due = this.#ports.store.pollTriggers.listDue(now);
    } catch (error) {
      this.#log(`poll boot reschedule did not complete: ${messageOf(error)}`);
      return;
    }
    for (const runtime of due) {
      const intervalMs = (runtime.intervalSeconds ?? 0) * 1000;
      if (
        runtime.nextDueAt === null ||
        runtime.intervalSeconds === null ||
        runtime.nextDueAt + intervalMs > now
      ) {
        continue;
      }
      try {
        this.#ports.store.pollTriggers.recordTick(
          runtime.pollerId,
          { outcome: "skipped" },
          POLL_MAX_CONSECUTIVE_FAILURES,
        );
      } catch (error) {
        this.#log(
          `poll boot skip for workflow ${runtime.workflowId} did not complete: ${messageOf(error)}`,
        );
      }
    }
  }

  /** Runs one scheduling pass over every due poller. Exposed for tests. */
  async tick(now: number): Promise<void> {
    let due: PollTriggerRuntime[];
    try {
      due = this.#ports.store.pollTriggers.listDue(now);
    } catch (error) {
      this.#log(`poll tick did not complete: ${messageOf(error)}`);
      return;
    }
    const pending: Promise<void>[] = [];
    for (const runtime of due) {
      if (this.#inflight.has(runtime.pollerId)) {
        this.#record(runtime, { outcome: "skipped" });
        continue;
      }
      this.#inflight.add(runtime.pollerId);
      pending.push(
        this.#runTick(runtime).finally(() => {
          this.#inflight.delete(runtime.pollerId);
        }),
      );
    }
    await Promise.allSettled(pending);
  }

  async #runTick(runtime: PollTriggerRuntime): Promise<void> {
    const start = startOfSnapshot(runtime.snapshot);
    const polling = start?.polling;
    if (start === null || polling === undefined) {
      this.#record(runtime, {
        outcome: "failed",
        error: "The armed polling revision has no start polling probe.",
      });
      return;
    }
    const probe = polling.probe;
    const intervalSeconds = runtime.intervalSeconds;
    if (intervalSeconds === null) {
      this.#record(runtime, { outcome: "failed", error: "The armed poller has no interval." });
      return;
    }
    // The probe deadline stays below the interval; the node timeout is a backstop.
    const configuredMs = (probe.timeoutMin ?? (probe.type === "agent" ? 30 : 10)) * 60_000;
    const timeoutMs = Math.max(1000, Math.min(configuredMs, intervalSeconds * 1000 - 1000));
    let probeOutcome: PollProbeOutcome;
    try {
      probeOutcome = await this.#ports.runs.probe({
        projectId: runtime.projectId,
        workflowId: runtime.workflowId,
        snapshot: runtime.snapshot as NormalizedWorkflow,
        probe,
        workspace: polling.workspace ?? "project",
        timeoutMs,
        timeoutMin: Math.max(1, Math.min(480, Math.floor(timeoutMs / 60_000))),
      });
    } catch (error) {
      // A disarm that lands mid-probe wins: the tick records nothing.
      if (this.#stillArmed(runtime)) {
        this.#record(runtime, { outcome: "failed", error: messageOf(error) });
      }
      this.#prune(runtime);
      return;
    }
    const armed = this.#stillArmed(runtime);
    const resolved = resolvePollResult(start, probeOutcome.raw);
    if (!resolved.ok) {
      if (armed) this.#record(runtime, { outcome: "failed", error: resolved.error.message });
      this.#prune(runtime);
      return;
    }
    if (!resolved.value.found) {
      if (armed) this.#record(runtime, { outcome: "nothing" });
      // A quiet tick deletes its probe run instead of keeping it.
      try {
        this.#ports.store.runs.deleteProbeRun(probeOutcome.runId as never);
      } catch (error) {
        this.#log(`poll probe run purge did not complete: ${messageOf(error)}`);
      }
      return;
    }
    if (!armed) {
      try {
        this.#ports.store.runs.deleteProbeRun(probeOutcome.runId as never);
      } catch (error) {
        this.#log(`poll probe run purge did not complete: ${messageOf(error)}`);
      }
      return;
    }
    const key = resolved.value.dedupeKey ?? hashJson(resolved.value.params);
    if (polling.dedupe !== false) {
      let claimed: { kind: "claimed" } | { kind: "duplicate"; runId: string };
      try {
        claimed = this.#ports.store.pollTriggers.claimDedupe(runtime.pollerId, key);
      } catch (error) {
        this.#record(runtime, { outcome: "failed", error: messageOf(error) });
        this.#prune(runtime);
        return;
      }
      if (claimed.kind === "duplicate") {
        this.#record(runtime, { outcome: "duplicate" });
        this.#prune(runtime);
        return;
      }
      await this.#trigger(runtime, resolved.value.params, key);
      return;
    }
    await this.#trigger(runtime, resolved.value.params, null);
  }

  async #trigger(
    runtime: PollTriggerRuntime,
    params: Record<string, unknown>,
    dedupeKey: string | null,
  ): Promise<void> {
    let runId: string;
    try {
      const launched = await this.#ports.runs.launch({
        projectId: runtime.projectId,
        workflowId: runtime.workflowId,
        snapshot: runtime.snapshot as NormalizedWorkflow,
        snapshotRaw: runtime.snapshotRaw ?? JSON.stringify(runtime.snapshot),
        params: params as JsonObject,
        workspace: { mode: "new-worktree" },
        workflowDependencies: runtime.bundle,
      });
      runId = launched.runId;
      // Ticks never await runs; a failed run must not surface as unhandled.
      void launched.completion.then(undefined, () => undefined);
    } catch (error) {
      this.#record(runtime, { outcome: "failed", error: messageOf(error) });
      this.#prune(runtime);
      return;
    }
    if (dedupeKey !== null) {
      try {
        this.#ports.store.pollTriggers.bindDedupe(runtime.pollerId, dedupeKey, runId);
      } catch (error) {
        this.#log(`poll dedupe bind did not complete: ${messageOf(error)}`);
      }
    }
    this.#record(runtime, { outcome: "triggered", runId });
    this.#prune(runtime);
  }

  #record(
    runtime: PollTriggerRuntime,
    tick: {
      outcome: "nothing" | "triggered" | "duplicate" | "failed" | "skipped";
      runId?: string;
      error?: string;
    },
  ): void {
    try {
      this.#ports.store.pollTriggers.recordTick(
        runtime.pollerId,
        tick,
        POLL_MAX_CONSECUTIVE_FAILURES,
      );
    } catch (error) {
      this.#log(
        `poll tick record for workflow ${runtime.workflowId} did not complete: ${messageOf(error)}`,
      );
    }
  }

  /** A disarm that lands mid-probe wins: the tick records nothing. */
  #stillArmed(runtime: PollTriggerRuntime): boolean {
    try {
      const current = this.#ports.store.pollTriggers.trigger(runtime.projectId, runtime.workflowId);
      return current?.armed === true && current.pollerId === runtime.pollerId;
    } catch (error) {
      this.#log(`poll armed check did not complete: ${messageOf(error)}`);
      return false;
    }
  }

  #prune(runtime: PollTriggerRuntime): void {
    try {
      this.#ports.store.runs.pruneProbeRuns(
        runtime.projectId,
        runtime.workflowId,
        POLL_PROBE_RUN_KEEP,
      );
    } catch (error) {
      this.#log(`poll probe run prune did not complete: ${messageOf(error)}`);
    }
  }
}
