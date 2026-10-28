import { realpathSync, statSync } from "node:fs";
import {
  type ErrorResponse,
  runEventsQuerySchema,
  runListQuerySchema,
  transcriptQuerySchema,
} from "@relay/api";
import {
  type ExecStatus,
  isTerminalExecStatus,
  isTerminalRunStatus,
  RUN_STATUSES,
  type RunStatus,
} from "@relay/core";
import type { DecisionService } from "@relay/decisions";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorBody, RelayError } from "../errors.js";
import { mountWorkflowRoutes } from "../workflows/routes.js";
import { ManagedWorkflowService } from "../workflows/service.js";
import { mountApprovalRoutes } from "./approval-routes.js";
import { browserError } from "./browser-error.js";
import { mountCliRoutes } from "./cli-routes.js";
import { makeResponseValidator } from "./contracts.js";
import { mountDecisionRoutes } from "./decision-routes.js";
import {
  buildAttempts,
  buildUsage,
  buildWorkspace,
  collectExecutionEvents,
  decodeExecutionPath,
  executionSummary,
  findInput,
  latestTranscriptRef,
  previewFromOutput,
} from "./execution.js";
import { mountGateRoutes } from "./gate-routes.js";
import { mountMcpRoutes } from "./mcp-routes.js";
import { mountModelRoutes } from "./model-routes.js";
import type {
  BrowserMcpServersPort,
  BrowserModelCatalogPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
  BrowserStreamPort,
  BrowserWorkspacePort,
  CliProbeSummary,
  ExecutionDetailView,
  TranscriptPage,
} from "./ports.js";
import { mountProjectRoutes } from "./project-routes.js";
import { mountRunStartRoute } from "./run-start-route.js";

import {
  applySecurityHeaders,
  constantTimeEqual,
  csrfGuard,
  hostGuard,
  isJsonContentType,
  isLoopbackHostAllowed,
  isLoopbackOriginAllowed,
  originGuard,
  readJsonObject,
  SESSION_COOKIE,
  safeLogLine,
  securityHeaders,
  sessionCookie,
} from "./security.js";
import {
  indexResponse,
  instructionsResponse,
  isKnownAppRoute,
  StaticWebRoot,
  staticResponse,
} from "./static.js";
import { parseTranscriptCursor, readTranscriptPage, unavailableTranscript } from "./transcript.js";
import { canonicalExistingDirectory } from "./workflow.js";

export interface BrowserAppDeps {
  dataDir: string;
  store: BrowserQueryPort;
  controller: BrowserRunControllerPort;
  stream?: BrowserStreamPort;
  sessionToken: string;
  instanceId: string;
  version: string;
  port: number | (() => number);
  webRoot?: string;
  now?: () => number;
  logger?: (line: string) => void;
  validateResponses?: boolean;
  responseValidator?: (name: string, value: unknown) => void;
  providers?: string[];
  clis?: CliProbeSummary[];
  defaults?: { agentTimeoutMin: number; shellTimeoutMin: number };
  workflowService?: ManagedWorkflowService;
  modelCatalog?: BrowserModelCatalogPort;
  mcpServers?: BrowserMcpServersPort;
  workspaceService?: BrowserWorkspacePort;
  /**
   * Decision-model service for the provider routes. Defaults to a live
   * `createDecisionService()` (process.env then cwd `.env`); tests inject a
   * stand-in-backed service.
   */
  decisions?: DecisionService;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const PREVIEW_LIMIT = 64 * 1024;
const KNOWN_RUN_STATUSES = new Set<string>(RUN_STATUSES);

function assertToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("sessionToken must be 32 random bytes encoded as base64url (43 characters)");
  }
}

function assertInstanceId(instanceId: string): void {
  if (instanceId === "" || instanceId.length > 128 || /\s/u.test(instanceId)) {
    throw new Error("instanceId must be a non-empty token without whitespace");
  }
}

function currentPort(port: number | (() => number)): number {
  return typeof port === "function" ? port() : port;
}

function isValidStatus(value: string): value is RunStatus {
  return KNOWN_RUN_STATUSES.has(value);
}

function isUnsupportedFeature(path: string): boolean {
  if (path === "/api/projects/detect") return true;
  if (/^\/api\/projects\/[^/]+\/pins(\/|$)/u.test(path)) return true;
  if (/^\/api\/projects\/[^/]+\/workflows\/import\/(review|commit)$/u.test(path)) return true;
  if (/^\/api\/projects\/[^/]+\/workflows\/[^/]+\/(expr\/test|export|pins)(\/|$)/u.test(path)) {
    return true;
  }
  if (/^\/api\/runs\/[^/]+\/(budget|pause|artifacts|supervisor)(\/|$)/u.test(path)) {
    return true;
  }
  if (/^\/api\/runs\/[^/]+\/executions\/.+\/(retry|cancel|pin|diff)$/u.test(path)) {
    return true;
  }
  if (/^\/api\/runs\/[^/]+\/stream$/u.test(path)) return true;
  if (path === "/api/stream") return true;
  return (
    path.startsWith("/api/providers/") ||
    path.startsWith("/api/context/") ||
    path === "/api/inbox" ||
    path.startsWith("/api/config/") ||
    path.startsWith("/api/storage")
  );
}
function json(c: Context, value: unknown, status: ContentfulStatusCode = 200): Response {
  return c.json(value, status);
}

function ensureRunStatus(value: unknown): RunStatus {
  if (typeof value === "string" && isValidStatus(value)) return value;
  throw new RelayError("E_INTERNAL", "Controller returned an invalid run status.");
}

export function createBrowserApp(deps: BrowserAppDeps): Hono {
  assertToken(deps.sessionToken);
  assertInstanceId(deps.instanceId);
  const dataDir = canonicalExistingDirectory(deps.dataDir, "Data directory");
  const web = new StaticWebRoot(deps.webRoot ?? null);
  const port = (): number => currentPort(deps.port);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const log = deps.logger ?? ((): void => undefined);
  const defaults = deps.defaults ?? { agentTimeoutMin: 30, shellTimeoutMin: 10 };
  const validate = makeResponseValidator(
    deps.validateResponses ?? process.env.NODE_ENV !== "production",
    deps.responseValidator,
  );

  const app = new Hono();

  app.use("*", securityHeaders());
  app.use("*", hostGuard(port));
  app.use("*", originGuard(port));

  const sessionAuthorized = (c: Context): boolean => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie !== undefined && cookie !== "" && constantTimeEqual(cookie, deps.sessionToken)) {
      return true;
    }
    const header = c.req.header("x-relay-token");
    return header !== undefined && header !== "" && constantTimeEqual(header, deps.sessionToken);
  };

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") {
      await next();
      return;
    }
    if (!sessionAuthorized(c)) {
      return c.json(errorBody("E_AUTH", "A Relay browser session is required."), 401);
    }
    await next();
  });
  app.use("/api/*", csrfGuard());

  const readOptionalJson = async (c: Context): Promise<Record<string, unknown>> => {
    const length = c.req.header("content-length");
    if (length === "0" || c.req.raw.body === null) return {};
    return readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
  };

  app.get("/api/health", (c) => {
    const body = {
      ok: true as const,
      version: deps.version,
      uptimeMs: Math.max(0, now() - startedAt),
      instanceId: deps.instanceId,
    };
    validate("HealthResponse", body);
    return json(c, body);
  });

  app.get("/api/bootstrap", async (c) => {
    const projects = await deps.store.listProjects();
    const counts = await deps.store.counts();
    const body = {
      version: deps.version,
      instanceId: deps.instanceId,
      projects,
      counts: { runs: counts.runs, activeRuns: counts.activeRuns, inbox: counts.inbox },
      providers: deps.providers ?? [],
      clis: deps.clis ?? [],
      settings: {
        server: { port: port() },
        defaults,
      },
    };
    validate("BootstrapResponse", body);
    return json(c, body);
  });

  mountProjectRoutes(app, {
    store: deps.store,
    dataDir,
    ...(deps.workspaceService === undefined ? {} : { workspaceService: deps.workspaceService }),
    validate,
  });
  mountGateRoutes(app, { store: deps.store, validate });
  mountDecisionRoutes(app, {
    store: deps.store,
    ...(deps.decisions === undefined ? {} : { decisions: deps.decisions }),
    validate,
  });
  mountRunStartRoute(app, {
    store: deps.store,
    controller: deps.controller,
    dataDir,
    ...(deps.workspaceService === undefined ? {} : { workspaceService: deps.workspaceService }),
    validate,
  });
  mountModelRoutes(app, {
    store: deps.store,
    ...(deps.modelCatalog === undefined ? {} : { modelCatalog: deps.modelCatalog }),
    validate,
  });
  mountMcpRoutes(app, {
    store: deps.store,
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
    validate,
  });
  mountCliRoutes(app, { validate });
  mountApprovalRoutes(app, { store: deps.store, controller: deps.controller, validate });
  mountWorkflowRoutes(app, {
    store: deps.store,
    controller: deps.controller,
    service:
      deps.workflowService ??
      new ManagedWorkflowService({
        dataDir,
        ...(deps.providers === undefined ? {} : { providers: deps.providers }),
      }),
    dataDir,
    ...(deps.workspaceService === undefined ? {} : { workspaceService: deps.workspaceService }),
    validate,
  });

  app.get("/api/runs", async (c) => {
    const query = runListQuerySchema.safeParse({
      archived: c.req.query("archived") || undefined,
      project: c.req.query("project") || undefined,
      workflow: c.req.query("workflow") || undefined,
      status: c.req.query("status") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!query.success) {
      return c.json(errorBody("E_VALIDATION", "Run list query is invalid."), 400);
    }
    const body = await deps.store.listRuns({
      archived: query.data.archived === "true",
      limit: query.data.limit ?? 50,
      ...(query.data.project === undefined ? {} : { projectId: query.data.project }),
      ...(query.data.workflow === undefined ? {} : { workflowId: query.data.workflow }),
      ...(query.data.status === undefined ? {} : { status: [query.data.status] }),
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
    });
    validate("RunListResponse", body);
    return json(c, body);
  });

  for (const action of ["archive", "restore"] as const) {
    app.post(`/api/runs/:rid/${action}`, async (c) => {
      await readOptionalJson(c);
      if (!deps.store.setRunArchived)
        throw new RelayError("E_NOT_SUPPORTED", "Run archiving is unavailable.");
      await deps.store.setRunArchived(c.req.param("rid"), action === "archive");
      return c.json({ ok: true });
    });
  }

  app.get("/api/runs/:rid", async (c) => {
    const detail = await deps.store.runDetail(c.req.param("rid"));
    if (detail === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    validate("RunDetailResponse", detail);
    return json(c, detail);
  });

  app.get("/api/runs/:rid/events", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const query = runEventsQuerySchema.safeParse({
      after: c.req.query("after") || undefined,
      upTo: c.req.query("upTo") || undefined,
      limit: c.req.query("limit") || undefined,
      types: c.req.queries("types"),
      pathPrefix: c.req.query("pathPrefix") || undefined,
    });
    if (!query.success) {
      return c.json(errorBody("E_VALIDATION", "Event query is invalid."), 400);
    }
    const page = await deps.store.eventsPage(runId, {
      limit: query.data.limit ?? 50,
      ...(query.data.after === undefined ? {} : { after: query.data.after }),
      ...(query.data.upTo === undefined ? {} : { upTo: query.data.upTo }),
      ...(query.data.types === undefined ? {} : { types: query.data.types }),
      ...(query.data.pathPrefix === undefined || query.data.pathPrefix === ""
        ? {}
        : { pathPrefix: query.data.pathPrefix }),
    });
    validate("EventPageResponse", page);
    return json(c, page);
  });

  app.get("/api/runs/:rid/executions/*", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    const rawPath = new URL(c.req.url).pathname;
    const marker = "/executions/";
    const markerIndex = rawPath.indexOf(marker);
    if (markerIndex === -1) return c.json(errorBody("E_NOT_FOUND", "Not found."), 404);
    let rest = rawPath.slice(markerIndex + marker.length);
    if (rest.endsWith("/transcript")) {
      rest = rest.slice(0, -"/transcript".length);
      const path = decodeExecutionPath(rest);
      if (path === null) return c.json(errorBody("E_VALIDATION", "Invalid execution path."), 400);
      const execution = await deps.store.getExecution(runId, path);
      if (execution === null) return c.json(errorBody("E_NOT_FOUND", "Execution not found."), 404);
      const query = transcriptQuerySchema.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) {
        return c.json(errorBody("E_VALIDATION", "Transcript query is invalid."), 400);
      }
      const limit = Math.min(query.data.limit ?? 200, 200);
      let cursor: number;
      try {
        cursor = parseTranscriptCursor(query.data.cursor);
      } catch {
        return c.json(errorBody("E_VALIDATION", "Invalid transcript cursor."), 400);
      }
      const history = await deps.store.executionHistory(runId, path);
      const latest = latestTranscriptRef(history);
      const ref =
        latest !== null &&
        latest.attempt === execution.attempt &&
        latest.generation === execution.generation
          ? latest
          : null;
      let page: TranscriptPage;
      if (ref === null) {
        const pending = !isTerminalExecStatus(execution.status as ExecStatus);
        page = unavailableTranscript(
          execution.attempt,
          execution.generation,
          pending ? "pending" : "unavailable",
        );
      } else {
        page = await readTranscriptPage({
          dataDir,
          projectId: run.projectId,
          runId,
          path,
          attempt: ref.attempt,
          generation: ref.generation,
          cursor,
          limit,
        });
      }
      validate("TranscriptPageResponse", page);
      return json(c, page);
    }

    if (/\/(retry|cancel|pin|diff)$/u.test(rest)) {
      return c.json(
        errorBody("E_NOT_SUPPORTED", "That Relay API feature is not available in P2."),
        501,
      );
    }
    const path = decodeExecutionPath(rest);
    if (path === null) return c.json(errorBody("E_VALIDATION", "Invalid execution path."), 400);
    const execution = await deps.store.getExecution(runId, path);
    if (execution === null) return c.json(errorBody("E_NOT_FOUND", "Execution not found."), 404);
    const events = await collectExecutionEvents(deps.store, runId, path);
    const history = await deps.store.executionHistory(runId, path);
    const { attempts, process } = buildAttempts(execution, history);
    const output = await deps.store.getOutput(runId, path, execution.attempt);
    const detail: ExecutionDetailView = {
      execution: executionSummary(execution),
      attempts,
      input: findInput(events, execution),
      output: output === null ? null : previewFromOutput(output),
      usage: buildUsage(events, execution),
      process,
      workspace: buildWorkspace(execution, events),
    };
    validate("ExecutionDetailResponse", detail);
    return json(c, detail);
  });

  app.post("/api/runs/:rid/cancel", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    await readOptionalJson(c);
    const result = await deps.controller.cancelRun(runId);
    const response = { runId: result.runId, status: ensureRunStatus(result.status) };
    validate("CommandResponse", response);
    return json(c, response, 202);
  });

  app.post("/api/runs/:rid/resume", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    if (isTerminalRunStatus(run.status)) {
      return c.json(errorBody("E_CONFLICT", `Run ${runId} is already ${run.status}.`), 409);
    }
    await readOptionalJson(c);
    const result = await deps.controller.resumeRun(runId);
    const response = { runId: result.runId, status: ensureRunStatus(result.status) };
    validate("CommandResponse", response);
    return json(c, response, 202);
  });

  deps.stream?.mountRoutes(app);

  app.all("/api/*", (c) => {
    const method = c.req.method.toUpperCase();
    if (
      (method === "PATCH" || method === "PUT" || method === "DELETE") &&
      /^\/api\/projects\/[^/]+$/u.test(c.req.path)
    ) {
      return c.json(
        errorBody("E_NOT_SUPPORTED", "That Relay API feature is not available in P2."),
        501,
      );
    }
    if (isUnsupportedFeature(c.req.path)) {
      return c.json(
        errorBody("E_NOT_SUPPORTED", "That Relay API feature is not available in P2."),
        501,
      );
    }
    return c.json(errorBody("E_NOT_FOUND", "Not found."), 404);
  });

  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/internal")) {
      return c.json(errorBody("E_NOT_FOUND", "Not found."), 404);
    }
    if (pathname === "/") {
      const token = c.req.query("t");
      if (token !== undefined) {
        if (!constantTimeEqual(token, deps.sessionToken)) {
          return instructionsResponse(c, 401);
        }
        c.header("Set-Cookie", sessionCookie(deps.sessionToken));
        c.header("Cache-Control", "no-store");
        return c.redirect("/", 303);
      }
    }
    const validCookie = (() => {
      const cookie = getCookie(c, SESSION_COOKIE);
      return cookie !== undefined && cookie !== "" && constantTimeEqual(cookie, deps.sessionToken);
    })();
    if (pathname === "/" || pathname === "/index.html" || isKnownAppRoute(pathname)) {
      if (!validCookie) return instructionsResponse(c);
      return indexResponse(c, web) ?? instructionsResponse(c);
    }
    const asset = staticResponse(c, web, pathname);
    if (asset !== null) return asset;
    return c.text("Not found.", 404);
  });

  app.notFound((c) => {
    if (
      c.req.path === "/api" ||
      c.req.path.startsWith("/api/") ||
      c.req.path === "/internal" ||
      c.req.path.startsWith("/internal/")
    ) {
      return c.json(errorBody("E_NOT_FOUND", "Not found."), 404);
    }
    return c.text("Not found.", 404);
  });

  app.onError((error, c) => {
    const safe = browserError(error);
    if (safe.code === "E_INTERNAL") {
      log(safeLogLine(c.req.method, c.req.routePath, safe.status));
    }
    const body: ErrorResponse = {
      error: {
        code: safe.code,
        message: safe.message,
        ...(safe.details === undefined ? {} : { details: safe.details }),
      },
    };
    const response = c.json(body, safe.status as ContentfulStatusCode);
    applySecurityHeaders(response.headers, c.req.path);
    return response;
  });

  return app;
}

export function browserWebRootError(webRoot: string): string {
  try {
    const real = realpathSync.native(webRoot);
    if (!statSync(real).isDirectory()) {
      return `Configured webRoot is not a directory: ${webRoot}`;
    }
    return "";
  } catch {
    return `Configured webRoot does not exist: ${webRoot}. Build the web app or pass the correct path.`;
  }
}

export const BROWSER_CONSTANTS = {
  MAX_JSON_BYTES,
  PREVIEW_LIMIT,
  SESSION_COOKIE,
} as const;

export { isJsonContentType, isLoopbackHostAllowed, isLoopbackOriginAllowed };
