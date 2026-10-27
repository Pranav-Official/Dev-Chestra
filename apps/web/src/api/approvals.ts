import type { ApprovalResolveRequest, ApprovalResolveResponse } from "@relay/api";
import { api } from "./client.js";

// Thin typed wrapper over the canonical @relay/api client.
// No duplicate transport, no raw JSON parse/casts — zod validation is inside ApiClient.
export type ApprovalDecision = ApprovalResolveRequest["decision"];

export function resolveApproval(
  runId: string,
  path: string,
  body: ApprovalResolveRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ApprovalResolveResponse> {
  return api.resolveApproval(runId, path, body, options);
}

export function listApprovals(
  query: Parameters<typeof api.listApprovals>[0] = {},
  options: Parameters<typeof api.listApprovals>[1] = {},
) {
  return api.listApprovals(query, options);
}

export function listRunApprovals(
  runId: string,
  query: Parameters<typeof api.listRunApprovals>[1] = {},
  options: Parameters<typeof api.listRunApprovals>[2] = {},
) {
  return api.listRunApprovals(runId, query, options);
}

export function getApproval(
  runId: string,
  path: string,
  options: Parameters<typeof api.getApproval>[2] = {},
) {
  return api.getApproval(runId, path, options);
}
