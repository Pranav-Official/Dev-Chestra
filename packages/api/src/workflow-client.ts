import type { ApiRequestOptions } from "./client.js";
import { ApiClientBase } from "./client.js";
import { IDEMPOTENCY_HEADER, IF_MATCH_HEADER } from "./constants.js";
import { type StartRunResponse, startRunResponseSchema } from "./dto.js";
import {
  type GateTestRequest,
  type GateTestResult,
  gateTestRequestSchema,
  gateTestResultSchema,
} from "./gate-dto.js";
import { etagSchema, quoteEtag } from "./primitives.js";
import {
  type CreateWorkflowRequest,
  createWorkflowRequestSchema,
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

export interface StartWorkflowOptions extends ApiRequestOptions {
  /** Optional durable idempotency key; replay returns duplicate: true. */
  idempotencyKey?: string;
}

/**
 * Workflow CRUD and run-start methods, split from the base client to keep every
 * source file small. The base owns transport, auth, CSRF and ETag header rules.
 */
export class ApiClient extends ApiClientBase {
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
}
