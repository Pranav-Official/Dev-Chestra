import { startRunRequestSchema } from "@devchestra/api";
import type { Hono } from "hono";
import { DevChestraError, errorBody } from "../errors.js";
import { parseParams } from "./execution.js";
import type {
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
  BrowserWorkspacePort,
} from "./ports.js";
import { disabledClisRequired, providersOffResponse } from "./provider-guard.js";
import { readJsonObject } from "./security.js";
import {
  assertProjectPathAllowed,
  loadBrowserWorkflow,
  validateWorkflowFileInput,
} from "./workflow.js";
import { normalizeRunWorkspace, validateRunWorkspace } from "./workspaces.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;

export interface RunStartRouteDeps {
  store: BrowserQueryPort;
  controller: BrowserRunControllerPort;
  workspaceService?: BrowserWorkspacePort;
  providerSettings?: BrowserProviderSettingsPort;
  dataDir: string;
  validate: (name: string, value: unknown) => void;
}

/** Legacy project-relative workflow start. Adds the run-level workspace choice. */
export function mountRunStartRoute(app: Hono, deps: RunStartRouteDeps): void {
  app.post("/api/projects/:pid/runs", async (c) => {
    const projectId = c.req.param("pid");
    const project = await deps.store.getProject(projectId);
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (project.missing) {
      return c.json(
        errorBody(
          "E_CONFLICT",
          "Project path is missing; relink the project before starting a run.",
        ),
        409,
      );
    }
    const body = await readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
    const parsed = startRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Start-run body is invalid."), 400);
    }
    const workflowFile = validateWorkflowFileInput(parsed.data.workflowFile);
    const params = parseParams(parsed.data.params);
    if (params === null) {
      return c.json(errorBody("E_VALIDATION", "params must be a JSON object."), 400);
    }
    let root: string;
    try {
      root = assertProjectPathAllowed(project.path, deps.dataDir);
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
    const loaded = await loadBrowserWorkflow({
      projectRoot: root,
      projectKind: project.kind,
      workflowFile,
      params,
    });
    if (deps.providerSettings !== undefined) {
      const off = disabledClisRequired(loaded.snapshot, deps.providerSettings.disabled());
      if (off.length > 0) return c.json(providersOffResponse(off), 409);
    }
    const workspace = await validateRunWorkspace(
      deps.workspaceService,
      root,
      normalizeRunWorkspace(parsed.data.workspace),
    );
    const idempotencyKey = c.req.header("idempotency-key");
    if (
      idempotencyKey !== undefined &&
      idempotencyKey !== "" &&
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(idempotencyKey)
    ) {
      return c.json(errorBody("E_VALIDATION", "Idempotency-Key is invalid."), 400);
    }
    const result = await deps.controller.startRun({
      projectId,
      workflowId: loaded.workflowId,
      workflowFile: loaded.workflowFile,
      snapshot: loaded.snapshot,
      snapshotRaw: loaded.snapshotRaw,
      params,
      workspace,
      ...(idempotencyKey === undefined || idempotencyKey === "" ? {} : { idempotencyKey }),
    });
    const response = {
      runId: result.runId,
      duplicate: result.duplicate,
      status: result.status,
    };
    deps.validate("StartRunResponse", response);
    return c.json(response, 202);
  });
}
