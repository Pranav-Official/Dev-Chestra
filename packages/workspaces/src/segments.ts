import { isAbsolute, join } from "node:path";
import { DevChestraError, fsSlug, type Path, parsePath } from "@devchestra/core";

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const validation = (message: string): DevChestraError =>
  new DevChestraError("E_VALIDATION", message);
export function requireSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || !SEGMENT_RE.test(value)) {
    throw validation(`${label} must be a filesystem-safe segment (max 128 chars)`);
  }
  return value;
}
export function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw validation(`${label} must be a positive safe integer`);
  }
  return value as number;
}
export function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw validation(`${label} must be a non-empty path without NUL`);
  }
  if (!isAbsolute(value)) throw validation(`${label} must be an absolute path`);
  return value;
}
export function parseWorkspacePath(value: Path | string): Path {
  const parsed = parsePath(value);
  if (!parsed.ok) throw parsed.error;
  if (parsed.value.length === 0) throw validation("Scratch requires an execution path");
  return value as Path;
}
export interface WorkspaceLayout {
  readonly projectDir: string;
  readonly runDir: string;
  readonly wsRoot: string;
  readonly wsDir: string;
}
export function workspaceLayout(
  dataDir: string,
  projectId: string,
  runId: string,
  path: Path | string,
): WorkspaceLayout {
  const project = requireSegment(projectId, "projectId");
  const run = requireSegment(runId, "runId");
  const slug = fsSlug(parseWorkspacePath(path));
  const runDir = join(dataDir, "projects", project, "runs", run);
  return {
    projectDir: join(dataDir, "projects", project),
    runDir,
    wsRoot: join(runDir, "ws"),
    wsDir: join(runDir, "ws", slug),
  };
}
