import type {
  AcceptedOutput,
  Receipt,
  SubmissionsApi,
  SubmitInput,
  SubmitOutcome,
} from "@relay/store";

/**
 * Narrow gateway-facing port. The composition root passes the real store; tests
 * may pass a structural double. Types come from @relay/store so the gateway
 * never grows a second copy of the durable submission contract.
 */
export type SubmissionPort = Pick<SubmissionsApi, "submit" | "accepted" | "validationLeft">;

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
