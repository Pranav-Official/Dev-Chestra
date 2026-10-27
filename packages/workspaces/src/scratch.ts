import * as fs from "node:fs";
import * as path from "node:path";
import { err, fsSlug, ok, type Path, RelayError, type Result } from "@relay/core";
import {
  parseWorkspacePath,
  requireAbsolutePath,
  requirePositiveInteger,
  requireSegment,
  type WorkspaceLayout,
  workspaceLayout,
} from "./segments.js";
import type {
  AcquireScratchRequest,
  FinalizeOutcome,
  FinalizeScratchInfo,
  FinalizeScratchRequest,
  ProcessStopEvidence,
  RemoveScratchInfo,
  ScratchWorkspace,
} from "./types.js";

const PREFIX = ".relay-finalized.";
type FinalizeMarker = {
  version: 1;
  kind: "relay.scratch.finalized";
  projectId: string;
  runId: string;
  path: string;
  dir: string;
  attempt: number;
  generation: number;
  outcome: FinalizeOutcome;
  process: ProcessStopEvidence;
};
interface Issued {
  dataDir: string;
  projectId: string;
  runId: string;
  path: Path;
  attempt: number;
  generation: number;
  dir: string;
  markerFile: string;
}
const issued = new WeakMap<ScratchWorkspace, Issued>();
const missing = (e: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | undefined)?.code ?? "");
const exists = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
const werr = (message: string, details?: unknown): RelayError =>
  new RelayError("E_WORKSPACE", message, details === undefined ? {} : { details });
const ferr = (message: string, details?: unknown): RelayError =>
  new RelayError("E_FORBIDDEN_PATH", message, details === undefined ? {} : { details });
const conflict = (message: string, details?: unknown): RelayError =>
  new RelayError("E_CONFLICT", message, details === undefined ? {} : { details });
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function toRelayError(e: unknown): RelayError {
  if (e instanceof RelayError) return e;
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  return werr(`Workspace operation failed (${code})`, { step: "io", code });
}
function prepareDataDir(raw: string, create: boolean): string {
  const resolved = path.resolve(requireAbsolutePath(raw, "dataDir"));
  if (resolved === path.resolve("/"))
    throw new RelayError("E_VALIDATION", "dataDir must not be the filesystem root");
  try {
    fs.lstatSync(resolved);
  } catch (e) {
    if (!missing(e)) throw e;
    if (!create) {
      throw werr("Data directory is missing", { step: "workspace_missing", path: resolved });
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const real = fs.realpathSync.native(resolved);
  if (!fs.statSync(real).isDirectory()) throw werr("Data directory is not a directory");
  return real;
}
function existingDataDir(raw: string, expected: string): string {
  const real = fs.realpathSync.native(requireAbsolutePath(raw, "dataDir"));
  if (real !== expected) {
    throw conflict("Workspace data directory changed; reacquire", { expected, actual: real });
  }
  return real;
}
function prepareProjectRoot(raw: string): string {
  const real = fs.realpathSync.native(requireAbsolutePath(raw, "projectRoot"));
  if (!fs.statSync(real).isDirectory()) throw werr("projectRoot is not a directory");
  return real;
}
function ensureDir(
  parent: string,
  name: string,
  create: boolean,
): { dir: string; created: boolean } {
  const dir = path.join(parent, name);
  let stat: fs.Stats;
  let created = false;
  try {
    stat = fs.lstatSync(dir);
  } catch (e) {
    if (!missing(e)) throw e;
    if (!create) throw werr("Workspace path is missing", { step: "workspace_missing", path: dir });
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created = true;
    } catch (mk) {
      if (!exists(mk)) throw mk;
    }
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink()) throw ferr("Owned path is a symlink", { path: dir });
  if (!stat.isDirectory()) throw werr("Owned path is not a directory", { path: dir });
  if (fs.realpathSync.native(dir) !== dir)
    throw ferr("Owned path traverses a symlink", { path: dir });
  if (create) fs.chmodSync(dir, 0o700);
  return { dir, created };
}
function derived(r: Issued): WorkspaceLayout {
  const dataDir = existingDataDir(r.dataDir, r.dataDir);
  const layout = workspaceLayout(dataDir, r.projectId, r.runId, r.path);
  if (layout.wsDir !== r.dir) {
    throw conflict("Workspace path does not match its derived layout");
  }
  if (fs.realpathSync.native(layout.wsDir) !== layout.wsDir) {
    throw ferr("Workspace real path does not match its derived path");
  }
  return layout;
}
function readMarker(file: string): unknown | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw ferr("Marker is a symlink", { path: file });
    if (!stat.isFile()) throw werr("Marker is not a regular file", { path: file });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw werr("Marker is not valid JSON", { step: "marker_invalid", path: file, error: e });
  }
}
function writeMarker(file: string, value: unknown): boolean {
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (exists(e)) return false;
    throw e;
  }
  fs.chmodSync(file, 0o600);
  return true;
}
function parseFinalize(value: unknown, layout: WorkspaceLayout, r: Issued): FinalizeMarker {
  if (!isRecord(value)) throw werr("Finalization marker is not an object");
  const m = value as unknown as FinalizeMarker;
  if (
    m.version !== 1 ||
    m.kind !== "relay.scratch.finalized" ||
    m.projectId !== r.projectId ||
    m.runId !== r.runId ||
    m.path !== r.path ||
    m.dir !== layout.wsDir ||
    m.attempt !== r.attempt ||
    m.generation !== r.generation
  ) {
    throw werr("Finalization marker does not match this workspace", {
      step: "marker_invalid",
      path: layout.wsDir,
    });
  }
  return m;
}
const evidence = (p: ProcessStopEvidence): string =>
  JSON.stringify([p.attempt, p.generation, p.stopped, p.reason ?? null, p.exitCode ?? null]);
const sameFinalize = (
  m: FinalizeMarker,
  outcome: FinalizeOutcome,
  p: ProcessStopEvidence,
): boolean => m.outcome === outcome && evidence(m.process) === evidence(p);
function recordFor(ws: ScratchWorkspace): Issued {
  const record = issued.get(ws);
  if (record === undefined) throw ferr("Workspace was not issued by acquireScratch; reacquire");
  return record;
}
export async function acquireScratch(
  request: AcquireScratchRequest,
): Promise<Result<ScratchWorkspace, RelayError>> {
  try {
    if (aborted(request.signal)) {
      return err(new RelayError("E_CANCELLED", "Workspace acquisition cancelled"));
    }
    if (request.mode !== undefined && request.mode !== "scratch") {
      throw werr(`Workspace mode '${String(request.mode)}' is not supported`, {
        step: "unsupported_mode",
        mode: request.mode,
      });
    }
    const projectId = requireSegment(request.projectId, "projectId");
    const runId = requireSegment(request.runId, "runId");
    const attempt = requirePositiveInteger(request.attempt, "attempt");
    const generation = requirePositiveInteger(request.generation, "generation");
    const executionPath = parseWorkspacePath(request.path);
    const slug = fsSlug(executionPath);
    const create = request.requireExisting !== true;
    const dataDir = prepareDataDir(request.dataDir, create);
    const projectRoot =
      request.projectRoot === undefined ? null : prepareProjectRoot(request.projectRoot);
    const layout = workspaceLayout(dataDir, projectId, runId, executionPath);
    const project = ensureDir(dataDir, "projects", create);
    const projectIdDir = ensureDir(project.dir, projectId, create);
    const run = ensureDir(ensureDir(projectIdDir.dir, "runs", create).dir, runId, create);
    const ws = ensureDir(ensureDir(run.dir, "ws", create).dir, slug, create);
    if (
      projectIdDir.dir !== layout.projectDir ||
      run.dir !== layout.runDir ||
      ws.dir !== layout.wsDir
    ) {
      throw conflict("Derived workspace path is inconsistent");
    }
    const record: Issued = {
      dataDir,
      projectId,
      runId,
      path: executionPath,
      attempt,
      generation,
      dir: layout.wsDir,
      markerFile: path.join(layout.wsDir, `${PREFIX}${attempt}.${generation}.json`),
    };
    const workspace: ScratchWorkspace = Object.freeze({
      mode: "scratch",
      dataDir,
      projectId,
      runId,
      path: executionPath,
      attempt,
      generation,
      dir: layout.wsDir,
      markerFile: record.markerFile,
      reused: create ? !ws.created : true,
      projectRoot,
    });
    issued.set(workspace, record);
    return ok(workspace);
  } catch (e) {
    return err(toRelayError(e));
  }
}
export async function finalizeScratch(
  ws: ScratchWorkspace,
  request: FinalizeScratchRequest,
): Promise<Result<FinalizeScratchInfo, RelayError>> {
  try {
    const r = recordFor(ws);
    if (!["success", "failed", "cancelled"].includes(request.outcome)) {
      throw new RelayError("E_VALIDATION", `Invalid outcome: ${String(request.outcome)}`);
    }
    const process = request.process;
    if (!isRecord(process) || process.stopped !== true) {
      throw werr("finalizeScratch requires an observed process stop", { step: "process_running" });
    }
    if (process.attempt !== r.attempt || process.generation !== r.generation) {
      throw conflict("Process evidence does not match this workspace");
    }
    const layout = derived(r);
    const file = path.join(layout.wsDir, `${PREFIX}${r.attempt}.${r.generation}.json`);
    const info = (alreadyFinalized: boolean): FinalizeScratchInfo => ({
      dir: layout.wsDir,
      attempt: r.attempt,
      generation: r.generation,
      outcome: request.outcome,
      alreadyFinalized,
      markerFile: file,
      process,
    });
    const existing = readMarker(file);
    if (existing !== null) {
      if (!sameFinalize(parseFinalize(existing, layout, r), request.outcome, process)) {
        throw conflict("Finalization marker is already recorded differently");
      }
      return ok(info(true));
    }
    const marker: FinalizeMarker = {
      version: 1,
      kind: "relay.scratch.finalized",
      projectId: r.projectId,
      runId: r.runId,
      path: r.path,
      dir: layout.wsDir,
      attempt: r.attempt,
      generation: r.generation,
      outcome: request.outcome,
      process,
    };
    if (fs.realpathSync.native(layout.wsDir) !== layout.wsDir) {
      throw ferr("Workspace real path no longer matches its derived path");
    }
    if (!writeMarker(file, marker)) {
      const raced = readMarker(file);
      if (
        raced === null ||
        !sameFinalize(parseFinalize(raced, layout, r), request.outcome, process)
      ) {
        throw conflict("Finalization marker is already recorded differently");
      }
    }
    return ok(info(false));
  } catch (e) {
    return err(toRelayError(e));
  }
}
export function releaseScratch(ws: ScratchWorkspace): void {
  void ws;
}
export async function removeScratch(
  ws: ScratchWorkspace,
): Promise<Result<RemoveScratchInfo, RelayError>> {
  try {
    const r = recordFor(ws);
    existingDataDir(r.dataDir, r.dataDir);
    try {
      if (fs.lstatSync(r.dir).isSymbolicLink()) throw ferr("Workspace is a symlink");
    } catch (e) {
      if (missing(e)) return ok({ dir: r.dir, removed: false, alreadyAbsent: true });
      throw e;
    }
    const layout = derived(r);
    const stat = fs.lstatSync(layout.wsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw ferr("Refusing to remove a workspace that is not an owned directory");
    }
    if (fs.realpathSync.native(layout.wsDir) !== layout.wsDir) {
      throw ferr("Workspace real path no longer matches its derived path");
    }
    try {
      fs.rmSync(layout.wsDir, { recursive: true, force: false });
    } catch (e) {
      if (missing(e)) return ok({ dir: layout.wsDir, removed: false, alreadyAbsent: true });
      throw e;
    }
    return ok({ dir: layout.wsDir, removed: true, alreadyAbsent: false });
  } catch (e) {
    return err(toRelayError(e));
  }
}
