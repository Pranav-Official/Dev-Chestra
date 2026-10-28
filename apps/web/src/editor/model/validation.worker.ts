import { parseWorkflow, validateWorkflow, type WorkflowFile } from "@devchestra/schema";
import { devchestraErrorReport } from "./validation-report.js";

interface ValidateRequest {
  type: "validate";
  requestId: number;
  revision: number;
  file: WorkflowFile;
}

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;

function isRequest(value: unknown): value is ValidateRequest {
  if (value === null || typeof value !== "object") return false;
  const request = value as Partial<ValidateRequest>;
  return (
    request.type === "validate" &&
    typeof request.requestId === "number" &&
    typeof request.revision === "number" &&
    request.file !== null &&
    typeof request.file === "object"
  );
}

scope.onmessage = (event) => {
  const request = event.data;
  if (!isRequest(request)) return;
  try {
    const parsed = parseWorkflow(request.file);
    if (!parsed.ok) {
      scope.postMessage({
        type: "result",
        requestId: request.requestId,
        revision: request.revision,
        report: devchestraErrorReport(parsed.error),
      });
      return;
    }
    scope.postMessage({
      type: "result",
      requestId: request.requestId,
      revision: request.revision,
      report: validateWorkflow(parsed.value),
    });
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId: request.requestId,
      revision: request.revision,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
