import { z } from "zod";
import {
  type ApprovalListQuery,
  type ApprovalListResponse,
  type ApprovalResolveRequest,
  type ApprovalResolveResponse,
  approvalDetailResponseSchema,
  approvalListResponseSchema,
  approvalResolveRequestSchema,
  approvalResolveResponseSchema,
} from "./approval-dto.js";
import {
  API_MAJOR,
  API_MAJOR_HEADER,
  CSRF_HEADER,
  CSRF_VALUE,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
  TOKEN_HEADER,
} from "./constants.js";
import {
  type BootstrapResponse,
  bootstrapResponseSchema,
  type CliListResponse,
  type CommandResponse,
  cliListResponseSchema,
  commandResponseSchema,
  type ExecutionDetailResponse,
  executionDetailResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type ListProjectsQuery,
  type ListProjectsResponse,
  listProjectsResponseSchema,
  type ProjectView,
  projectViewSchema,
  type RegisterProjectRequest,
  type RelinkProjectRequest,
  type RunDetailResponse,
  type RunListQuery,
  type RunListResponse,
  registerProjectRequestSchema,
  relinkProjectRequestSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  type StartRunRequest,
  type StartRunResponse,
  startRunRequestSchema,
  startRunResponseSchema,
  type TranscriptPageResponse,
  type TranscriptQuery,
  transcriptPageResponseSchema,
} from "./dto.js";
import { ApiError, ApiProtocolError, ApiTransportError, errorResponseSchema } from "./errors.js";
import { type EventPageResponse, eventPageResponseSchema, type RunEventsQuery } from "./events.js";
import {
  type CatalogCli,
  type CliModelCatalog,
  catalogCliSchema,
  cliModelCatalogSchema,
} from "./model-catalog.js";
import { apiPath } from "./primitives.js";
import {
  type GlobalStreamMessage,
  parseGlobalStreamEvent,
  parseRunStreamEvent,
  type RunStreamMessage,
  type RunStreamQuery,
  readSse,
  type SseEvent,
} from "./sse.js";
import {
  type ProjectWorkspacesResponse,
  projectWorkspacesResponseSchema,
} from "./workspace-dto.js";

export interface ApiClientOptions {
  /** Defaults to the current origin (empty string). */
  baseUrl?: string;
  /** Injection seam for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** `relay` CLI header auth. Browsers authenticate with the session cookie. */
  token?: string;
  /** Refuse to run against a different API major. */
  apiMajor?: number;
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

export interface StartRunOptions extends ApiRequestOptions {
  /** Optional durable idempotency key; replay returns duplicate: true. */
  idempotencyKey?: string;
}

type QueryValue = string | number | boolean | undefined | readonly (string | number)[];

interface RequestConfig {
  query: Record<string, QueryValue> | undefined;
  body: unknown;
  signal: AbortSignal | undefined;
  mutation: boolean;
  extraHeaders: Record<string, string> | undefined;
}

interface StreamConfig {
  query: Record<string, QueryValue> | undefined;
  signal: AbortSignal | undefined;
}

function buildQuery(query: Record<string, QueryValue> | undefined): URLSearchParams | undefined {
  if (query === undefined) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  return params.size === 0 ? undefined : params;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Typed fetch client for `/api`. Same-origin cookies by default, explicit
 * token support for the CLI, CSRF on mutations and a major-version check.
 */
export class ApiClientBase {
  readonly baseUrl: string;
  protected readonly fetcher: typeof fetch;
  protected readonly tokenValue: string | null;

  constructor(options: ApiClientOptions = {}) {
    const major = options.apiMajor ?? API_MAJOR;
    if (major !== API_MAJOR) {
      throw new ApiProtocolError(
        "version",
        `@relay/api supports major ${API_MAJOR}, not ${String(major)}`,
      );
    }
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/u, "");
    const injected = options.fetch;
    if (injected !== undefined) {
      // Injected fetches keep plain-function call semantics.
      this.fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
        injected(input, init)) as typeof fetch;
    } else {
      if (typeof globalThis.fetch !== "function") {
        throw new ApiTransportError("fetch is unavailable in this runtime");
      }
      // Browsers brand-check `this`: call the native fetch as a Window method,
      // and never as a method on this client (`Illegal invocation`).
      this.fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)) as typeof fetch;
    }
    this.tokenValue = options.token ?? null;
  }

  health(options: ApiRequestOptions = {}): Promise<HealthResponse> {
    return this.request("GET", ["health"], healthResponseSchema, this.req(options));
  }

  bootstrap(options: ApiRequestOptions = {}): Promise<BootstrapResponse> {
    return this.request("GET", ["bootstrap"], bootstrapResponseSchema, this.req(options));
  }

  listProjects(
    query: ListProjectsQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<ListProjectsResponse> {
    return this.request(
      "GET",
      ["projects"],
      listProjectsResponseSchema,
      this.req(options, { query: { cursor: query.cursor, limit: query.limit } }),
    );
  }

  async registerProject(
    body: RegisterProjectRequest,
    options: ApiRequestOptions = {},
  ): Promise<ProjectView> {
    const parsed = registerProjectRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects"],
      projectViewSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  getProject(projectId: string, options: ApiRequestOptions = {}): Promise<ProjectView> {
    return this.request("GET", ["projects", projectId], projectViewSchema, this.req(options));
  }

  /**
   * Git worktree catalog for a run-start workspace picker. The project root is
   * the separate default and is never listed among the alternatives.
   */
  listProjectWorkspaces(
    projectId: string,
    options: ApiRequestOptions = {},
  ): Promise<ProjectWorkspacesResponse> {
    return this.request(
      "GET",
      ["projects", projectId, "workspaces"],
      projectWorkspacesResponseSchema,
      this.req(options),
    );
  }

  async getCliModels(
    projectId: string,
    cli: CatalogCli,
    options: ApiRequestOptions = {},
  ): Promise<CliModelCatalog> {
    const parsedCli = catalogCliSchema.parse(cli);
    return this.request(
      "GET",
      ["projects", projectId, "clis", parsedCli, "models"],
      cliModelCatalogSchema,
      this.req(options),
    );
  }

  async refreshCliModels(
    projectId: string,
    cli: CatalogCli,
    options: ApiRequestOptions = {},
  ): Promise<CliModelCatalog> {
    const parsedCli = catalogCliSchema.parse(cli);
    return this.request(
      "POST",
      ["projects", projectId, "clis", parsedCli, "models", "refresh"],
      cliModelCatalogSchema,
      this.req(options, { mutation: true }),
    );
  }

  listClis(options: ApiRequestOptions = {}): Promise<CliListResponse> {
    return this.request("GET", ["clis"], cliListResponseSchema, this.req(options));
  }

  async relinkProject(
    projectId: string,
    body: RelinkProjectRequest,
    options: ApiRequestOptions = {},
  ): Promise<ProjectView> {
    const parsed = relinkProjectRequestSchema.parse(body);
    return this.request(
      "POST",
      ["projects", projectId, "relink"],
      projectViewSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  listRuns(query: RunListQuery = {}, options: ApiRequestOptions = {}): Promise<RunListResponse> {
    return this.request(
      "GET",
      ["runs"],
      runListResponseSchema,
      this.req(options, {
        query: {
          archived: query.archived,
          project: query.project,
          workflow: query.workflow,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        },
      }),
    );
  }

  removeProject(projectId: string): Promise<{ ok: true }> {
    return this.request(
      "DELETE",
      ["projects", projectId],
      z.object({ ok: z.literal(true) }),
      this.req({}, { mutation: true }),
    );
  }

  setRunArchived(runId: string, archived: boolean): Promise<{ ok: true }> {
    return this.request(
      "POST",
      ["runs", runId, archived ? "archive" : "restore"],
      z.object({ ok: z.literal(true) }),
      this.req({}, { body: {}, mutation: true }),
    );
  }

  archiveWorkflowRuns(projectId: string, workflowId: string): Promise<{ ok: true }> {
    return this.request(
      "POST",
      ["projects", projectId, "workflows", workflowId, "archive-runs"],
      z.object({ ok: z.literal(true) }),
      this.req({}, { body: {}, mutation: true }),
    );
  }

  projectRunSummaries(
    projectId: string,
    options: ApiRequestOptions = {},
  ): Promise<RunListResponse> {
    return this.request(
      "GET",
      ["projects", projectId, "run-summaries"],
      runListResponseSchema,
      this.req(options),
    );
  }

  getRun(runId: string, options: ApiRequestOptions = {}): Promise<RunDetailResponse> {
    return this.request("GET", ["runs", runId], runDetailResponseSchema, this.req(options));
  }

  listRunEvents(
    runId: string,
    query: RunEventsQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<EventPageResponse> {
    return this.request(
      "GET",
      ["runs", runId, "events"],
      eventPageResponseSchema,
      this.req(options, {
        query: {
          after: query.after,
          upTo: query.upTo,
          limit: query.limit,
          types: query.types,
          pathPrefix: query.pathPrefix,
        },
      }),
    );
  }

  getExecution(
    runId: string,
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ExecutionDetailResponse> {
    return this.request(
      "GET",
      ["runs", runId, "executions", path],
      executionDetailResponseSchema,
      this.req(options),
    );
  }

  getExecutionTranscript(
    runId: string,
    path: string,
    query: TranscriptQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<TranscriptPageResponse> {
    return this.request(
      "GET",
      ["runs", runId, "executions", path, "transcript"],
      transcriptPageResponseSchema,
      this.req(options, { query: { cursor: query.cursor, limit: query.limit } }),
    );
  }

  async startRun(
    projectId: string,
    body: StartRunRequest,
    options: StartRunOptions = {},
  ): Promise<StartRunResponse> {
    const parsed = startRunRequestSchema.parse(body);
    const extraHeaders =
      options.idempotencyKey === undefined
        ? undefined
        : { [IDEMPOTENCY_HEADER]: options.idempotencyKey };
    return this.request(
      "POST",
      ["projects", projectId, "runs"],
      startRunResponseSchema,
      this.req(options, { body: parsed, mutation: true, extraHeaders }),
    );
  }

  cancelRun(runId: string, options: ApiRequestOptions = {}): Promise<CommandResponse> {
    return this.request(
      "POST",
      ["runs", runId, "cancel"],
      commandResponseSchema,
      this.req(options, { mutation: true }),
    );
  }

  resumeRun(runId: string, options: ApiRequestOptions = {}): Promise<CommandResponse> {
    return this.request(
      "POST",
      ["runs", runId, "resume"],
      commandResponseSchema,
      this.req(options, { mutation: true }),
    );
  }

  listApprovals(
    query: ApprovalListQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<ApprovalListResponse> {
    return this.request(
      "GET",
      ["approvals"],
      approvalListResponseSchema,
      this.req(options, {
        query: { project: query.project, cursor: query.cursor, limit: query.limit },
      }),
    );
  }

  listRunApprovals(
    runId: string,
    query: ApprovalListQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<ApprovalListResponse> {
    return this.request(
      "GET",
      ["runs", runId, "approvals"],
      approvalListResponseSchema,
      this.req(options, { query: { cursor: query.cursor, limit: query.limit } }),
    );
  }

  getApproval(runId: string, path: string, options: ApiRequestOptions = {}): Promise<unknown> {
    return this.request(
      "GET",
      ["runs", runId, "approvals", path],
      approvalDetailResponseSchema,
      this.req(options),
    );
  }

  async resolveApproval(
    runId: string,
    path: string,
    body: ApprovalResolveRequest,
    options: ApiRequestOptions = {},
  ): Promise<ApprovalResolveResponse> {
    const parsed = approvalResolveRequestSchema.parse(body);
    return this.request(
      "POST",
      ["runs", runId, "approvals", path, "resolve"],
      approvalResolveResponseSchema,
      this.req(options, { body: parsed, mutation: true }),
    );
  }

  async *streamRunEvents(
    runId: string,
    query: RunStreamQuery = {},
    options: ApiRequestOptions = {},
  ): AsyncGenerator<RunStreamMessage> {
    for await (const event of this.stream(
      ["runs", runId, "stream"],
      { after: query.after, upTo: query.upTo },
      options,
    )) {
      const message = parseRunStreamEvent(event);
      if (message !== null) yield message;
    }
  }

  async *streamGlobalEvents(options: ApiRequestOptions = {}): AsyncGenerator<GlobalStreamMessage> {
    for await (const event of this.stream(["stream"], undefined, options)) {
      const message = parseGlobalStreamEvent(event);
      if (message !== null) yield message;
    }
  }

  protected req(
    options: ApiRequestOptions,
    overrides: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      mutation?: boolean;
      extraHeaders?: Record<string, string> | undefined;
    } = {},
  ): RequestConfig {
    return {
      query: overrides.query,
      body: overrides.body,
      signal: options.signal,
      mutation: overrides.mutation ?? false,
      extraHeaders: overrides.extraHeaders,
    };
  }

  protected url(segments: readonly string[], query: URLSearchParams | undefined): string {
    const path = `${this.baseUrl}${apiPath(...segments)}`;
    const search = query?.toString();
    return search === undefined || search === "" ? path : `${path}?${search}`;
  }

  protected headers(mutation: boolean, sse: boolean): Headers {
    const headers = new Headers();
    headers.set(API_MAJOR_HEADER, String(API_MAJOR));
    if (this.tokenValue !== null) headers.set(TOKEN_HEADER, this.tokenValue);
    headers.set("Accept", sse ? "text/event-stream" : "application/json");
    if (mutation) {
      headers.set(CSRF_HEADER, CSRF_VALUE);
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  protected async request<T>(
    method: string,
    segments: readonly string[],
    schema: z.ZodType<T>,
    config: RequestConfig,
  ): Promise<T> {
    const url = this.url(segments, buildQuery(config.query));
    const headers = this.headers(config.mutation, false);
    if (config.extraHeaders !== undefined) {
      for (const [key, value] of Object.entries(config.extraHeaders)) headers.set(key, value);
    }
    const init: RequestInit = { method, headers, credentials: "same-origin" };
    if (config.signal !== undefined) init.signal = config.signal;
    let bodyText: string | undefined;
    if (config.body !== undefined) {
      bodyText = JSON.stringify(config.body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    if (bodyText !== undefined) init.body = bodyText;

    const response = await this.fetchResponse(url, init, config.signal);
    this.verifyVersion(response);
    if (!response.ok) throw await this.toApiError(response);

    const text = await response.text().catch((error: unknown) => {
      throw new ApiProtocolError("invalid-response", "Could not read the response body", error);
    });
    if (text === "") {
      throw new ApiProtocolError("invalid-response", `Empty ${response.status} response body`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ApiProtocolError(
        "invalid-response",
        `Invalid JSON in ${response.status} response`,
        error,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiProtocolError(
        "invalid-response",
        "Response does not match @relay/api",
        parsed.error,
      );
    }
    return parsed.data;
  }

  protected async requestEmpty(
    method: string,
    segments: readonly string[],
    config: RequestConfig,
  ): Promise<void> {
    const url = this.url(segments, buildQuery(config.query));
    const headers = this.headers(config.mutation, false);
    if (config.extraHeaders !== undefined) {
      for (const [key, value] of Object.entries(config.extraHeaders)) headers.set(key, value);
    }
    const init: RequestInit = { method, headers, credentials: "same-origin" };
    if (config.signal !== undefined) init.signal = config.signal;
    const response = await this.fetchResponse(url, init, config.signal);
    this.verifyVersion(response);
    if (!response.ok) throw await this.toApiError(response);
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
  }

  protected async *stream(
    segments: readonly string[],
    query: Record<string, QueryValue> | undefined,
    options: ApiRequestOptions,
  ): AsyncGenerator<SseEvent> {
    const config: StreamConfig = { query, signal: options.signal };
    const url = this.url(segments, buildQuery(config.query));
    const headers = this.headers(false, true);
    const init: RequestInit = { method: "GET", headers, credentials: "same-origin" };
    if (config.signal !== undefined) init.signal = config.signal;

    const response = await this.fetchResponse(url, init, config.signal);
    this.verifyVersion(response);
    if (!response.ok) throw await this.toApiError(response);
    const media = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (media !== "text/event-stream") {
      throw new ApiProtocolError(
        "event-stream",
        `Expected text/event-stream, received ${media ?? "none"}`,
      );
    }
    if (response.body === null) {
      throw new ApiProtocolError("event-stream", "SSE response has no body");
    }
    if (config.signal?.aborted === true) throw abortError();
    yield* readSse(response.body, config.signal);
  }

  protected async fetchResponse(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, init);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new ApiTransportError("Network request failed", error);
    }
  }

  protected verifyVersion(response: Response): void {
    const major = response.headers.get(API_MAJOR_HEADER);
    if (major === null) {
      throw new ApiProtocolError("version", `Response is missing ${API_MAJOR_HEADER}`);
    }
    if (major !== String(API_MAJOR)) {
      throw new ApiProtocolError(
        "version",
        `Server API major ${major} is not supported (client expects ${API_MAJOR})`,
      );
    }
  }

  protected async toApiError(response: Response): Promise<ApiError> {
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const text = await response.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new ApiProtocolError(
        "invalid-response",
        `Non-JSON error response (${response.status})`,
        error,
      );
    }
    const parsed = errorResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiProtocolError(
        "invalid-response",
        `Error response does not match @relay/api (${response.status})`,
        parsed.error,
      );
    }
    return new ApiError(
      parsed.data.error.code,
      parsed.data.error.message,
      response.status,
      parsed.data.error.details,
      requestId,
    );
  }
}
