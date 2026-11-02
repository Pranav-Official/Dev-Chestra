import type { ApiRequestOptions } from "./client.js";
import { ApiClientBase } from "./client.js";
import { IDEMPOTENCY_HEADER, IF_MATCH_HEADER } from "./constants.js";
import {
  type DecisionProvidersResponse,
  type DecisionTestRequest,
  type DecisionTestResult,
  decisionProvidersResponseSchema,
  decisionTestRequestSchema,
  decisionTestResultSchema,
} from "./decision-dto.js";
import { type StartRunResponse, startRunResponseSchema } from "./dto.js";
import {
  type GateTestRequest,
  type GateTestResult,
  gateTestRequestSchema,
  gateTestResultSchema,
} from "./gate-dto.js";
import {
  type PollArmRequest,
  type PollProbeResult,
  type PollTriggerStatus,
  pollArmRequestSchema,
  pollProbeResultSchema,
  pollTriggerStatusSchema,
} from "./poll-dto.js";
import { etagSchema, quoteEtag } from "./primitives.js";
import {
  type ExecutionSettings,
  type ExecutionSettingsResponse,
  executionSettingsResponseSchema,
  executionSettingsSchema,
  type WebhookSettings,
  type WebhookTriggerResponse,
  type WebhookTriggerStatus,
  webhookSettingsSchema,
  webhookTriggerResponseSchema,
  webhookTriggerStatusSchema,
} from "./webhook-dto.js";
import {
  type CreateWorkflowRequest,
  createWorkflowRequestSchema,
  type ForeachItemsResponse,
  foreachItemsResponseSchema,
  type RunChildrenResponse,
  runChildrenResponseSchema,
  type SaveWorkflowRequest,
  type StartWorkflowRunRequest,
  saveWorkflowRequestSchema,
  startWorkflowRunRequestSchema,
  type ValidateWorkflowRequest,
  type ValidateWorkflowResponse,
  validateWorkflowRequestSchema,
  validateWorkflowResponseSchema,
  type WorkflowDocumentResponse,
  type WorkflowListQuery,
  type WorkflowListResponse,
  workflowDocumentResponseSchema,
  workflowListResponseSchema,
} from "./workflow-dto.js";
import {
  type WorkflowGroupsDocument,
  type WorkflowGroupsResponse,
  workflowGroupsDocumentSchema,
  workflowGroupsResponseSchema,
} from "./workflow-groups.js";

export interface StartWorkflowOptions extends ApiRequestOptions {
  /** Optional durable idempotency key; replay returns duplicate: true. */
  idempotencyKey?: string;
}

/**
 * Workflow CRUD and run-start methods, split from the base client to keep every
 * source file small. The base owns transport, auth, CSRF and ETag header rules.
 */
export class ApiClient extends ApiClientBase {
  getWorkflowGroups(
    projectId: string,
    options: ApiRequestOptions = {},
  ): Promise<WorkflowGroupsResponse> {
    return this.request(
      "GET",
      ["projects", projectId, "workflow-groups"],
      workflowGroupsResponseSchema,
      this.req(options),
    );
  }

  saveWorkflowGroups(
    projectId: string,
    document: WorkflowGroupsDocument,
    ifMatch: string,
  ): Promise<WorkflowGroupsResponse> {
    return this.request(
      "PUT",
      ["projects", projectId, "workflow-groups"],
      workflowGroupsResponseSchema,
      this.req(
        {},
        {
          body: workflowGroupsDocumentSchema.parse(document),
          mutation: true,
          extraHeaders: { [IF_MATCH_HEADER]: quoteEtag(etagSchema.parse(ifMatch)) },
        },
      ),
    );
  }

  listWorkflows(
    projectId: string,
    query: WorkflowListQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<WorkflowListResponse> {
    return this.request(
      "GET",
      ["projects", projectId, "workflows"],
      workflowListResponseSchema,
      this.req(options, { query: { cursor: query.cursor, limit: query.limit } }),
    );
  }

  async createWorkflow(
    projectId: string,
    body: CreateWorkflowRequest,
    options: ApiRequestOptions = {},
  ): Promise<WorkflowDocumentResponse> {
    const parsed = createWorkflowRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "workflows"],
      workflowDocumentResponseSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  getWorkflow(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WorkflowDocumentResponse> {
    return this.request(
      "GET",
      ["projects", projectId, "workflows", workflowId],
      workflowDocumentResponseSchema,
      this.req(options),
    );
  }

  async saveWorkflow(
    projectId: string,
    workflowId: string,
    body: SaveWorkflowRequest,
    ifMatch: string,
    options: ApiRequestOptions = {},
  ): Promise<WorkflowDocumentResponse> {
    const parsed = saveWorkflowRequestSchema.parse(body);
    const header = quoteEtag(etagSchema.parse(ifMatch));
    return this.request(
      "PUT",
      ["projects", projectId, "workflows", workflowId],
      workflowDocumentResponseSchema,
      this.req(options, {
        body: parsed,
        mutation: true,
        extraHeaders: { [IF_MATCH_HEADER]: header },
      }),
    );
  }

  async deleteWorkflow(
    projectId: string,
    workflowId: string,
    ifMatch: string,
    options: ApiRequestOptions = {},
  ): Promise<void> {
    const header = quoteEtag(etagSchema.parse(ifMatch));
    await this.requestEmpty(
      "DELETE",
      ["projects", projectId, "workflows", workflowId],
      this.req(options, {
        mutation: true,
        extraHeaders: { [IF_MATCH_HEADER]: header },
      }),
    );
  }

  async validateWorkflow(
    projectId: string,
    workflowId: string,
    body: ValidateWorkflowRequest,
    options: ApiRequestOptions = {},
  ): Promise<ValidateWorkflowResponse> {
    const parsed = validateWorkflowRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "validate"],
      validateWorkflowResponseSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  async startWorkflowRun(
    projectId: string,
    workflowId: string,
    body: StartWorkflowRunRequest,
    options: StartWorkflowOptions = {},
  ): Promise<StartRunResponse> {
    const parsed = startWorkflowRunRequestSchema.parse(body);
    const extraHeaders =
      options.idempotencyKey === undefined
        ? undefined
        : { [IDEMPOTENCY_HEADER]: options.idempotencyKey };
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "runs"],
      startRunResponseSchema,
      this.req(options, { body: parsed, mutation: true, extraHeaders }),
    );
  }

  /** Parent-child provenance (refs only, paginated, no hydration). */
  listRunChildren(
    runId: string,
    query: { cursor?: string; limit?: number } = {},
    options: ApiRequestOptions = {},
  ): Promise<RunChildrenResponse> {
    return this.request(
      "GET",
      ["runs", runId, "children"],
      runChildrenResponseSchema,
      this.req(options, { query }),
    );
  }

  /** Foreach per-item refs (paginated, no hydration). */
  listForeachItems(
    runId: string,
    sourceId: string,
    query: { cursor?: string; limit?: number } = {},
    options: ApiRequestOptions = {},
  ): Promise<ForeachItemsResponse> {
    return this.request(
      "GET",
      ["runs", runId, "foreach", sourceId, "items"],
      foreachItemsResponseSchema,
      this.req(options, { query }),
    );
  }

  /** Stateless gate preview; never creates a run or touches the workflow file. */
  async testGate(
    projectId: string,
    body: GateTestRequest,
    options: ApiRequestOptions = {},
  ): Promise<GateTestResult> {
    const parsed = gateTestRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "gates", "test"],
      gateTestResultSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  /** Fixed decision-model provider presets with secret-name-only readiness. */
  listDecisionProviders(options: ApiRequestOptions = {}): Promise<DecisionProvidersResponse> {
    return this.request(
      "GET",
      ["decision-providers"],
      decisionProvidersResponseSchema,
      this.req(options),
    );
  }

  /** Live decision-model probe; costs tokens. Never creates a run. */
  async testDecision(
    projectId: string,
    body: DecisionTestRequest,
    options: ApiRequestOptions = {},
  ): Promise<DecisionTestResult> {
    const parsed = decisionTestRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "decisions", "test"],
      decisionTestResultSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  async getPollTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<PollTriggerStatus> {
    return this.request(
      "GET",
      ["projects", projectId, "workflows", workflowId, "polling"],
      pollTriggerStatusSchema,
      this.req(options),
    );
  }

  async armPollTrigger(
    projectId: string,
    workflowId: string,
    body: PollArmRequest,
    options: ApiRequestOptions = {},
  ): Promise<PollTriggerStatus> {
    const parsed = pollArmRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "polling", "arm"],
      pollTriggerStatusSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  async disarmPollTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<PollTriggerStatus> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "polling", "disarm"],
      pollTriggerStatusSchema,
      this.req(options, { mutation: true }),
    );
  }

  async refreshPollTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<PollTriggerStatus> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "polling", "refresh"],
      pollTriggerStatusSchema,
      this.req(options, { mutation: true }),
    );
  }

  async probePollTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<PollProbeResult> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "polling", "probe-now"],
      pollProbeResultSchema,
      this.req(options, { mutation: true }),
    );
  }

  async getWebhookTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WebhookTriggerStatus> {
    return this.request(
      "GET",
      ["projects", projectId, "workflows", workflowId, "webhook"],
      webhookTriggerStatusSchema,
      this.req(options),
    );
  }

  async armWebhookTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WebhookTriggerResponse> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "webhook", "arm"],
      webhookTriggerResponseSchema,
      this.req(options, { mutation: true }),
    );
  }

  async disarmWebhookTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WebhookTriggerStatus> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "webhook", "disarm"],
      webhookTriggerStatusSchema,
      this.req(options, { mutation: true }),
    );
  }

  async rotateWebhookTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WebhookTriggerResponse> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "webhook", "rotate"],
      webhookTriggerResponseSchema,
      this.req(options, { mutation: true }),
    );
  }

  async refreshWebhookTrigger(
    projectId: string,
    workflowId: string,
    options: ApiRequestOptions = {},
  ): Promise<WebhookTriggerStatus> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "webhook", "refresh"],
      webhookTriggerStatusSchema,
      this.req(options, { mutation: true }),
    );
  }

  async getExecutionSettings(options: ApiRequestOptions = {}): Promise<ExecutionSettingsResponse> {
    return this.request(
      "GET",
      ["settings", "execution"],
      executionSettingsResponseSchema,
      this.req(options),
    );
  }

  async saveExecutionSettings(
    body: ExecutionSettings,
    options: ApiRequestOptions = {},
  ): Promise<ExecutionSettingsResponse> {
    const parsed = executionSettingsSchema.parse(body);
    return this.request(
      "PUT",
      ["settings", "execution"],
      executionSettingsResponseSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  async getWebhookSettings(options: ApiRequestOptions = {}): Promise<WebhookSettings> {
    return this.request("GET", ["settings", "webhooks"], webhookSettingsSchema, this.req(options));
  }

  async saveWebhookSettings(
    body: WebhookSettings,
    options: ApiRequestOptions = {},
  ): Promise<WebhookSettings> {
    const parsed = webhookSettingsSchema.parse(body);
    return this.request(
      "PUT",
      ["settings", "webhooks"],
      webhookSettingsSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }
}
