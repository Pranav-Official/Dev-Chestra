import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type DevChestraHttp,
  errorCode,
  etagOf,
  fieldString,
  type HttpResult,
  header,
  objectBody,
} from "./http.js";

export interface WorkflowFileLike {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
}

export interface ValidationIssue {
  severity?: string;
  code?: string;
  message?: string;
  pointer?: string;
  nodeId?: string;
}

export interface ValidationReportLike {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  requires?: unknown;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  relativeFile: string;
  etag: string;
  updatedAt: number;
  validationSummary?: { ok: boolean; errors: number; warnings: number };
}

export interface WorkflowDocument {
  id: string;
  workflow: WorkflowFileLike;
  text: string;
  etag: string;
  relativeFile: string;
  validation: ValidationReportLike;
  httpStatus: number;
}

export interface CreatedWorkflow extends WorkflowDocument {
  created: boolean;
}

export interface StartManagedRun {
  runId: string;
  duplicate: boolean;
  status: string;
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface RunBody {
  raw: Record<string, unknown>;
  view: Record<string, unknown>;
  watermark: number;
  status: string;
}

export function quoteEtag(etag: string): string {
  if (!/^[A-Fa-f0-9]{64}$/u.test(etag)) throw new Error(`unexpected DTO etag: ${etag}`);
  return `"${etag}"`;
}

export function defaultIdempotencyKey(): string {
  return `p3-${randomUUID()}`;
}

export async function registerProject(http: DevChestraHttp, path: string): Promise<{ id: string }> {
  const result = await http.api("POST", "/api/projects", { body: { path } });
  assert.equal(result.status, 200, `POST project: ${result.text.slice(0, 500)}`);
  return { id: fieldString(result.body, ["id"]) ?? fail("project id missing") };
}

function fail(message: string): never {
  throw new Error(message);
}

function parseDocument(result: HttpResult, expected: number[]): WorkflowDocument {
  assert.ok(
    expected.includes(result.status),
    `workflow response ${result.status}: ${result.text.slice(0, 800)}`,
  );
  const body = objectBody(result, "workflow document");
  const workflow = body.workflow;
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
    fail("workflow document has no workflow object");
  }
  const text = body.text;
  const etag = body.etag;
  const relativeFile = body.relativeFile;
  const validation = body.validation;
  if (typeof text !== "string") fail("workflow document has no text");
  if (typeof etag !== "string") fail("workflow document has no etag");
  if (typeof relativeFile !== "string") fail("workflow document has no relativeFile");
  if (typeof validation !== "object" || validation === null)
    fail("workflow document has no validation");
  const id = fieldString(workflow, ["id"]) ?? fail("workflow file has no id");
  const headerEtag = etagOf(result);
  assert.equal(headerEtag, quoteEtag(etag), "response ETag header must quote the DTO etag");
  return {
    id,
    workflow: workflow as WorkflowFileLike,
    text,
    etag,
    relativeFile,
    validation: validation as ValidationReportLike,
    httpStatus: result.status,
  };
}

export async function listWorkflows(
  http: DevChestraHttp,
  projectId: string,
  query = "",
): Promise<{ items: WorkflowListItem[]; nextCursor: string | null; status: number }> {
  const result = await http.api(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/workflows${query}`,
  );
  assert.equal(result.status, 200, `GET workflows: ${result.text.slice(0, 500)}`);
  const body = objectBody(result, "workflow list");
  const items = body.items;
  if (!Array.isArray(items)) fail("workflow list has no items array");
  const nextCursor = body.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string")
    fail("workflow list cursor is invalid");
  return { items: items as WorkflowListItem[], nextCursor, status: result.status };
}

export async function createWorkflow(
  http: DevChestraHttp,
  projectId: string,
  input: { name: string; id?: string; template?: "blank" | "linear" },
): Promise<CreatedWorkflow> {
  const result = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    {
      body: input,
    },
  );
  const doc = parseDocument(result, [201]);
  return { ...doc, created: true };
}

export async function getWorkflow(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
): Promise<WorkflowDocument> {
  const result = await http.api(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
  );
  return parseDocument(result, [200]);
}

export async function saveWorkflow(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  workflow: WorkflowFileLike,
  ifMatch: string,
): Promise<WorkflowDocument> {
  const result = await http.api(
    "PUT",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    { body: { workflow }, ifMatch: quoteEtag(ifMatch) },
  );
  return parseDocument(result, [200]);
}

export async function saveWorkflowRaw(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  body: unknown,
  ifMatch?: string,
): Promise<HttpResult> {
  return http.api(
    "PUT",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    {
      body,
      ...(ifMatch === undefined ? {} : { ifMatch: quoteEtag(ifMatch) }),
    },
  );
}

export async function validateWorkflow(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  workflow: WorkflowFileLike,
): Promise<{ report: ValidationReportLike; status: number; result: HttpResult }> {
  const result = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/validate`,
    { body: { workflow } },
  );
  assert.equal(result.status, 200, `validate: ${result.text.slice(0, 500)}`);
  const body = objectBody(result, "validation");
  const validation = body.validation;
  if (typeof validation !== "object" || validation === null)
    fail("validation response missing report");
  return { report: validation as ValidationReportLike, status: result.status, result };
}

export async function deleteWorkflow(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  ifMatch: string,
): Promise<HttpResult> {
  return http.api(
    "DELETE",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    { ifMatch: quoteEtag(ifMatch), headers: { "Content-Type": "application/json" } },
  );
}

export async function startManagedRun(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
  input: { params?: Record<string, unknown>; etag: string; idempotencyKey?: string },
): Promise<StartManagedRun> {
  const body: Record<string, unknown> = { etag: input.etag };
  if (input.params !== undefined) body.params = input.params;
  const result = await http.api(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/runs`,
    {
      body,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    },
  );
  assert.equal(result.status, 202, `start managed run: ${result.text.slice(0, 800)}`);
  const parsed = objectBody(result, "start response");
  const runId = parsed.runId;
  if (typeof runId !== "string" || runId === "") fail("start response has no runId");
  return {
    runId,
    duplicate: parsed.duplicate === true,
    status: typeof parsed.status === "string" ? parsed.status : "unknown",
    httpStatus: result.status,
    body: parsed,
  };
}

export async function getRun(http: DevChestraHttp, runId: string): Promise<RunBody> {
  const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}`);
  assert.equal(result.status, 200, `GET run: ${result.text.slice(0, 500)}`);
  const body = objectBody(result, "run");
  const view = body.view;
  const watermark = body.watermark;
  if (typeof view !== "object" || view === null) fail("run has no view");
  if (typeof watermark !== "number") fail("run has no numeric watermark");
  const status = fieldString(body, ["run", "status"]) ?? fieldString(view, ["status"]) ?? "unknown";
  return { raw: body, view: view as Record<string, unknown>, watermark, status };
}

export function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "rejected", "cancelled"].includes(status);
}

export async function waitTerminal(
  http: DevChestraHttp,
  runId: string,
  timeoutMs = 90_000,
): Promise<RunBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(http, runId);
    if (isTerminal(run.status)) return run;
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} stayed ${run.status}`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 75));
  }
}

export async function readManagedFile(
  projectDir: string,
  relativeFile: string,
): Promise<{ path: string; text: string }> {
  assert.equal(relativeFile, `.devchestra/workflows/${relativeFile.split("/").at(-1) ?? ""}`);
  const path = resolve(join(projectDir, relativeFile));
  const root = resolve(join(projectDir, ".devchestra/workflows"));
  assert.ok(path.startsWith(`${root}/`), "managed file must stay inside .devchestra/workflows");
  return { path, text: await readFile(path, "utf8") };
}

export function expectError(
  result: HttpResult,
  statuses: readonly number[],
  label: string,
  code?: string,
): void {
  assert.ok(
    statuses.includes(result.status),
    `${label}: expected ${statuses.join("/")} got ${String(result.status)} body=${result.text.slice(0, 500)}`,
  );
  assert.notEqual(errorCode(result), null, `${label}: missing error object`);
  if (code !== undefined) assert.equal(errorCode(result), code, `${label}: wrong error code`);
}

export function apiHeader(result: HttpResult): string {
  const value = header(result, "x-devchestra-api");
  assert.ok(value !== null && value !== "", "response is missing X-DevChestra-Api");
  return value;
}
