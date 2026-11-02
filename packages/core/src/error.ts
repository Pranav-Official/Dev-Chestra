export type ErrorCode =
  | "E_VALIDATION"
  | "E_NOT_FOUND"
  | "E_CONFLICT"
  | "E_AUTH"
  | "E_FORBIDDEN_PATH"
  | "E_WORKFLOW_INVALID"
  | "E_EXPR"
  | "E_OUTPUT_INVALID"
  | "E_ATTEMPTS_EXHAUSTED"
  | "E_CLI_MISSING"
  | "E_CLI_DISABLED"
  | "E_CLI_AUTH"
  | "E_CLI_CRASH"
  | "E_QUOTA_WINDOW"
  | "E_QUOTA_CREDITS"
  | "E_RATE_LIMIT"
  | "E_PROVIDER"
  | "E_PROVIDER_REFUSED"
  | "E_DECISION_CONFIG"
  | "E_BUDGET"
  | "E_WORKSPACE"
  | "E_LOCKED"
  | "E_QUEUE_FULL"
  | "E_IRREVERSIBLE"
  | "E_JOIN_CONFLICT"
  | "E_CANCELLED"
  | "E_LOOP_LIMIT"
  | "E_POLL_PROBE"
  | "E_INTERNAL";

export interface DevChestraErrorOptions {
  details?: unknown;
  cause?: unknown;
  retryable?: boolean;
}

export class DevChestraError extends Error {
  override readonly name = "DevChestraError";
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable?: boolean;

  constructor(code: ErrorCode, message: string, opts: DevChestraErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.retryable !== undefined) this.retryable = opts.retryable;
  }

  toJSON(): {
    name: "DevChestraError";
    code: ErrorCode;
    message: string;
    details?: unknown;
    retryable?: boolean;
  } {
    return {
      name: "DevChestraError",
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
    };
  }
}

export function isDevChestraError(value: unknown): value is DevChestraError {
  return value instanceof DevChestraError;
}
