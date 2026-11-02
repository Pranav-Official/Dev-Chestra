import type { JsonObject, RunWorkspaceSelection } from "@devchestra/core";
import type { NormalizedWorkflow, PollProbe, PollProbeOutput } from "@devchestra/schema";
import type { PollTriggersApi, RunsApi } from "@devchestra/store";

/** A run a poll tick asks the engine to queue. Always a new worktree. */
export interface PollRunCommand {
  readonly projectId: string;
  readonly workflowId: string;
  readonly snapshot: NormalizedWorkflow;
  readonly snapshotRaw: string;
  readonly params: JsonObject;
  readonly workspace: RunWorkspaceSelection;
  /** The armed transitive child bundle. Passing it keeps the run on the armed revision. */
  readonly workflowDependencies: Readonly<Record<string, unknown>>;
}

export interface PollRunLaunch {
  readonly runId: string;
  readonly duplicate: boolean;
  /** Settles when the run finishes. Ticks never await it. */
  readonly completion: Promise<unknown>;
}

/** One probe run. Mirrors the engine's probe input; the server never imports the engine. */
export interface PollProbeCommand {
  readonly projectId: string;
  readonly workflowId: string;
  /** Armed snapshot the tick probes; its start node carries the params under test. */
  readonly snapshot: NormalizedWorkflow;
  /** The start.polling probe. Read from the snapshot by the caller. */
  readonly probe: PollProbe;
  /**
   * Where the probe runs. `project` is the registered project root with no
   * checkout and no worktree; `worktree` is a fresh worktree per tick.
   */
  readonly workspace: "project" | "worktree";
  /** Probe deadline in milliseconds. The caller keeps it below the interval. */
  readonly timeoutMs: number;
  /** Probe node timeout in minutes. */
  readonly timeoutMin?: number;
}

export interface PollProbeOutcome {
  readonly runId: string;
  readonly raw: PollProbeOutput;
  readonly durationMs: number;
}

/** Engine access for poll ticks. `launch` and `probe` throw the engine's error when refused. */
export interface BrowserPollRunPort {
  launch(input: PollRunCommand): Promise<PollRunLaunch>;
  probe(input: PollProbeCommand): Promise<PollProbeOutcome>;
  /** Starts queued runs that fit under a changed concurrency limit. */
  pumpQueue(): void;
}

/**
 * The transitive child freeze the engine runs for a managed run. Arm and refresh
 * call it so the armed bundle matches what a real run would freeze. Resolves to
 * the id -> normalized snapshot map.
 */
export interface BrowserPollFreezePort {
  freeze(
    projectId: string,
    workflowId: string,
    snapshot: NormalizedWorkflow,
  ): Promise<Record<string, unknown>>;
}

/** Everything the polling surface needs from the composition root. */
export interface BrowserPollPorts {
  /** The store, narrowed to the poll trigger and probe-run purge APIs. */
  readonly store: {
    readonly pollTriggers: PollTriggersApi;
    readonly runs: Pick<RunsApi, "deleteProbeRun" | "pruneProbeRuns">;
  };
  readonly runs: BrowserPollRunPort;
  readonly freeze: BrowserPollFreezePort;
}
