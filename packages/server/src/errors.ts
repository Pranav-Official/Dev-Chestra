export type RelayErrorCode =
  | "E_AUTH"
  | "E_FORBIDDEN"
  | "E_FORBIDDEN_PATH"
  | "E_VALIDATION"
  | "E_NOT_SUPPORTED"
  | "E_CONFLICT"
  | "E_PAYLOAD_TOO_LARGE"
  | "E_RATE_LIMIT"
  | "E_NOT_FOUND"
  | "E_INTERNAL";

const STATUS: Record<RelayErrorCode, number> = {
  E_AUTH: 401,
  E_FORBIDDEN: 403,
  E_FORBIDDEN_PATH: 403,
  E_VALIDATION: 400,
  E_NOT_SUPPORTED: 501,
  E_CONFLICT: 409,
  E_PAYLOAD_TOO_LARGE: 413,
  E_RATE_LIMIT: 429,
  E_NOT_FOUND: 404,
  E_INTERNAL: 500,
};

/**
 * Safe, transport-level error. `message` may be shown to a person; it must
 * never contain a token, stack trace or other secret.
 */
export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: RelayErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface ErrorBody {
  error: {
    code: RelayErrorCode;
    message: string;
    details?: unknown;
  };
}

export function errorBody(code: RelayErrorCode, message: string, details?: unknown): ErrorBody {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/** Read a durable error code without trusting its message or exposing details. */
export function relayErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Map any thrown value to a safe wire error without leaking internals. */
export function toRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) {
    return error;
  }
  switch (relayErrorCode(error)) {
    case "E_CONFLICT":
      return new RelayError("E_CONFLICT", "The submission conflicts with a committed result.");
    case "E_ATTEMPTS_EXHAUSTED":
      return new RelayError("E_VALIDATION", "No validation attempts left.");
    case "E_VALIDATION":
      return new RelayError("E_VALIDATION", "The submission is invalid.");
    case "E_FORBIDDEN":
      return new RelayError("E_FORBIDDEN", "That operation is not allowed.");
    default:
      return new RelayError("E_INTERNAL", "Internal server error.");
  }
}
