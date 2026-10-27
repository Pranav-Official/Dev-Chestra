import { RelayError } from "@relay/core";

export class ProcessGroupAliveError extends RelayError {
  constructor(message: string, details?: unknown) {
    super("E_WORKSPACE", message, details === undefined ? {} : { details });
  }
}

export class StopSignal extends Error {
  readonly kind: "user" | "shutdown";

  constructor(kind: "user" | "shutdown") {
    super(kind === "user" ? "Run cancelled by user" : "Relay is shutting down");
    this.name = "StopSignal";
    this.kind = kind;
  }
}

export function stopKind(signal: AbortSignal, override?: "user" | "shutdown"): "user" | "shutdown" {
  if (override !== undefined) return override;
  return signal.reason === "shutdown" ? "shutdown" : "user";
}
