import {
  approvalListResponseSchema,
  approvalResolveResponseSchema,
  bootstrapResponseSchema,
  cliListResponseSchema,
  cliModelCatalogSchema,
  commandResponseSchema,
  eventPageResponseSchema,
  executionDetailResponseSchema,
  gateTestResultSchema,
  healthResponseSchema,
  listProjectsResponseSchema,
  projectViewSchema,
  projectWorkspacesResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  startRunResponseSchema,
  transcriptPageResponseSchema,
  validateWorkflowResponseSchema,
  workflowDocumentResponseSchema,
  workflowListResponseSchema,
} from "@relay/api";
import { RelayError } from "../errors.js";

interface SafeSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

const RESPONSE_SCHEMAS: Readonly<Record<string, SafeSchema>> = {
  HealthResponse: healthResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  CliModelCatalog: cliModelCatalogSchema,
  CliListResponse: cliListResponseSchema,
  ListProjectsResponse: listProjectsResponseSchema,
  ProjectView: projectViewSchema,
  ProjectWorkspacesResponse: projectWorkspacesResponseSchema,
  RunListResponse: runListResponseSchema,
  RunDetailResponse: runDetailResponseSchema,
  EventPageResponse: eventPageResponseSchema,
  ExecutionDetailResponse: executionDetailResponseSchema,
  TranscriptPageResponse: transcriptPageResponseSchema,
  StartRunResponse: startRunResponseSchema,
  CommandResponse: commandResponseSchema,
  WorkflowDocumentResponse: workflowDocumentResponseSchema,
  WorkflowListResponse: workflowListResponseSchema,
  ValidateWorkflowResponse: validateWorkflowResponseSchema,
  GateTestResult: gateTestResultSchema,
  ApprovalListResponse: approvalListResponseSchema,
  ApprovalResolveResponse: approvalResolveResponseSchema,
} as unknown as Readonly<Record<string, SafeSchema>>;

export function makeResponseValidator(
  enabled: boolean,
  extra?: (name: string, value: unknown) => void,
): (name: string, value: unknown) => void {
  return (name, value) => {
    extra?.(name, value);
    if (!enabled) return;
    const schema = RESPONSE_SCHEMAS[name];
    if (schema === undefined) return;
    const parsed = schema.safeParse(value);
    if (parsed.success) return;
    const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new RelayError("E_INTERNAL", `Response contract violation for ${name}`, { issues });
  };
}
