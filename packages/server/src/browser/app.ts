import { realpathSync, statSync } from "node:fs";
import {
  type ErrorResponse,
  resumeRunRequestSchema,
  runContextQuerySchema,
  runEventsQuerySchema,
  runListQuerySchema,
  transcriptQuerySchema,
  usageQuerySchema,
} from "@devchestra/api";
import {
  type ExecStatus,
  isTerminalExecStatus,
  isTerminalRunStatus,
  RUN_STATUSES,
  type RunStatus,
} from "@devchestra/core";
import type { DecisionService } from "@devchestra/decisions";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DevChestraError, errorBody } from "../errors.js";
import type { BrowserPollPorts } from "../polling/ports.js";
import { mountPollRoutes } from "../polling/routes.js";
import { PollService } from "../polling/service.js";
import { mountWebhookIngress } from "../webhooks/ingress.js";
import type { BrowserWebhookPorts } from "../webhooks/ports.js";
import { mountWebhookRoutes } from "../webhooks/routes.js";
import { WebhookService } from "../webhooks/service.js";
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
  truncatedPreview,
} from "./execution.js";
import { mountGateRoutes } from "./gate-routes.js";
import { mountMcpRoutes } from "./mcp-routes.js";
import { mountModelRoutes } from "./model-routes.js";
import type {
  BrowserMcpServersPort,
  BrowserModelCatalogPort,
  BrowserProviderSettingsPort,
  BrowserQueryPort,
  BrowserRunControllerPort,
  BrowserStreamPort,
  BrowserWorkspacePort,
  CliProbeSummary,
  ExecutionDetailView,
  TranscriptPage,
} from "./ports.js";
import { mountProjectRoutes } from "./project-routes.js";
import type { ProviderStatusService } from "./provider-status.js";
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
  providerSettings?: BrowserProviderSettingsPort;
  providerStatus?: ProviderStatusService;
  mcpServers?: BrowserMcpServersPort;
  workspaceService?: BrowserWorkspacePort;
  /**
   * Decision-model service for the provider routes. Defaults to a live
   * `createDecisionService()` (process.env then cwd `.env`); tests inject a
   * stand-in-backed service.
   */
  decisions?: DecisionService;
  /**
   * Webhook triggers: store, engine launch and transitive freeze, composed by the
   * CLI. When absent, the webhook routes answer 501 and every hook is unknown.
   */
  webhooks?: BrowserWebhookPorts;
  /**
   * Polling triggers: store, engine probe/launch and transitive freeze, composed
   * by the CLI. When absent, the polling routes answer 501. The timer itself is
   * owned by the CLI's scheduler, not the app.
   */
  polling?: BrowserPollPorts;
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
  throw new DevChestraError("E_INTERNAL", "Controller returned an invalid run status.");
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
  const workflowService =
    deps.workflowService ??
    new ManagedWorkflowService({
      dataDir,
      ...(deps.providers === undefined ? {} : { providers: deps.providers }),
    });
  const webhookService =
    deps.webhooks === undefined
      ? null
      : new WebhookService({
          ports: deps.webhooks,
          workflows: workflowService,
          dataDir,
          getProject: (projectId) => deps.store.getProject(projectId),
          getRunStatus: async (runId) => (await deps.store.getRun(runId))?.status ?? null,
          ...(deps.workspaceService === undefined
            ? {}
            : { workspaceService: deps.workspaceService }),
        });
  const pollService =
    deps.polling === undefined
      ? null
      : new PollService({
          ports: deps.polling,
          workflows: workflowService,
          dataDir,
          getProject: (projectId) => deps.store.getProject(projectId),
          ...(deps.workspaceService === undefined
            ? {}
            : { workspaceService: deps.workspaceService }),
        });

  const app = new Hono();

  // The public delivery route is mounted before the guards below, which only
  // run for handlers registered after them. A webhook has no session or Origin.
  mountWebhookIngress(app, { service: webhookService, validate });

  app.use("*", securityHeaders());
  app.use("*", hostGuard(port));
  app.use("*", originGuard(port));

  const sessionAuthorized = (c: Context): boolean => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie !== undefined && cookie !== "" && constantTimeEqual(cookie, deps.sessionToken)) {
      return true;
    }
    const header = c.req.header("x-devchestra-token");
    return header !== undefined && header !== "" && constantTimeEqual(header, deps.sessionToken);
  };

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") {
      await next();
      return;
    }
    if (!sessionAuthorized(c)) {
      return c.json(errorBody("E_AUTH", "A DevChestra browser session is required."), 401);
    }
    await next();
  });
  app.use("/api/*", csrfGuard());

  const readOptionalJson = async (c: Context): Promise<Record<string, unknown>> => {
    const length = c.req.header("content-length");
    if (length === "0" || c.req.raw.body === null) return {};
    return readJsonObject(c, { maxBytes: MAX_JSON_BYTES });
  };

  // Liveness plus a cheap store-readiness probe. Always 200: the `ready`
  // flag (not the status code) carries readiness, so existing health
  // consumers and the attach handshake keep working when the store is down.
  app.get("/api/health", async (c) => {
    let store: "ok" | "error" = "ok";
    try {
      await deps.store.counts();
    } catch {
      store = "error";
    }
    const body = {
      ok: true as const,
      version: deps.version,
      uptimeMs: Math.max(0, now() - startedAt),
      instanceId: deps.instanceId,
      ready: store === "ok",
      checks: { store },
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

  app.get("/api/usage", async (c) => {
    const query = usageQuerySchema.safeParse({
      scope: c.req.query("scope") || undefined,
      projectId: c.req.query("projectId") || undefined,
    });
    if (!query.success) {
      return c.json(errorBody("E_VALIDATION", "Usage query is invalid."), 400);
    }
    const scope = query.data.scope ?? (query.data.projectId === undefined ? "global" : "project");
    if (scope === "project" && query.data.projectId === undefined) {
      return c.json(
        errorBody("E_VALIDATION", "Usage query requires projectId when scope is project."),
        400,
      );
    }
    if (scope === "global" && query.data.projectId !== undefined) {
      return c.json(
        errorBody("E_VALIDATION", "Usage query must not include projectId when scope is global."),
        400,
      );
    }
    const projectId = scope === "project" ? (query.data.projectId as string) : undefined;
    if (projectId !== undefined) {
      const project = await deps.store.getProject(projectId);
      if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    }
    if (deps.store.usageSummary === undefined) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Usage summary is not available."), 501);
    }
    const body = await deps.store.usageSummary({
      ...(projectId === undefined ? {} : { projectId }),
    });
    validate("UsageSummaryResponse", body);
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
    ...(deps.providerSettings === undefined ? {} : { providerSettings: deps.providerSettings }),
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
  mountCliRoutes(app, {
    ...(deps.providerSettings === undefined ? {} : { providerSettings: deps.providerSettings }),
    ...(deps.providerStatus === undefined ? {} : { providerStatus: deps.providerStatus }),
    validate,
  });
  mountApprovalRoutes(app, { store: deps.store, controller: deps.controller, validate });
  mountWorkflowRoutes(app, {
    store: deps.store,
    controller: deps.controller,
    service: workflowService,
    dataDir,
    ...(deps.workspaceService === undefined ? {} : { workspaceService: deps.workspaceService }),
    ...(deps.providerSettings === undefined ? {} : { providerSettings: deps.providerSettings }),
    ...(webhookService === null ? {} : { webhooks: webhookService }),
    ...(pollService === null ? {} : { polling: pollService }),
    validate,
  });
  mountWebhookRoutes(app, { store: deps.store, service: webhookService, validate });
  mountPollRoutes(app, { store: deps.store, service: pollService, validate });

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
        throw new DevChestraError("E_NOT_SUPPORTED", "Run archiving is unavailable.");
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
        errorBody("E_NOT_SUPPORTED", "That DevChestra API feature is not supported."),
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

  // Metadata-first run context: execution identity, attempt/loop round,
  // status, output id/hash/size. Values are fetched separately on demand.
  // Never hydrates full outputs; the picker works without a run. Schemas
  // resolve via the frozen run snapshot served by run detail.
  app.get("/api/runs/:rid/context", async (c) => {
    const runId = c.req.param("rid");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    if (!deps.store.runContext)
      return c.json(errorBody("E_NOT_SUPPORTED", "Context inspection is unavailable."), 501);
    const query = runContextQuerySchema.safeParse({
      pathPrefix: c.req.query("pathPrefix") || undefined,
      status: c.req.query("status") || undefined,
      limit: c.req.query("limit") || undefined,
      cursor: c.req.query("cursor") || undefined,
    });
    if (!query.success) {
      return c.json(errorBody("E_VALIDATION", "Context query is invalid."), 400);
    }
    const context = await deps.store.runContext(runId, {
      ...(query.data.pathPrefix === undefined ? {} : { pathPrefix: query.data.pathPrefix }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      limit: query.data.limit ?? 100,
      ...(query.data.cursor === undefined || query.data.cursor === null
        ? {}
        : { cursor: query.data.cursor }),
    });
    validate("RunContextResponse", context);
    return json(c, context);
  });

  // Bounded on-demand value retrieval with explicit truncation semantics.
  // Metadata bytes are checked first: oversized values return truncation
  // metadata without hydrating or parsing the full JSON. Enforces output
  // ownership against the run id; never silently unlimited.
  app.get("/api/runs/:rid/outputs/:outputId", async (c) => {
    const runId = c.req.param("rid");
    const outputId = c.req.param("outputId");
    const run = await deps.store.getRun(runId);
    if (run === null) return c.json(errorBody("E_NOT_FOUND", "Run not found."), 404);
    if (!deps.store.getOutputMetadataById || !deps.store.getOutputById) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Output inspection is unavailable."), 501);
    }
    const meta = await deps.store.getOutputMetadataById(outputId);
    if (meta === null || meta.runId !== runId) {
      return c.json(errorBody("E_NOT_FOUND", "Output not found."), 404);
    }
    const limit = 64 * 1024;
    if (meta.bytes > limit) {
      const preview = truncatedPreview(meta);
      validate("OutputPreview", preview);
      return json(c, preview);
    }
    const record = await deps.store.getOutputById(outputId);
    if (record === null || (record.runId as string) !== runId) {
      return c.json(errorBody("E_NOT_FOUND", "Output not found."), 404);
    }
    const preview = previewFromOutput(record);
    validate("OutputPreview", preview);
    return json(c, preview);
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
    const request = resumeRunRequestSchema.safeParse(await readOptionalJson(c));
    if (!request.success) return c.json(errorBody("E_VALIDATION", "Invalid resume request."), 400);
    const result = await deps.controller.resumeRun(runId, request.data);
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
        errorBody("E_NOT_SUPPORTED", "That DevChestra API feature is not supported."),
        501,
      );
    }
    if (isUnsupportedFeature(c.req.path)) {
      return c.json(
        errorBody("E_NOT_SUPPORTED", "That DevChestra API feature is not supported."),
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
