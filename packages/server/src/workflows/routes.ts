import {
  createWorkflowRequestSchema,
  saveWorkflowRequestSchema,
  startRunResponseSchema,
  startWorkflowRunRequestSchema,
  validateWorkflowRequestSchema,
  type WorkflowDocumentResponse,
} from "@devchestra/api";
import type { JsonObject } from "@devchestra/core";
import type { Context, Hono } from "hono";
import type {
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
  BrowserWorkspacePort,
  ProjectView,
} from "../browser/ports.js";
import { disabledClisRequired, providersOffResponse } from "../browser/provider-guard.js";
import { readJsonObject } from "../browser/security.js";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { normalizeRunWorkspace, validateRunWorkspace } from "../browser/workspaces.js";
import { DevChestraError, errorBody } from "../errors.js";
import { parseIfMatch, quoteEtag } from "./io.js";
import type {
  ManagedWorkflowService,
  RunWorkflowSnapshot,
  WorkflowDocumentView,
  WorkflowListItemView,
  WorkflowProject,
} from "./service.js";

const MAX_WORKFLOW_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;

export interface WorkflowRouteDeps {
  store: BrowserQueryPort;
  controller: BrowserRunControllerPort;
  service: ManagedWorkflowService;
  dataDir: string;
  workspaceService?: BrowserWorkspacePort;
  providerSettings?: BrowserProviderSettingsPort;
  validate: (name: string, value: unknown) => void;
}

function toProject(project: ProjectView): WorkflowProject {
  return {
    id: project.id,
    path: project.path,
    kind: project.kind,
    missing: project.missing,
  };
}

function conflictResponse(c: Context, error: DevChestraError): Response {
  const details = error.details;
  const currentEtag =
    typeof details === "object" && details !== null
      ? (details as { currentEtag?: unknown }).currentEtag
      : undefined;
  if (typeof currentEtag === "string") {
    c.header("ETag", quoteEtag(currentEtag));
  }
  const { status } = error;
  return c.json(errorBody("E_CONFLICT", error.message, error.details), status as 409);
}

function isConflict(error: unknown): error is DevChestraError {
  return error instanceof DevChestraError && error.code === "E_CONFLICT";
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(value: string): string | null {
  if (!CURSOR.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return /^[a-z0-9-]{1,64}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function documentResponse(
  deps: WorkflowRouteDeps,
  c: Context,
  document: WorkflowDocumentView,
  status: 200 | 201 = 200,
): Response {
  c.header("ETag", quoteEtag(document.etag));
  const body: WorkflowDocumentResponse = document;
  deps.validate("WorkflowDocumentResponse", body);
  return c.json(body, status);
}

export function mountWorkflowRoutes(app: Hono, deps: WorkflowRouteDeps): void {
  const project = async (pid: string): Promise<ProjectView | Response> => {
    const found = await deps.store.getProject(pid);
    if (found === null) return errorResponse(404, "Project not found.");
    return found;
  };

  app.get("/api/projects/:pid/workflows", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json(errorBody("E_VALIDATION", "limit must be between 1 and 500."), 400);
    }
    const cursorQuery = c.req.query("cursor");
    const cursor = cursorQuery === undefined ? null : decodeCursor(cursorQuery);
    if (cursorQuery !== undefined && cursor === null) {
      return c.json(errorBody("E_VALIDATION", "Workflow cursor is invalid."), 400);
    }
    let page: { items: WorkflowListItemView[]; nextCursor: string | null };
    try {
      page = deps.service.listPage(toProject(found), {
        limit,
        ...(cursor === null ? {} : { cursor }),
      });
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_VALIDATION") {
        return c.json(errorBody("E_VALIDATION", error.message, error.details), 400);
      }
      throw error;
    }
    const body = {
      items: page.items,
      nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
    };
    deps.validate("WorkflowListResponse", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const raw = await readJsonObject(c, { maxBytes: MAX_WORKFLOW_JSON_BYTES });
    const parsed = createWorkflowRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Create-workflow body is invalid."), 400);
    }
    try {
      const document = await deps.service.create(toProject(found), parsed.data);
      return documentResponse(deps, c, document, 201);
    } catch (error) {
      if (isConflict(error)) return conflictResponse(c, error);
      throw error;
    }
  });

  app.get("/api/projects/:pid/workflows/:wid", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    try {
      const document = deps.service.get(toProject(found), c.req.param("wid"));
      return documentResponse(deps, c, document);
    } catch (error) {
      if (isConflict(error)) return conflictResponse(c, error);
      throw error;
    }
  });

  app.put("/api/projects/:pid/workflows/:wid", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const expected = parseIfMatch(c.req.header("if-match"));
    const raw = await readJsonObject(c, { maxBytes: MAX_WORKFLOW_JSON_BYTES });
    const parsed = saveWorkflowRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Save-workflow body is invalid."), 400);
    }
    try {
      const document = await deps.service.save(
        toProject(found),
        c.req.param("wid"),
        parsed.data.workflow,
        expected,
      );
      return documentResponse(deps, c, document);
    } catch (error) {
      if (isConflict(error)) return conflictResponse(c, error);
      throw error;
    }
  });

  app.delete("/api/projects/:pid/workflows/:wid", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const expected = parseIfMatch(c.req.header("if-match"));
    try {
      await deps.service.remove(toProject(found), c.req.param("wid"), expected);
      return c.body(null, 204);
    } catch (error) {
      if (isConflict(error)) return conflictResponse(c, error);
      throw error;
    }
  });

  app.post("/api/projects/:pid/workflows/:wid/validate", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const raw = await readJsonObject(c, { maxBytes: MAX_WORKFLOW_JSON_BYTES });
    const parsed = validateWorkflowRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Validate-workflow body is invalid."), 400);
    }
    const validation = deps.service.validate(
      toProject(found),
      c.req.param("wid"),
      parsed.data.workflow,
    );
    const body = { validation };
    deps.validate("ValidateWorkflowResponse", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/runs", async (c) => {
    const found = await project(c.req.param("pid"));
    if (found instanceof Response) return found;
    const raw = await readJsonObject(c, { maxBytes: MAX_WORKFLOW_JSON_BYTES });
    const parsed = startWorkflowRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Start-workflow-run body is invalid."), 400);
    }
    const idempotencyKey = c.req.header("idempotency-key");
    if (
      idempotencyKey !== undefined &&
      idempotencyKey !== "" &&
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(idempotencyKey)
    ) {
      return c.json(errorBody("E_VALIDATION", "Idempotency-Key is invalid."), 400);
    }
    let snapshot: RunWorkflowSnapshot;
    try {
      snapshot = await deps.service.run(toProject(found), c.req.param("wid"), parsed.data);
    } catch (error) {
      if (isConflict(error)) return conflictResponse(c, error);
      throw error;
    }
    if (deps.providerSettings !== undefined) {
      const off = disabledClisRequired(snapshot.snapshot, deps.providerSettings.disabled());
      if (off.length > 0) return c.json(providersOffResponse(off), 409);
    }
    let root: string;
    try {
      root = assertProjectPathAllowed(found.path, deps.dataDir);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
        return c.json(
          errorBody(
            "E_CONFLICT",
            "Project path is missing; relink the project before starting a run.",
          ),
          409,
        );
      }
      throw error;
    }
    const workspace = await validateRunWorkspace(
      deps.workspaceService,
      root,
      normalizeRunWorkspace(parsed.data.workspace),
    );
    const result = await deps.controller.startRun({
      projectId: found.id,
      workflowId: snapshot.workflowId,
      workflowFile: snapshot.workflowFile,
      snapshot: snapshot.snapshot,
      snapshotRaw: snapshot.snapshotRaw,
      params: snapshot.params as JsonObject,
      workspace,
      ...(idempotencyKey === undefined || idempotencyKey === "" ? {} : { idempotencyKey }),
    });
    const response = {
      runId: result.runId,
      duplicate: result.duplicate,
      status: result.status,
    };
    startRunResponseSchema.parse(response);
    deps.validate("StartRunResponse", response);
    return c.json(response, 202);
  });

  // Parent-child provenance (refs only, paginated, max 100/page). Child
  // results resolve via run detail / outputs endpoints, never hydrated here.
  app.get("/api/runs/:rid/children", async (c) => {
    const runId = c.req.param("rid");
    const found = await deps.store.getRun(runId);
    if (found === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json(errorBody("E_VALIDATION", "limit must be between 1 and 100."), 400);
    }
    const cursor = c.req.query("cursor") ?? undefined;
    if (cursor !== undefined && !/^\d{1,10}$/u.test(cursor)) {
      return c.json(errorBody("E_VALIDATION", "cursor is invalid."), 400);
    }
    if (!deps.store.listRunChildren) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Run children inspection is unavailable."), 501);
    }
    const page = await deps.store.listRunChildren(runId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    deps.validate("RunChildrenResponse", page);
    return c.json(page);
  });

  // Foreach per-item refs (max 100/page). Per-item result values resolve via
  // GET /api/runs/:rid/outputs/:outputId using the returned outputId.
  app.get("/api/runs/:rid/foreach/:sourceId/items", async (c) => {
    const runId = c.req.param("rid");
    const sourceId = c.req.param("sourceId");
    const found = await deps.store.getRun(runId);
    if (found === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json(errorBody("E_VALIDATION", "limit must be between 1 and 100."), 400);
    }
    const cursor = c.req.query("cursor") ?? undefined;
    if (cursor !== undefined && !/^\d{1,10}$/u.test(cursor)) {
      return c.json(errorBody("E_VALIDATION", "cursor is invalid."), 400);
    }
    if (!deps.store.listForeachItems) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Foreach item inspection is unavailable."), 501);
    }
    const page = await deps.store.listForeachItems(runId, sourceId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    if (page === null) return c.json(errorBody("E_NOT_FOUND", "Foreach source not found."), 404);
    deps.validate("ForeachItemsResponse", page);
    return c.json(page);
  });
}

function errorResponse(status: 404, message: string): Response {
  return Response.json(errorBody("E_NOT_FOUND", message), { status });
}
