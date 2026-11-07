import { basename } from "node:path";
import {
  listProjectsQuerySchema,
  registerProjectRequestSchema,
  relinkProjectRequestSchema,
} from "@devchestra/api";
import type { Hono } from "hono";
import { DevChestraError, errorBody } from "../errors.js";
import { seedLocalModelTiers } from "../settings/store.js";
import type { ManagedWorkflowService } from "../workflows/service.js";
import { pickStarterCli, seedStarterWorkflows } from "../workflows/starters.js";
import type { ProviderStatusService } from "./provider-status.js";
import type {
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserWorkspacePort,
  ProjectView,
} from "./ports.js";
import { readJsonObject } from "./security.js";
import { assertProjectPathAllowed, projectKind, validateProjectPathInput } from "./workflow.js";
import { listRunWorkspaces } from "./workspaces.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROJECT_LIMIT = 50;
const MAX_PROJECT_LIMIT = 500;

interface ProjectCursor {
  addedAt: number;
  id: string;
}

function encodeProjectCursor(project: ProjectView): string {
  return Buffer.from(`${project.addedAt}:${project.id}`, "utf8").toString("base64url");
}

function decodeProjectCursor(value: string): ProjectCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  const addedAt = Number(decoded.slice(0, colon));
  const id = decoded.slice(colon + 1);
  if (!Number.isSafeInteger(addedAt) || addedAt < 0 || id === "" || id.length > 128) return null;
  return { addedAt, id };
}

function compareProjects(left: ProjectView, right: ProjectView): number {
  return left.addedAt - right.addedAt || left.id.localeCompare(right.id);
}

export interface ProjectRouteDeps {
  store: BrowserQueryPort;
  dataDir: string;
  workspaceService?: BrowserWorkspacePort;
  /** With a workflow service, newly registered projects get the starter workflows. */
  workflowService?: ManagedWorkflowService;
  providerStatus?: ProviderStatusService;
  providerSettings?: BrowserProviderSettingsPort;
  validate: (name: string, value: unknown) => void;
}

async function starterCli(deps: ProjectRouteDeps) {
  let ready = new Set<string>();
  try {
    const statuses = (await deps.providerStatus?.getAll()) ?? [];
    ready = new Set(statuses.filter((s) => s.state === "ready").map((s) => s.id));
  } catch {
    // Detection is best effort; fall back to the default CLI.
  }
  return pickStarterCli(ready, deps.providerSettings?.disabled());
}

export function mountProjectRoutes(app: Hono, deps: ProjectRouteDeps): void {
  app.delete("/api/projects/:pid", async (c) => {
    if (!deps.store.removeProject)
      throw new DevChestraError("E_NOT_SUPPORTED", "Project removal is unavailable.");
    await deps.store.removeProject(c.req.param("pid"));
    return c.json({ ok: true });
  });

  app.get("/api/projects/:pid/run-summaries", async (c) => {
    const pid = c.req.param("pid");
    if ((await deps.store.getProject(pid)) === null)
      return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (!deps.store.projectRunSummaries)
      throw new DevChestraError("E_NOT_SUPPORTED", "Run summaries are unavailable.");
    const body = await deps.store.projectRunSummaries(pid);
    deps.validate("RunListResponse", body);
    return c.json(body);
  });

  app.post("/api/projects/:pid/workflows/:wid/archive-runs", async (c) => {
    if ((await deps.store.getProject(c.req.param("pid"))) === null)
      return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (!deps.store.archiveWorkflowRuns)
      throw new DevChestraError("E_NOT_SUPPORTED", "Run archiving is unavailable.");
    await deps.store.archiveWorkflowRuns(c.req.param("pid"), c.req.param("wid"));
    return c.json({ ok: true });
  });

  app.get("/api/projects", async (c) => {
    const query = listProjectsQuerySchema.safeParse({
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!query.success) {
      return c.json(errorBody("E_VALIDATION", "Project list query is invalid."), 400);
    }
    const limit = query.data.limit ?? DEFAULT_PROJECT_LIMIT;
    if (limit < 1 || limit > MAX_PROJECT_LIMIT) {
      return c.json(errorBody("E_VALIDATION", "limit must be between 1 and 500."), 400);
    }
    const all = [...(await deps.store.listProjects())].sort(compareProjects);
    let start = 0;
    if (query.data.cursor !== undefined) {
      const cursor = decodeProjectCursor(query.data.cursor);
      if (cursor === null) {
        return c.json(errorBody("E_VALIDATION", "Project cursor is invalid."), 400);
      }
      const index = all.findIndex(
        (project) => project.addedAt === cursor.addedAt && project.id === cursor.id,
      );
      if (index === -1) {
        return c.json(errorBody("E_VALIDATION", "Project cursor is not valid for this list."), 400);
      }
      start = index + 1;
    }
    const page = all.slice(start, start + limit);
    const last = page.at(-1);
    const hasMore = last !== undefined && all.length > start + page.length;
    const body = {
      items: page,
      nextCursor: hasMore && last !== undefined ? encodeProjectCursor(last) : null,
    };
    deps.validate("ListProjectsResponse", body);
    return c.json(body);
  });

  app.get("/api/projects/:pid", async (c) => {
    const project = await deps.store.getProject(c.req.param("pid"));
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    deps.validate("ProjectView", project);
    return c.json(project);
  });

  app.get("/api/projects/:pid/workspaces", async (c) => {
    const project = await deps.store.getProject(c.req.param("pid"));
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    let root: string;
    try {
      root = assertProjectPathAllowed(project.path, deps.dataDir);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
        return c.json(
          errorBody(
            "E_CONFLICT",
            "Project path is missing; relink the project before choosing a workspace.",
          ),
          409,
        );
      }
      throw error;
    }
    const body = await listRunWorkspaces(deps.workspaceService, root);
    deps.validate("ProjectWorkspacesResponse", body);
    return c.json(body);
  });

  app.post("/api/projects", async (c) => {
    const body = await readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
    const parsed = registerProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Project registration body is invalid."), 400);
    }
    const input = validateProjectPathInput(parsed.data.path);
    const canonical = assertProjectPathAllowed(input, deps.dataDir);
    const isNew =
      parsed.data.seedStarters !== false &&
      deps.workflowService !== undefined &&
      !(await deps.store.listProjects()).some((existing) => existing.path === canonical);
    const project = await deps.store.registerProject({
      path: canonical,
      name: basename(canonical) || "project",
      kind: projectKind(canonical),
    });
    if (isNew && deps.workflowService !== undefined) {
      // The starters name model tiers, so map any tier the project does not set yet to the
      // first ready provider; they then run here without editing. Best effort, like the starters.
      try {
        await seedLocalModelTiers(canonical, await starterCli(deps));
        await seedStarterWorkflows(deps.workflowService, project);
      } catch {
        // Starters are a convenience; registration already succeeded.
      }
    }
    deps.validate("ProjectView", project);
    return c.json(project);
  });

  app.post("/api/projects/:pid/relink", async (c) => {
    const projectId = c.req.param("pid");
    const existing = await deps.store.getProject(projectId);
    if (existing === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    const body = await readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
    const parsed = relinkProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Project relink body is invalid."), 400);
    }
    const input = validateProjectPathInput(parsed.data.path);
    const canonical = assertProjectPathAllowed(input, deps.dataDir);
    const project = await deps.store.relinkProject({
      projectId,
      path: canonical,
      name: existing.name,
      kind: projectKind(canonical),
    });
    deps.validate("ProjectView", project);
    return c.json(project);
  });
}
