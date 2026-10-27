import {
  type CatalogCli,
  type CliModelCatalog,
  catalogCliSchema,
  cliModelCatalogSchema,
} from "@relay/api";
import type { Context, Hono } from "hono";
import { errorBody, RelayError } from "../errors.js";
import type { BrowserModelCatalogPort, BrowserQueryPort } from "./ports.js";

const BODY_READ_TIMEOUT_MS = 2_000;

export interface ModelRouteDeps {
  store: BrowserQueryPort;
  modelCatalog?: BrowserModelCatalogPort;
  validate: (name: string, value: unknown) => void;
}

function rejectsQuery(c: Context): boolean {
  return new URL(c.req.url).search !== "";
}

/**
 * A bodyless POST must not carry data even when the client omits a truthful
 * Content-Length (chunked transfer). Read the actual stream, bounded by a short
 * timer, rather than trusting the header alone.
 */
async function hasRequestBody(c: Context): Promise<boolean> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && declared !== "") {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) return true;
    if (length > 0) return true;
  }
  const body = c.req.raw.body;
  if (body === null) return false;
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BODY_READ_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const pending = reader.read();
      pending.catch(() => undefined);
      const next = await Promise.race([pending, timedOut]);
      if (next === "timeout") return true;
      if (next.done) return false;
      if ((next.value?.byteLength ?? 0) > 0) return true;
    }
  } catch {
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled.
    }
  }
}

function safeCatalog(
  projectId: string,
  cli: CatalogCli,
  status: "unsupported" | "unavailable",
  message: string,
): CliModelCatalog {
  return {
    cli,
    projectId,
    status,
    scope: "relay-runtime",
    source: "none",
    cliVersion: null,
    items: [],
    fetchedAt: null,
    expiresAt: null,
    truncated: false,
    customSupported: true,
    message,
  };
}

function assertOutbound(value: unknown, projectId: string, cli: CatalogCli): CliModelCatalog {
  const parsed = cliModelCatalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new RelayError("E_INTERNAL", "Model catalog response was invalid.");
  }
  const catalog = parsed.data as CliModelCatalog;
  if (catalog.projectId !== projectId || catalog.cli !== cli) {
    throw new RelayError("E_INTERNAL", "Model catalog response did not match the request.");
  }
  return catalog;
}

export function mountModelRoutes(app: Hono, deps: ModelRouteDeps): void {
  const resolve = async (c: Context, refresh: boolean): Promise<Response> => {
    if (rejectsQuery(c)) {
      return c.json(
        errorBody("E_VALIDATION", "Model catalog routes do not accept query data."),
        400,
      );
    }
    if (await hasRequestBody(c)) {
      return c.json(errorBody("E_VALIDATION", "Request body is not allowed."), 400);
    }
    const projectId = c.req.param("pid") ?? "";
    const project = await deps.store.getProject(projectId);
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (project.missing) {
      return c.json(
        errorBody(
          "E_CONFLICT",
          "Project path is missing; relink the project before loading models.",
        ),
        409,
      );
    }
    const cli = catalogCliSchema.safeParse(c.req.param("cli"));
    if (!cli.success) {
      return c.json(errorBody("E_VALIDATION", "CLI is not supported for model discovery."), 400);
    }
    if (cli.data === "fake") {
      const body = safeCatalog(projectId, cli.data, "unsupported", "The fake CLI has no models.");
      deps.validate("CliModelCatalog", body);
      return c.json(body);
    }
    const port = deps.modelCatalog;
    if (port === undefined) {
      const body = safeCatalog(
        projectId,
        cli.data,
        "unsupported",
        "Model discovery is not available for this CLI.",
      );
      deps.validate("CliModelCatalog", body);
      return c.json(body);
    }
    let result: CliModelCatalog;
    try {
      result = refresh
        ? await port.refresh(projectId, cli.data)
        : await port.get(projectId, cli.data);
    } catch {
      const body = safeCatalog(
        projectId,
        cli.data,
        "unavailable",
        "Model discovery is temporarily unavailable.",
      );
      deps.validate("CliModelCatalog", body);
      return c.json(body);
    }
    const body = assertOutbound(result, projectId, cli.data);
    deps.validate("CliModelCatalog", body);
    return c.json(body);
  };

  app.get("/api/projects/:pid/clis/:cli/models", (c) => resolve(c, false));
  app.post("/api/projects/:pid/clis/:cli/models/refresh", (c) => resolve(c, true));
}
