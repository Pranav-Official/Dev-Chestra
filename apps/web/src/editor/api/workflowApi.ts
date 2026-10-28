import {
  type ApiError,
  ApiTransportError,
  type DecisionTestRequest,
  type DecisionTestResult,
  type GateTestResult,
  isApiError,
  type StartRunResponse,
  type StartWorkflowRunRequest,
  type WorkflowDocumentResponse,
  type WorkflowListResponse,
  type WorkflowTemplate,
} from "@relay/api";
import type { DecisionNode, GateNode, ValidationReport, WorkflowFile } from "@relay/schema";
import { api } from "../../api/client.js";

export type WorkflowDocument = WorkflowDocumentResponse;
export type {
  CreateWorkflowRequest,
  WorkflowListItem,
  WorkflowListResponse,
  WorkflowTemplate,
  WorkflowValidationSummary,
} from "@relay/api";

export interface WorkflowSaveInput {
  workflow: WorkflowFile;
  baseEtag: string;
  signal?: AbortSignal;
}

export type StartWorkflowRunInput = StartWorkflowRunRequest;

export const workflowApi = {
  list(
    projectId: string,
    query: { limit?: number; cursor?: string } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowListResponse> {
    return api.listWorkflows(projectId, query, options);
  },

  create(
    projectId: string,
    input: { name: string; id?: string; template?: WorkflowTemplate },
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowDocumentResponse> {
    return api.createWorkflow(projectId, input, options);
  },

  get(
    projectId: string,
    workflowId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowDocumentResponse> {
    return api.getWorkflow(projectId, workflowId, options);
  },

  save(
    projectId: string,
    workflowId: string,
    input: WorkflowSaveInput,
  ): Promise<WorkflowDocumentResponse> {
    return api.saveWorkflow(
      projectId,
      workflowId,
      { workflow: input.workflow },
      input.baseEtag,
      input.signal === undefined ? {} : { signal: input.signal },
    );
  },

  remove(
    projectId: string,
    workflowId: string,
    ifMatch: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return api.deleteWorkflow(projectId, workflowId, ifMatch, options);
  },

  async validate(
    projectId: string,
    workflowId: string,
    workflow: WorkflowFile,
    options: { signal?: AbortSignal } = {},
  ): Promise<ValidationReport> {
    const result = await api.validateWorkflow(projectId, workflowId, { workflow }, options);
    return result.validation;
  },

  start(
    projectId: string,
    workflowId: string,
    body: StartWorkflowRunInput,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<StartRunResponse> {
    return api.startWorkflowRun(projectId, workflowId, body, options);
  },

  /** Stateless, bounded gate preview. No run or workflow is created or modified. */
  testGate(
    projectId: string,
    gate: GateNode,
    scope: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<GateTestResult> {
    return api.testGate(projectId, { gate, scope }, options);
  },

  /**
   * Live decision-model probe. Calls the real provider (it costs tokens).
   * Never creates a run.
   */
  testDecision(
    projectId: string,
    node: DecisionNode,
    state: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DecisionTestResult> {
    const body: DecisionTestRequest = {
      provider: node.provider,
      ...(node.model === undefined ? {} : { model: node.model }),
      state,
      instructions: node.instructions,
      mode: node.mode,
    };
    return api.testDecision(projectId, body, options);
  },
};

export function isConflictError(error: unknown): error is ApiError {
  return isApiError(error) && (error.code === "E_CONFLICT" || error.status === 409);
}

export function currentEtagFrom(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const details = error.details;
  if (details === null || typeof details !== "object") return null;
  const value = (details as { currentEtag?: unknown }).currentEtag;
  return typeof value === "string" && value !== "" ? value : null;
}

export function describeWorkflowError(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof ApiTransportError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "The workflow request failed.";
}
