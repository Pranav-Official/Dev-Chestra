import type { ErrorCode } from "@devchestra/core";
import { z } from "./zod.js";

/** The core taxonomy, plus API-only codes the core does not produce. */
const CORE_ERROR_CODES = [
  "E_VALIDATION",
  "E_NOT_FOUND",
  "E_CONFLICT",
  "E_AUTH",
  "E_FORBIDDEN_PATH",
  "E_WORKFLOW_INVALID",
  "E_EXPR",
  "E_OUTPUT_INVALID",
  "E_ATTEMPTS_EXHAUSTED",
  "E_CLI_MISSING",
  "E_CLI_AUTH",
  "E_CLI_CRASH",
  "E_QUOTA_WINDOW",
  "E_QUOTA_CREDITS",
  "E_RATE_LIMIT",
  "E_PROVIDER",
  "E_PROVIDER_REFUSED",
  "E_DECISION_CONFIG",
  "E_BUDGET",
  "E_WORKSPACE",
  "E_LOCKED",
  "E_IRREVERSIBLE",
  "E_JOIN_CONFLICT",
  "E_LOOP_LIMIT",
  "E_CANCELLED",
  "E_INTERNAL",
] as const satisfies readonly ErrorCode[];

const EXTRA_API_ERROR_CODES = [
  "E_PAYLOAD_TOO_LARGE",
  "E_NOT_SUPPORTED",
  /** Emitted by the browser server for project-path overlap; 403 like E_FORBIDDEN_PATH. */
  "E_FORBIDDEN",
] as const;

/** Compile-time completeness check: this must stay `never`. */
export type MissingCoreErrorCode = Exclude<ErrorCode, (typeof CORE_ERROR_CODES)[number]>;

const API_ERROR_CODE_VALUES = [...CORE_ERROR_CODES, ...EXTRA_API_ERROR_CODES] as const;

export type ApiErrorCode = ErrorCode | (typeof EXTRA_API_ERROR_CODES)[number];

export const apiErrorCodeSchema = z.enum(API_ERROR_CODE_VALUES);
export const coreErrorCodeSchema = z.enum(CORE_ERROR_CODES);

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  E_VALIDATION: 400,
  E_WORKFLOW_INVALID: 400,
  E_EXPR: 400,
  E_OUTPUT_INVALID: 400,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_LOCKED: 409,
  E_AUTH: 401,
  E_FORBIDDEN: 403,
  E_FORBIDDEN_PATH: 403,
  E_ATTEMPTS_EXHAUSTED: 409,
  E_CLI_MISSING: 503,
  E_CLI_AUTH: 503,
  E_CLI_CRASH: 500,
  E_QUOTA_WINDOW: 429,
  E_QUOTA_CREDITS: 402,
  E_RATE_LIMIT: 429,
  E_PROVIDER: 502,
  E_PROVIDER_REFUSED: 422,
  E_DECISION_CONFIG: 500,
  E_BUDGET: 409,
  E_WORKSPACE: 500,
  E_IRREVERSIBLE: 409,
  E_JOIN_CONFLICT: 409,
  E_LOOP_LIMIT: 409,
  E_CANCELLED: 409,
  E_INTERNAL: 500,
  E_PAYLOAD_TOO_LARGE: 413,
  E_NOT_SUPPORTED: 501,
};

export function httpStatusForErrorCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** A validated `{ error: { code, message, details? } }` response. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    details: unknown = undefined,
    requestId: string | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export type ApiProtocolErrorKind = "version" | "invalid-response" | "event-stream";

/** The server response did not match the versioned @devchestra/api contract. */
export class ApiProtocolError extends Error {
  override readonly name = "ApiProtocolError";
  readonly kind: ApiProtocolErrorKind;
  readonly detail: unknown;

  constructor(kind: ApiProtocolErrorKind, message: string, detail: unknown = undefined) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

/** A network/transport failure. Abort errors are rethrown unchanged. */
export class ApiTransportError extends Error {
  override readonly name = "ApiTransportError";
  readonly kind = "transport";

  constructor(message: string, cause: unknown = undefined) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isApiProtocolError(value: unknown): value is ApiProtocolError {
  return value instanceof ApiProtocolError;
}

export function isApiTransportError(value: unknown): value is ApiTransportError {
  return value instanceof ApiTransportError;
}
