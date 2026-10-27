import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonObject } from "@relay/core";
import {
  hashWorkflow,
  type NormalizedWorkflow,
  normalizeWorkflow,
  parseWorkflowJson,
  validateParams,
  validateWorkflow,
  type WorkflowFile,
} from "@relay/schema";
import { RelayError } from "../errors.js";

const MAX_WORKFLOW_BYTES = 1024 * 1024;

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function invalid(message: string, details?: unknown): RelayError {
  return new RelayError("E_VALIDATION", message, details);
}

export function canonicalExistingDirectory(input: string, label: string): string {
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw invalid(`${label} must be a non-empty path.`);
  }
  if (!isAbsolute(input)) {
    throw invalid(`${label} must be absolute.`);
  }
  let real: string;
  try {
    real = realpathSync.native(resolve(input));
  } catch {
    throw new RelayError("E_NOT_FOUND", `${label} does not exist.`);
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(real);
  } catch {
    throw new RelayError("E_NOT_FOUND", `${label} does not exist.`);
  }
  if (!stat.isDirectory()) {
    throw invalid(`${label} must be a directory.`);
  }
  return real;
}

export function isPathOverlap(
  left: string,
  right: string,
): "equal" | "left-inside-right" | "right-inside-left" | null {
  if (left === right) return "equal";
  if (within(right, left)) return "left-inside-right";
  if (within(left, right)) return "right-inside-left";
  return null;
}

export function assertProjectPathAllowed(projectPath: string, dataDir: string): string {
  const canonicalProject = canonicalExistingDirectory(projectPath, "Project path");
  const canonicalData = canonicalExistingDirectory(dataDir, "Data directory");
  const overlap = isPathOverlap(canonicalProject, canonicalData);
  if (overlap !== null) {
    throw new RelayError(
      "E_FORBIDDEN",
      "The project path must not equal, contain or live inside the Relay data directory.",
      { details: { overlap } },
    );
  }
  return canonicalProject;
}

function resolveFileInside(root: string, rel: string): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0") || isAbsolute(rel)) {
    throw invalid("File name must be a non-empty relative path.");
  }
  if (rel.split(/[\\/]+/u).some((part) => part === "..")) {
    throw new RelayError("E_FORBIDDEN_PATH", "File name must not contain '..'.");
  }
  const rootReal = realpathSync.native(root);
  const candidate = resolve(rootReal, rel);
  if (!within(rootReal, candidate)) {
    throw new RelayError("E_FORBIDDEN_PATH", "Path escapes the project directory.");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
  } catch {
    throw new RelayError("E_NOT_FOUND", `File not found: ${rel}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RelayError("E_FORBIDDEN_PATH", "File must be a regular file, not a symlink.");
  }
  if (stat.size > MAX_WORKFLOW_BYTES) {
    throw new RelayError("E_PAYLOAD_TOO_LARGE", "Workflow file exceeds the 1 MiB limit.");
  }
  const real = realpathSync.native(candidate);
  if (!within(rootReal, real)) {
    throw new RelayError("E_FORBIDDEN_PATH", "Path escapes the project directory.");
  }
  return real;
}

function readFileInside(root: string, rel: string): string {
  const file = resolveFileInside(root, rel);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_WORKFLOW_BYTES) {
      throw new RelayError("E_PAYLOAD_TOO_LARGE", "Workflow file exceeds the 1 MiB limit.");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function workflowRelative(root: string, arg: string): string {
  if (typeof arg !== "string" || arg === "" || arg.length > 1024) {
    throw invalid("workflowFile is required.");
  }
  if (arg.includes("\0") || isAbsolute(arg)) {
    throw new RelayError("E_FORBIDDEN_PATH", "workflowFile must be a relative path.");
  }
  if (arg.split(/[\\/]+/u).some((part) => part === "..")) {
    throw new RelayError("E_FORBIDDEN_PATH", "workflowFile must not contain '..'.");
  }
  const absolute = resolve(root, arg);
  if (!within(root, absolute)) {
    throw new RelayError("E_FORBIDDEN_PATH", "workflowFile escapes the project directory.");
  }
  return relative(root, absolute);
}

function loadPrompts(root: string, file: WorkflowFile): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const node of file.graph.nodes) {
    if (node.type !== "agent" || node.promptFile === undefined) continue;
    const prefix = `${file.id}.prompts/`;
    const candidates = node.promptFile.startsWith(prefix)
      ? [node.promptFile]
      : [node.promptFile, `${prefix}${node.promptFile}`];
    let loaded: string | undefined;
    for (const candidate of candidates) {
      try {
        loaded = readFileInside(root, candidate);
        break;
      } catch {
        // Try the next allowed candidate; report below if none exists.
      }
    }
    if (loaded === undefined) {
      throw invalid(`Prompt file '${node.promptFile}' was not found inside the project.`, {
        nodeId: node.id,
      });
    }
    prompts[node.promptFile] = loaded;
    prompts[`${prefix}${basename(node.promptFile)}`] = loaded;
  }
  return prompts;
}

export interface LoadedBrowserWorkflow {
  workflowId: string;
  workflowFile: string;
  snapshot: NormalizedWorkflow;
  snapshotRaw: string;
  workflowHash: string;
  file: WorkflowFile;
}

export async function loadBrowserWorkflow(input: {
  projectRoot: string;
  projectKind: "git" | "folder";
  workflowFile: string;
  params: JsonObject;
}): Promise<LoadedBrowserWorkflow> {
  const root = realpathSync.native(input.projectRoot);
  const rel = workflowRelative(root, input.workflowFile);
  const raw = readFileInside(root, rel);
  if (Buffer.byteLength(raw, "utf8") > MAX_WORKFLOW_BYTES) {
    throw new RelayError("E_PAYLOAD_TOO_LARGE", "Workflow file exceeds the 1 MiB limit.");
  }
  const parsed = parseWorkflowJson(raw);
  if (!parsed.ok) throw invalid(parsed.error.message, parsed.error.details);
  const report = validateWorkflow(parsed.value, { projectKind: input.projectKind });
  if (!report.ok) {
    throw invalid(`Workflow is invalid: ${report.errors[0]?.message ?? "unknown error"}`, {
      issues: report.errors,
      warnings: report.warnings,
    });
  }
  const params = validateParams(
    parsed.value,
    input.params as Record<string, string | number | boolean>,
  );
  if (!params.ok) {
    throw invalid("Run parameters are invalid", { issues: params.errors });
  }
  const normalized = normalizeWorkflow(parsed.value, { prompts: loadPrompts(root, parsed.value) });
  if (!normalized.ok) throw invalid(normalized.error.message, normalized.error.details);
  const workflowHash = await hashWorkflow(normalized.value);
  return {
    workflowId: parsed.value.id,
    workflowFile: rel,
    snapshot: normalized.value,
    snapshotRaw: raw,
    workflowHash,
    file: parsed.value,
  };
}

export function validateWorkflowFileInput(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 1024) {
    throw invalid("workflowFile must be a non-empty relative string.");
  }
  return value;
}

export function validateProjectPathInput(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 4096) {
    throw invalid("path must be a non-empty absolute path string.");
  }
  return value;
}

export function projectKind(root: string): "git" | "folder" {
  try {
    lstatSync(join(root, ".git"));
    return "git";
  } catch {
    return "folder";
  }
}
