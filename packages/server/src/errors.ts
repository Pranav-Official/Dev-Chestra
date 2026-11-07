export type DevChestraErrorCode =
  | "E_AUTH"
  | "E_FORBIDDEN"
  | "E_FORBIDDEN_PATH"
  | "E_VALIDATION"
  | "E_WORKFLOW_INVALID"
  | "E_NOT_SUPPORTED"
  | "E_CONFLICT"
  | "E_CLI_DISABLED"
  | "E_MODEL_TIER"
  | "E_QUEUE_FULL"
  | "E_PAYLOAD_TOO_LARGE"
  | "E_RATE_LIMIT"
  | "E_NOT_FOUND"
  | "E_INTERNAL";

const STATUS: Record<DevChestraErrorCode, number> = {
  E_AUTH: 401,
  E_FORBIDDEN: 403,
  E_FORBIDDEN_PATH: 403,
  E_VALIDATION: 400,
  E_WORKFLOW_INVALID: 400,
  E_NOT_SUPPORTED: 501,
  E_CONFLICT: 409,
  E_CLI_DISABLED: 409,
  E_MODEL_TIER: 409,
  E_QUEUE_FULL: 503,
  E_PAYLOAD_TOO_LARGE: 413,
  E_RATE_LIMIT: 429,
  E_NOT_FOUND: 404,
  E_INTERNAL: 500,
};

/**
 * Safe, transport-level error. `message` may be shown to a person; it must
 * never contain a token, stack trace or other secret.
 */
export class DevChestraError extends Error {
  readonly code: DevChestraErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: DevChestraErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DevChestraError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface ErrorBody {
  error: {
    code: DevChestraErrorCode;
    message: string;
    details?: unknown;
  };
}

export function errorBody(
  code: DevChestraErrorCode,
  message: string,
  details?: unknown,
): ErrorBody {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/** Read a durable error code without trusting its message or exposing details. */
export function devchestraErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Map any thrown value to a safe wire error without leaking internals. */
export function toDevChestraError(error: unknown): DevChestraError {
  if (error instanceof DevChestraError) {
    return error;
  }
  switch (devchestraErrorCode(error)) {
    case "E_CONFLICT":
      return new DevChestraError("E_CONFLICT", "The submission conflicts with a committed result.");
    case "E_ATTEMPTS_EXHAUSTED":
      return new DevChestraError("E_VALIDATION", "No validation attempts left.");
    case "E_VALIDATION":
      return new DevChestraError("E_VALIDATION", "The submission is invalid.");
    case "E_FORBIDDEN":
      return new DevChestraError("E_FORBIDDEN", "That operation is not allowed.");
    default:
      return new DevChestraError("E_INTERNAL", "Internal server error.");
  }
}
