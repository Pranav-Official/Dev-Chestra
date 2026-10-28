import {
  approvalListQuerySchema,
  approvalListResponseSchema,
  approvalResolveRequestSchema,
  approvalResolveResponseSchema,
} from "@devchestra/api";
import type { Hono } from "hono";
import { errorBody } from "../errors.js";
import type { BrowserQueryPort, BrowserRunControllerPort } from "./ports.js";
import { readJsonObject } from "./security.js";

const MAX_JSON_BYTES = 64 * 1024;

export interface ApprovalRouteDeps {
  store: BrowserQueryPort;
  controller: BrowserRunControllerPort;
  validate: (name: string, value: unknown) => void;
}

function decodePath(raw: string): string | null {
  try {
    const v = decodeURIComponent(raw);
    if (v.includes("\0") || v.length > 1024) return null;
    return v;
  } catch {
    return null;
  }
}

export function mountApprovalRoutes(app: Hono, deps: ApprovalRouteDeps): void {
  // Global inbox: GET /api/approvals?project=&cursor=&limit=
  app.get("/api/approvals", async (c) => {
    const parsed = approvalListQuerySchema.safeParse({
      project: c.req.query("project") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!parsed.success)
      return c.json(errorBody("E_VALIDATION", "Approvals query is invalid."), 400);
    const body = await deps.store.listApprovals({
      ...(parsed.data.project === undefined ? {} : { projectId: parsed.data.project }),
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      limit: parsed.data.limit ?? 50,
    });
    deps.validate("ApprovalListResponse", body);
    approvalListResponseSchema.parse(body);
    return c.json(body);
  });

  // Per-run list: GET /api/runs/:rid/approvals
  app.get("/api/runs/:rid/approvals", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const parsed = approvalListQuerySchema.safeParse({
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!parsed.success)
      return c.json(errorBody("E_VALIDATION", "Approvals query is invalid."), 400);
    const body = await deps.store.listApprovals({
      runId,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      limit: parsed.data.limit ?? 50,
    });
    deps.validate("ApprovalListResponse", body);
    return c.json(body);
  });

  // Detail: GET /api/runs/:rid/approvals/:approvalPath
  app.get("/api/runs/:rid/approvals/:approvalPath", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const path = decodePath(c.req.param("approvalPath") ?? "");
    if (path === null || path === "")
      return c.json(errorBody("E_VALIDATION", "Invalid approval path."), 400);
    const detail = await deps.store.getApproval(runId, path);
    if (detail === null) return c.json(errorBody("E_NOT_FOUND", "Approval not found."), 404);
    const body = {
      approval: detail.approval,
      execution: detail.execution,
      requestedEvent: detail.requestedEvent,
      resolvedEvent: detail.resolvedEvent ?? null,
    };
    return c.json(body);
  });

  // Resolve: POST /api/runs/:rid/approvals/:approvalPath/resolve
  app.post("/api/runs/:rid/approvals/:approvalPath/resolve", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const path = decodePath(c.req.param("approvalPath") ?? "");
    if (path === null || path === "")
      return c.json(errorBody("E_VALIDATION", "Invalid approval path."), 400);
    const raw = await readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
    const parsed = approvalResolveRequestSchema.safeParse(raw);
    if (!parsed.success)
      return c.json(errorBody("E_VALIDATION", "Approval resolve body is invalid."), 400);
    // Note bounded 4096, strip NUL
    const note = parsed.data.note;
    if (note?.includes("\0")) {
      return c.json(errorBody("E_VALIDATION", "Note must not contain NUL."), 400);
    }
    try {
      const result = await deps.controller.resolveApproval({
        runId,
        path,
        requestId: parsed.data.requestId,
        decision: parsed.data.decision,
        ...(note === undefined ? {} : { note }),
        expectedAttempt: parsed.data.expectedAttempt,
        expectedGeneration: parsed.data.expectedGeneration,
      });
      deps.validate("ApprovalResolveResponse", result);
      approvalResolveResponseSchema.parse(result);
      return c.json(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as Error).message ?? "Approval resolve failed.";
      if (code === "E_NOT_FOUND") return c.json(errorBody("E_NOT_FOUND", msg), 404);
      if (code === "E_CONFLICT") return c.json(errorBody("E_CONFLICT", msg), 409);
      if (code === "E_VALIDATION") return c.json(errorBody("E_VALIDATION", msg), 400);
      throw error;
    }
  });

  // Legacy compat: POST /api/runs/:rid/approvals/:path  (without /resolve) — strict, no fallback, return 404 to enforce canonical
  // Intentionally not mounted; canonical is /resolve only per plan.
}
