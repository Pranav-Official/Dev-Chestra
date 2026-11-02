import { executionSettingsSchema, webhookSettingsSchema } from "@devchestra/api";
import { EXECUTION_LIMITS } from "@devchestra/store";
import type { Context, Hono } from "hono";
import type { BrowserQueryPort, ProjectView } from "../browser/ports.js";
import { readJsonObject } from "../browser/security.js";
import { devchestraErrorCode, errorBody } from "../errors.js";
import { assertWorkflowId } from "../workflows/io.js";
import type { WebhookService } from "./service.js";

const MAX_SETTINGS_BYTES = 16 * 1024;
const EXECUTION_RANGE_MESSAGE = `maxConcurrentRuns must be a whole number from ${EXECUTION_LIMITS.maxConcurrentRuns.min} to ${EXECUTION_LIMITS.maxConcurrentRuns.max}, and maxQueueDepth from ${EXECUTION_LIMITS.maxQueueDepth.min} to ${EXECUTION_LIMITS.maxQueueDepth.max}.`;
const WEBHOOK_SETTINGS_MESSAGE =
  "publicBaseUrl must be an http or https origin, optionally with a path, or null.";

export interface WebhookRouteDeps {
  readonly store: BrowserQueryPort;
  /** Null when no webhook ports are composed: the routes then answer 501. */
  readonly service: WebhookService | null;
  readonly validate: (name: string, value: unknown) => void;
}

/** Browser-session routes for trigger management and the execution and webhook settings. */
export function mountWebhookRoutes(app: Hono, deps: WebhookRouteDeps): void {
  const unavailable = (c: Context): Response =>
    c.json(errorBody("E_NOT_SUPPORTED", "Webhook triggers are not available on this server."), 501);

  const projectOf = async (c: Context): Promise<ProjectView | Response> => {
    const found = await deps.store.getProject(c.req.param("pid") ?? "");
    if (found === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    return found;
  };

  app.get("/api/projects/:pid/workflows/:wid/webhook", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.status(project, workflowOf(c), originOf(c));
    deps.validate("WebhookTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/webhook/arm", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.arm(project, workflowOf(c), originOf(c));
    deps.validate("WebhookTriggerResponse", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/webhook/disarm", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.disarm(project, workflowOf(c), originOf(c));
    deps.validate("WebhookTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/webhook/rotate", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.rotate(project, workflowOf(c), originOf(c));
    deps.validate("WebhookTriggerResponse", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/webhook/refresh", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.refresh(project, workflowOf(c), originOf(c));
    deps.validate("WebhookTriggerStatus", body);
    return c.json(body);
  });

  app.get("/api/settings/execution", (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const body = service.executionSettings();
    deps.validate("ExecutionSettingsResponse", body);
    return c.json(body);
  });

  app.put("/api/settings/execution", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const parsed = executionSettingsSchema.safeParse(
      await readJsonObject(c, { maxBytes: MAX_SETTINGS_BYTES }),
    );
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", EXECUTION_RANGE_MESSAGE), 400);
    }
    let body: ReturnType<WebhookService["saveExecutionSettings"]>;
    try {
      body = service.saveExecutionSettings(parsed.data);
    } catch (error) {
      if (devchestraErrorCode(error) !== "E_VALIDATION") throw error;
      return c.json(errorBody("E_VALIDATION", EXECUTION_RANGE_MESSAGE), 400);
    }
    deps.validate("ExecutionSettingsResponse", body);
    return c.json(body);
  });

  app.get("/api/settings/webhooks", (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const body = service.webhookSettings();
    deps.validate("WebhookSettings", body);
    return c.json(body);
  });

  app.put("/api/settings/webhooks", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const parsed = webhookSettingsSchema.safeParse(
      await readJsonObject(c, { maxBytes: MAX_SETTINGS_BYTES }),
    );
    if (!parsed.success) return c.json(errorBody("E_VALIDATION", WEBHOOK_SETTINGS_MESSAGE), 400);
    let body: ReturnType<WebhookService["saveWebhookSettings"]>;
    try {
      body = service.saveWebhookSettings(parsed.data);
    } catch (error) {
      if (devchestraErrorCode(error) !== "E_VALIDATION") throw error;
      // The store's message names the rule that failed and never echoes credentials.
      return c.json(errorBody("E_VALIDATION", errorMessage(error)), 400);
    }
    deps.validate("WebhookSettings", body);
    return c.json(body);
  });
}

/** Validates the workflow id from the path before any webhook operation touches it. */
function workflowOf(c: Context): string {
  return assertWorkflowId(c.req.param("wid") ?? "");
}

function originOf(c: Context): string {
  return new URL(c.req.url).origin;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : WEBHOOK_SETTINGS_MESSAGE;
}
