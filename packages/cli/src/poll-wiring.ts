import { type Engine, freezeWorkflowBundle, type WorkflowResolver } from "@devchestra/engine";
import { type BrowserPollPorts, PollScheduler } from "@devchestra/server";
import type { Store } from "@devchestra/store";
import { notice } from "./output.js";
import { createCliWorkflowResolver } from "./workflow.js";

/**
 * Polling trigger ports, composed from the CLI's engine and store. The server
 * never imports the engine: it receives these ports. Next to
 * createWebhookPorts, which does the same for webhook deliveries.
 */
export function createPollPorts(store: Store, engine: Engine): BrowserPollPorts {
  return {
    store,
    runs: {
      async launch(input) {
        const launched = await engine.launch({
          projectId: input.projectId,
          workflowId: input.workflowId,
          snapshot: input.snapshot,
          snapshotRaw: input.snapshotRaw,
          params: input.params,
          workspace: input.workspace,
          workflowDependencies: input.workflowDependencies,
        });
        if (!launched.ok) throw launched.error;
        const { runId, duplicate, completion } = launched.value;
        void completion.then(undefined, (error: unknown) => {
          notice(
            `polling run ${runId} launch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return { runId, duplicate, completion };
      },
      async probe(input) {
        const result = await engine.probe({
          projectId: input.projectId,
          workflowId: input.workflowId,
          snapshot: input.snapshot,
          probe: input.probe,
          workspace: input.workspace,
          timeoutMs: input.timeoutMs,
          ...(input.timeoutMin === undefined ? {} : { timeoutMin: input.timeoutMin }),
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      pumpQueue: () => engine.pumpQueue(),
    },
    freeze: {
      // Same walk the engine runs for a managed launch, reading children from the project.
      async freeze(projectId, workflowId, snapshot) {
        const frozen = await freezeWorkflowBundle({
          projectId,
          rootSnapshot: snapshot,
          rootWorkflowId: workflowId,
          resolver: createCliWorkflowResolver(store) as WorkflowResolver,
        });
        return frozen.bundle;
      },
    },
  };
}

/**
 * The polling timer. Created after the engine starts and stopped on shutdown;
 * the server process owns it while serving.
 */
export function createPollScheduler(ports: BrowserPollPorts): PollScheduler {
  return new PollScheduler({ ports });
}
