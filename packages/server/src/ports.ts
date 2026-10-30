import type {
  AcceptedOutput,
  ContextPoolApi,
  Receipt,
  SubmissionsApi,
  SubmitInput,
  SubmitOutcome,
} from "@devchestra/store";

/**
 * Narrow gateway-facing port. The composition root passes the real store; tests
 * may pass a structural double. Types come from @devchestra/store so the gateway
 * never grows a second copy of the durable submission contract.
 */
export type SubmissionPort = Pick<SubmissionsApi, "submit" | "accepted" | "validationLeft">;

/** Execution context-pool port: run-scoped blackboard for agent notes. */
export type ContextPoolPort = Pick<ContextPoolApi, "upsert" | "get" | "list">;

export type SubmissionRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type {
  AcceptedOutput as AcceptedOutputView,
  Receipt as ReceiptView,
  SubmitInput,
  SubmitOutcome,
};
