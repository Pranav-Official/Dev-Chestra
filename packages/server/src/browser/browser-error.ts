import { type ApiErrorCode, apiErrorCodeSchema, httpStatusForErrorCode } from "@relay/api";
import { RelayError, relayErrorCode } from "../errors.js";

export function browserError(error: unknown): {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: unknown;
} {
  if (error instanceof RelayError) {
    const parsed = apiErrorCodeSchema.safeParse(error.code);
    const code: ApiErrorCode = parsed.success ? parsed.data : "E_INTERNAL";
    return {
      code,
      message: error.message,
      status: httpStatusForErrorCode(code),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const raw = relayErrorCode(error);
  const parsed = raw === null ? null : apiErrorCodeSchema.safeParse(raw);
  const code: ApiErrorCode = parsed?.success === true ? parsed.data : "E_INTERNAL";
  const messages: Partial<Record<ApiErrorCode, string>> = {
    E_NOT_FOUND: "Not found.",
    E_VALIDATION: "The request is invalid.",
    E_CONFLICT: "The request conflicts with current state.",
    E_LOCKED: "The resource is locked.",
    E_FORBIDDEN_PATH: "That path is not allowed.",
    E_AUTH: "Authentication is required.",
    E_PAYLOAD_TOO_LARGE: "The request body is too large.",
    E_RATE_LIMIT: "Too many requests.",
    E_NOT_SUPPORTED: "That operation is not supported.",
  };
  return {
    code,
    message: messages[code] ?? "The request could not be completed.",
    status: httpStatusForErrorCode(code),
  };
}
