import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { MAX_WORKFLOW_FILE_BYTES, WORKFLOW_ID_PATTERN } from "@devchestra/schema";
import { DevChestraError } from "../errors.js";

export const MAX_WORKFLOW_BYTES = MAX_WORKFLOW_FILE_BYTES;
export { WORKFLOW_ID_PATTERN };
export const WORKFLOW_FILE = /^([a-z0-9-]{1,64})\.json$/u;
const PUBLISH_TEMP = /^\.([a-z0-9-]{1,64})\.(\d{1,10})\.([0-9a-f]{16})\.tmp$/u;

export const ETAG_HEADER = "ETag";
export const IF_MATCH_HEADER = "If-Match";

export interface ManagedPaths {
  root: string;
  workflows: string;
  relativeWorkflows: string;
}

export interface ManagedFile {
  id: string;
  path: string;
  relativeFile: string;
  bytes: Buffer;
  text: string;
  etag: string;
  updatedAt: number;
}

function forbidden(message: string): DevChestraError {
  return new DevChestraError("E_FORBIDDEN_PATH", message);
}

function conflict(currentEtag: string): DevChestraError {
  return new DevChestraError("E_CONFLICT", "The workflow changed on disk. Reload it and retry.", {
    currentEtag,
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function assertWorkflowId(value: unknown): string {
  if (typeof value !== "string" || !WORKFLOW_ID_PATTERN.test(value)) {
    throw new DevChestraError(
      "E_VALIDATION",
      "Workflow id must match ^[a-z0-9-]{1,64}$ and equal the file stem.",
    );
  }
  return value;
}

export function etagForBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function quoteEtag(etag: string): string {
  return `"${etag}"`;
}

export function parseIfMatch(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new DevChestraError("E_VALIDATION", "If-Match is required for this request.");
  }
  if (value.includes(",") || value.startsWith("W/") || value === "*") {
    throw new DevChestraError("E_VALIDATION", "If-Match must be one strong ETag.");
  }
  if (value.length < 3 || !value.startsWith('"') || !value.endsWith('"')) {
    throw new DevChestraError("E_VALIDATION", "If-Match must be a quoted strong ETag.");
  }
  const inner = value.slice(1, -1);
  if (inner === "" || /[\r\n\t ]/u.test(inner)) {
    throw new DevChestraError("E_VALIDATION", "If-Match must be a quoted strong ETag.");
  }
  return inner;
}

function checkedDirectory(path: string, root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new DevChestraError("E_NOT_FOUND", "The project workflow directory does not exist.");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw forbidden("Managed workflow paths must be real directories, not symlinks.");
  }
  const real = realpathSync.native(path);
  if (real !== path || !within(root, real)) {
    throw forbidden("Managed workflow paths escape the project directory.");
  }
}

function ensureDirectory(path: string, root: string): void {
  try {
    lstatSync(path);
  } catch {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  checkedDirectory(path, root);
}

export function managedPaths(
  projectRoot: string,
  options: { create: boolean },
): ManagedPaths | null {
  const root = realpathSync.native(projectRoot);
  const devchestra = join(root, ".devchestra");
  const workflows = join(devchestra, "workflows");
  if (options.create) {
    ensureDirectory(devchestra, root);
    ensureDirectory(workflows, root);
  } else {
    try {
      checkedDirectory(devchestra, root);
      checkedDirectory(workflows, root);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") return null;
      throw error;
    }
  }
  return {
    root,
    workflows,
    relativeWorkflows: ".devchestra/workflows",
  };
}

function readCapped(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const read = readSync(fd, chunk, 0, chunk.length, null);
    if (read === 0) break;
    total += read;
    if (total > maxBytes) {
      throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Workflow file exceeds the 1 MiB limit.");
    }
    chunks.push(chunk.subarray(0, read));
  }
  return Buffer.concat(chunks);
}

function readFileCapped(
  path: string,
  maxBytes: number,
  label: string,
  recover?: (stat: Stats) => boolean,
): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DevChestraError("E_NOT_FOUND", `${label} not found.`);
    if (code === "ELOOP") throw forbidden("File must be a regular file, not a symlink.");
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw forbidden("File must be a regular file, not a symlink.");
    }
    if (stat.nlink > 1) {
      if (recover?.(stat) !== true) {
        throw forbidden("File must not be hard-linked.");
      }
      if (fstatSync(fd).nlink !== 1) {
        throw forbidden("File must not be hard-linked.");
      }
    }
    if (stat.size > maxBytes) {
      throw new DevChestraError("E_PAYLOAD_TOO_LARGE", `${label} exceeds the 1 MiB limit.`);
    }
    return readCapped(fd, maxBytes);
  } finally {
    closeSync(fd);
  }
}

function verifyContained(root: string, path: string): void {
  const real = realpathSync.native(path);
  if (!within(root, real)) throw forbidden("Path escapes the managed workflow directory.");
}

/**
 * A crash between `link(temp, target)` and unlinking the publish temp leaves the
 * definition with two hard links. Recover only our own paired temp: same inode,
 * reserved temp name for this id, private 0600 file, same owner, exactly nlink 2,
 * both inside the managed directory. Any other hard link stays rejected.
 */
function recoverOrphanedPublish(
  paths: ManagedPaths,
  id: string,
  target: string,
  stat: Stats,
): boolean {
  if (stat.nlink !== 2) return false;
  if ((stat.mode & 0o777) !== 0o600) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) return false;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(paths.workflows, { withFileTypes: true });
  } catch {
    return false;
  }
  let matched: string | null = null;
  for (const entry of entries) {
    const parsed = PUBLISH_TEMP.exec(entry.name);
    if (parsed === null || parsed[1] !== id) continue;
    const candidate = join(paths.workflows, entry.name);
    let candidateStat: Stats;
    try {
      candidateStat = lstatSync(candidate);
    } catch {
      continue;
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) continue;
    if (candidateStat.dev !== stat.dev || candidateStat.ino !== stat.ino) continue;
    if (candidateStat.nlink !== 2) continue;
    if ((candidateStat.mode & 0o777) !== 0o600) continue;
    if (uid !== null && candidateStat.uid !== uid) continue;
    if (matched !== null) return false;
    matched = candidate;
  }
  if (matched === null) return false;
  try {
    if (realpathSync.native(target) !== join(paths.workflows, `${id}.json`)) return false;
    if (realpathSync.native(matched) !== matched) return false;
  } catch {
    return false;
  }
  unlinkSync(matched);
  syncDirectory(paths.workflows);
  return true;
}

export function readManagedFile(paths: ManagedPaths, id: string): ManagedFile {
  const path = join(paths.workflows, `${id}.json`);
  let bytes: Buffer;
  try {
    bytes = readFileCapped(path, MAX_WORKFLOW_BYTES, "Workflow file", (stat) =>
      recoverOrphanedPublish(paths, id, path, stat),
    );
  } catch (error) {
    if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
      throw new DevChestraError("E_NOT_FOUND", `Workflow '${id}' not found.`);
    }
    throw error;
  }
  verifyContained(paths.workflows, path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw forbidden("Workflow file must be a regular file, not a symlink.");
  }
  return {
    id,
    path,
    relativeFile: `${paths.relativeWorkflows}/${id}.json`,
    bytes,
    text: bytes.toString("utf8"),
    etag: etagForBytes(bytes),
    updatedAt: Math.floor(stat.mtimeMs),
  };
}

/** Sorted ids only; callers read just the page they need (bounded work/memory). */
export function listManagedIds(paths: ManagedPaths): string[] {
  const ids: string[] = [];
  for (const entry of requireDirents(paths.workflows)) {
    const match = WORKFLOW_FILE.exec(entry.name);
    if (match === null) continue;
    const id = match[1];
    if (id === undefined) continue;
    try {
      const stat = lstatSync(join(paths.workflows, entry.name));
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch {
      continue;
    }
    ids.push(id);
  }
  ids.sort((left, right) => left.localeCompare(right));
  return ids;
}

function requireDirents(directory: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
  }
}

function writeTemp(paths: ManagedPaths, id: string, bytes: Buffer): string {
  checkedDirectory(paths.workflows, paths.root);
  const temp = join(paths.workflows, `.${id}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (realpathSync.native(paths.workflows) !== paths.workflows) {
      throw forbidden("Managed workflow directory changed during the write.");
    }
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  return temp;
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code !== "EINVAL" &&
      code !== "ENOTSUP" &&
      code !== "EISDIR" &&
      !(process.platform === "win32" && code === "EPERM")
    )
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createManagedFile(paths: ManagedPaths, id: string, bytes: Buffer): ManagedFile {
  const target = join(paths.workflows, `${id}.json`);
  const temp = writeTemp(paths, id, bytes);
  let linked = false;
  try {
    try {
      linkSync(temp, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DevChestraError("E_CONFLICT", `Workflow '${id}' already exists.`);
      }
      throw error;
    }
    syncDirectory(paths.workflows);
  } finally {
    rmSync(temp, { force: true });
  }
  if (!linked) throw new DevChestraError("E_INTERNAL", "Workflow was not created.");
  return committedFile(paths, id, bytes);
}

export function replaceManagedFile(
  paths: ManagedPaths,
  id: string,
  bytes: Buffer,
  expectedEtag: string,
): ManagedFile {
  const current = readManagedFile(paths, id);
  if (current.etag !== expectedEtag) throw conflict(current.etag);
  const temp = writeTemp(paths, id, bytes);
  let committed = false;
  try {
    // Re-check immediately before the rename: an ordinary external edit between
    // the comparison above and this point must surface as a conflict, not be lost.
    const fresh = readManagedFile(paths, id);
    if (fresh.etag !== expectedEtag) throw conflict(fresh.etag);
    const target = join(paths.workflows, `${id}.json`);
    renameSync(temp, target);
    syncDirectory(paths.workflows);
    committed = true;
  } finally {
    if (!committed) rmSync(temp, { force: true });
  }
  return committedFile(paths, id, bytes);
}

/** ACK the bytes this writer committed, not a later external edit. */
function committedFile(paths: ManagedPaths, id: string, bytes: Buffer): ManagedFile {
  const path = join(paths.workflows, `${id}.json`);
  const stat = lstatSync(path);
  return {
    id,
    path,
    relativeFile: `${paths.relativeWorkflows}/${id}.json`,
    bytes,
    text: bytes.toString("utf8"),
    etag: etagForBytes(bytes),
    updatedAt: Math.floor(stat.mtimeMs),
  };
}

export function deleteManagedFile(paths: ManagedPaths, id: string, expectedEtag: string): void {
  const current = readManagedFile(paths, id);
  if (current.etag !== expectedEtag) throw conflict(current.etag);
  const fresh = readManagedFile(paths, id);
  if (fresh.etag !== expectedEtag) throw conflict(fresh.etag);
  unlinkSync(join(paths.workflows, `${id}.json`));
  syncDirectory(paths.workflows);
}

export function isManagedWorkflowId(value: string): boolean {
  return WORKFLOW_ID_PATTERN.test(value);
}
