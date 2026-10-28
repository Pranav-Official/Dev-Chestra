import { err, RelayError, type Result } from "@relay/core";
import type { ExitInfo, FailureClass, Invocation } from "./types.js";

export function classifyExit(exit: ExitInfo): FailureClass {
  if (exit.killedBy === "timeout") return { kind: "timeout" };
  if (exit.killedBy === "cancel") return { kind: "cancelled" };
  if (exit.code === 0 && exit.signal === null) return { kind: "ok" };
  return { kind: "crash", exitCode: exit.code, signal: exit.signal };
}

export function fail(message: string): Result<Invocation, RelayError> {
  return err(new RelayError("E_VALIDATION", message));
}

export function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RelayError("E_VALIDATION", `${name} must be an array of strings`);
  }
  return value as string[];
}

export function requireOptionKeys(
  options: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new RelayError("E_VALIDATION", `Unknown cliOptions key: ${key}`);
    }
  }
}

export function checkToolNames(tools: string[], field: string): string[] {
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_.:*?-]+$/.test(tool)) {
      throw new RelayError("E_VALIDATION", `${field} contains an invalid tool name: ${tool}`);
    }
  }
  return tools;
}

export function checkId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new RelayError("E_VALIDATION", `${field} is not a safe session identifier`);
  }
  return value;
}

export function checkDir(value: string, field: string): string {
  if (value === "" || value.includes("\u0000")) {
    throw new RelayError("E_VALIDATION", `${field} must be a non-empty path`);
  }
  return value;
}

export function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
