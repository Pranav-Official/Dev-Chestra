import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RunView } from "@relay/core";
import { fieldString, type HttpResult, type RelayHttp } from "./http.js";

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  kind: string;
}

export interface StartRunResult {
  runId: string;
  duplicate: boolean;
  status: string;
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function registerProject(http: RelayHttp, path: string): Promise<ProjectView> {
  const result = await http.api("POST", "/api/projects", { body: { path } });
  assert.equal(result.status, 200, `POST /api/projects: ${JSON.stringify(result.body)}`);
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error("project response is not an object");
  }
  const body = result.body as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== "string" || id === "") throw new Error("project response has no id");
  return {
    id,
    name: typeof body.name === "string" ? body.name : "",
    path: typeof body.path === "string" ? body.path : path,
    kind: typeof body.kind === "string" ? body.kind : "folder",
  };
}

export async function startRun(
  http: RelayHttp,
  projectId: string,
  input: {
    workflowFile: string;
    params?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<StartRunResult> {
  const body: Record<string, unknown> = { workflowFile: input.workflowFile };
  if (input.params !== undefined) body.params = input.params;
  const result = await http.api("POST", `/api/projects/${encodeURIComponent(projectId)}/runs`, {
    body,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  });
  assert.equal(result.status, 202, `POST run: ${JSON.stringify(result.body)}`);
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error("run response is not an object");
  }
  const parsed = result.body as Record<string, unknown>;
  const runId = parsed.runId;
  if (typeof runId !== "string" || runId === "") throw new Error("run response has no runId");
  return {
    runId,
    duplicate: parsed.duplicate === true,
    status: typeof parsed.status === "string" ? parsed.status : "unknown",
    httpStatus: result.status,
    body: parsed,
  };
}

export function defaultIdempotencyKey(): string {
  return `p2-${randomUUID()}`;
}

export interface RunBody {
  raw: Record<string, unknown>;
  view: RunView;
  watermark: number;
  status: string;
}

export async function getRun(http: RelayHttp, runId: string): Promise<RunBody> {
  const result = await http.api("GET", `/api/runs/${encodeURIComponent(runId)}`);
  assert.equal(result.status, 200, `GET run: ${JSON.stringify(result.body)}`);
  return parseRunBody(result);
}

export function parseRunBody(result: HttpResult): RunBody {
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error("run body is not an object");
  }
  const body = result.body as Record<string, unknown>;
  const view = body.view as RunView | undefined;
  if (view === undefined || typeof view !== "object" || view === null) {
    throw new Error("run body has no view");
  }
  const watermark = body.watermark;
  if (typeof watermark !== "number") throw new Error("run body has no numeric watermark");
  const status = fieldString(body, ["run", "status"]) ?? view.status;
  return { raw: body, view, watermark, status };
}

export function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "rejected", "cancelled"].includes(status);
}

export async function waitTerminal(
  http: RelayHttp,
  runId: string,
  timeoutMs = 90_000,
): Promise<RunBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(http, runId);
    if (isTerminal(run.status)) return run;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for run ${runId}; status=${run.status} lastEvent=${String(run.view.lastEventId)}`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 75));
  }
}
