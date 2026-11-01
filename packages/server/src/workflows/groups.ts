import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type WorkflowGroupsDocument,
  type WorkflowGroupsResponse,
  workflowGroupsDocumentSchema,
} from "@devchestra/api";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { DevChestraError } from "../errors.js";
import { etagForBytes, listManagedIds, managedPaths } from "./io.js";
import { withProjectLock } from "./lock.js";
import type { WorkflowProject } from "./service.js";

const EMPTY: WorkflowGroupsDocument = { version: 1, groups: [], memberships: {} };
const MAX_BYTES = 1024 * 1024;

function paths(project: WorkflowProject, dataDir: string, create: boolean) {
  if (project.missing)
    throw new DevChestraError("E_CONFLICT", "Relink the project before editing groups.");
  const root = assertProjectPathAllowed(project.path, dataDir);
  const managed = managedPaths(root, { create });
  return { root, path: join(root, ".devchestra", "workflow-groups.json"), managed };
}

function read(path: string): WorkflowGroupsResponse {
  let fd: number;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1)
      throw new DevChestraError("E_FORBIDDEN_PATH", "Cannot safely read workflow groups.");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const bytes = Buffer.from(JSON.stringify(EMPTY));
      return { document: EMPTY, etag: etagForBytes(bytes) };
    }
    throw new DevChestraError("E_FORBIDDEN_PATH", "Cannot safely read workflow groups.");
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
      throw new DevChestraError("E_VALIDATION", "Workflow groups file is unsafe or too large.");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_BYTES)
      throw new DevChestraError("E_VALIDATION", "Workflow groups file is too large.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DevChestraError("E_VALIDATION", "Workflow groups file contains invalid JSON.");
    }
    const parsed = workflowGroupsDocumentSchema.safeParse(value);
    if (!parsed.success)
      throw new DevChestraError(
        "E_VALIDATION",
        "Workflow groups file is invalid or has an unsupported version.",
      );
    return { document: parsed.data, etag: etagForBytes(bytes) };
  } finally {
    closeSync(fd);
  }
}

export function readWorkflowGroups(
  project: WorkflowProject,
  dataDir: string,
): WorkflowGroupsResponse {
  const p = paths(project, dataDir, false);
  if (p.managed === null)
    return { document: EMPTY, etag: etagForBytes(Buffer.from(JSON.stringify(EMPTY))) };
  return read(p.path);
}

export async function saveWorkflowGroups(
  project: WorkflowProject,
  dataDir: string,
  document: WorkflowGroupsDocument,
  expected: string,
): Promise<WorkflowGroupsResponse> {
  const p = paths(project, dataDir, true);
  return withProjectLock(p.root, async () => {
    const lock = `${p.path}.lock`;
    let lockFd: number;
    try {
      lockFd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new DevChestraError("E_CONFLICT", "Workflow groups are being edited. Retry shortly.");
      throw error;
    }
    const temp = `${p.path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const current = read(p.path);
      if (current.etag !== expected)
        throw new DevChestraError(
          "E_CONFLICT",
          "Workflow groups changed on disk. Reload and retry.",
          { currentEtag: current.etag },
        );
      const known = new Set(p.managed === null ? [] : listManagedIds(p.managed));
      for (const [workflowId, groupId] of Object.entries(document.memberships)) {
        if (current.document.memberships[workflowId] !== groupId && !known.has(workflowId)) {
          throw new DevChestraError("E_NOT_FOUND", `Workflow '${workflowId}' was not found.`);
        }
      }
      const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      if (bytes.length > MAX_BYTES)
        throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Workflow groups file is too large.");
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, p.path);
      return { document, etag: etagForBytes(bytes) };
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* no temporary file */
      }
      closeSync(lockFd);
      unlinkSync(lock);
    }
  });
}
