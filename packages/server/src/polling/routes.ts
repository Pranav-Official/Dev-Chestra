import { pollArmRequestSchema } from "@devchestra/api";
import type { Context, Hono } from "hono";
import type { BrowserQueryPort, ProjectView } from "../browser/ports.js";
import { readJsonObject } from "../browser/security.js";
import { errorBody } from "../errors.js";
import { assertWorkflowId } from "../workflows/io.js";
import type { WorkflowProject } from "../workflows/service.js";
import type { PollService } from "./service.js";

const MAX_ARM_BYTES = 16 * 1024;

export interface PollRouteDeps {
  readonly store: BrowserQueryPort;
  /** Null when no polling ports are composed: the routes then answer 501. */
  readonly service: PollService | null;
  readonly validate: (name: string, value: unknown) => void;
}

/** Browser-session routes for polling trigger management and on-demand probes. */
export function mountPollRoutes(app: Hono, deps: PollRouteDeps): void {
  const unavailable = (c: Context): Response =>
    c.json(errorBody("E_NOT_SUPPORTED", "Polling triggers are not available on this server."), 501);

  const projectOf = async (c: Context): Promise<ProjectView | Response> => {
    const found = await deps.store.getProject(c.req.param("pid") ?? "");
    if (found === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    return found;
  };

  app.get("/api/projects/:pid/workflows/:wid/polling", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.status(toProject(project), workflowOf(c));
    deps.validate("PollTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/polling/arm", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const parsed = pollArmRequestSchema.safeParse(
      await readJsonObject(c, { maxBytes: MAX_ARM_BYTES }),
    );
    if (!parsed.success) {
      return c.json(
        errorBody("E_VALIDATION", "intervalSeconds must be a whole number of seconds."),
        400,
      );
    }
    const body = await service.arm(toProject(project), workflowOf(c), parsed.data.intervalSeconds);
    deps.validate("PollTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/polling/disarm", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.disarm(toProject(project), workflowOf(c));
    deps.validate("PollTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/polling/refresh", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.refresh(toProject(project), workflowOf(c));
    deps.validate("PollTriggerStatus", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/polling/probe-now", async (c) => {
    const service = deps.service;
    if (service === null) return unavailable(c);
    const project = await projectOf(c);
    if (project instanceof Response) return project;
    const body = await service.probeNow(toProject(project), workflowOf(c));
    deps.validate("PollProbeResult", body);
    return c.json(body);
  });
}

/** Validates the workflow id from the path before any polling operation touches it. */
function workflowOf(c: Context): string {
  return assertWorkflowId(c.req.param("wid") ?? "");
}

function toProject(project: ProjectView): WorkflowProject {
  return { id: project.id, path: project.path, kind: project.kind, missing: project.missing };
}
