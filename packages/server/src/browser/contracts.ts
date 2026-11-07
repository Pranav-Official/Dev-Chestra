import {
  approvalListResponseSchema,
  approvalResolveResponseSchema,
  bootstrapResponseSchema,
  cliListItemSchema,
  cliListResponseSchema,
  cliModelCatalogSchema,
  cliStatusResponseSchema,
  commandResponseSchema,
  decisionProvidersResponseSchema,
  decisionTestResultSchema,
  effectiveSettingsResponseSchema,
  eventPageResponseSchema,
  executionDetailResponseSchema,
  executionSettingsResponseSchema,
  foreachItemsResponseSchema,
  gateTestResultSchema,
  healthResponseSchema,
  listProjectsResponseSchema,
  outputPreviewSchema,
  pollProbeResultSchema,
  pollTriggerStatusSchema,
  projectViewSchema,
  projectWorkspacesResponseSchema,
  providerStatusItemSchema,
  runChildrenResponseSchema,
  runContextResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  settingsResponseSchema,
  startRunResponseSchema,
  transcriptPageResponseSchema,
  usageSummaryResponseSchema,
  validateWorkflowResponseSchema,
  webhookDeliveryResponseSchema,
  webhookSettingsSchema,
  webhookTriggerResponseSchema,
  webhookTriggerStatusSchema,
  workflowDocumentResponseSchema,
  workflowListResponseSchema,
} from "@devchestra/api";
import { DevChestraError } from "../errors.js";

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
  CliListItem: cliListItemSchema,
  CliStatusResponse: cliStatusResponseSchema,
  ProviderStatusItem: providerStatusItemSchema,
  ListProjectsResponse: listProjectsResponseSchema,
  ProjectView: projectViewSchema,
  ProjectWorkspacesResponse: projectWorkspacesResponseSchema,
  RunListResponse: runListResponseSchema,
  RunContextResponse: runContextResponseSchema,
  OutputPreview: outputPreviewSchema,
  RunDetailResponse: runDetailResponseSchema,
  EventPageResponse: eventPageResponseSchema,
  ExecutionDetailResponse: executionDetailResponseSchema,
  TranscriptPageResponse: transcriptPageResponseSchema,
  StartRunResponse: startRunResponseSchema,
  UsageSummaryResponse: usageSummaryResponseSchema,
  CommandResponse: commandResponseSchema,
  WorkflowDocumentResponse: workflowDocumentResponseSchema,
  WorkflowListResponse: workflowListResponseSchema,
  ValidateWorkflowResponse: validateWorkflowResponseSchema,
  GateTestResult: gateTestResultSchema,
  DecisionProvidersResponse: decisionProvidersResponseSchema,
  DecisionTestResult: decisionTestResultSchema,
  ApprovalListResponse: approvalListResponseSchema,
  ApprovalResolveResponse: approvalResolveResponseSchema,
  RunChildrenResponse: runChildrenResponseSchema,
  ForeachItemsResponse: foreachItemsResponseSchema,
  WebhookTriggerStatus: webhookTriggerStatusSchema,
  WebhookTriggerResponse: webhookTriggerResponseSchema,
  WebhookDeliveryResponse: webhookDeliveryResponseSchema,
  PollTriggerStatus: pollTriggerStatusSchema,
  PollProbeResult: pollProbeResultSchema,
  ExecutionSettingsResponse: executionSettingsResponseSchema,
  WebhookSettings: webhookSettingsSchema,
  SettingsResponse: settingsResponseSchema,
  EffectiveSettingsResponse: effectiveSettingsResponseSchema,
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
    throw new DevChestraError("E_INTERNAL", `Response contract violation for ${name}`, { issues });
  };
}
