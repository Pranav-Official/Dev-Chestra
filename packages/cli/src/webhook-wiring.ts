import { type Engine, freezeWorkflowBundle, type WorkflowResolver } from "@devchestra/engine";
import type { BrowserWebhookPorts } from "@devchestra/server";
import type { Store } from "@devchestra/store";
import { notice } from "./output.js";
import { createCliWorkflowResolver } from "./workflow.js";

/**
 * Webhook launch, queue pump and transitive freeze, composed from the CLI's engine
 * and store. The server never imports the engine: it receives these ports.
 */
export function createWebhookPorts(store: Store, engine: Engine): BrowserWebhookPorts {
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
          delivery: input.delivery,
        });
        if (!launched.ok) throw launched.error;
        const { runId, duplicate, completion } = launched.value;
        void completion.then(undefined, (error: unknown) => {
          notice(
            `webhook run ${runId} launch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return { runId, duplicate, completion };
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
