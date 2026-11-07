import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentCli,
  type EffectiveModelTiers,
  MAX_SETTINGS_FILE_BYTES,
  MODEL_TIERS,
  type ModelTierId,
  mergeModelTiers,
  parseSettings,
  SETTINGS_FILE_NAMES,
  SETTINGS_VERSION,
  type SettingsExtras,
  type SettingsFile,
  type SettingsScope,
  serializeSettings,
} from "@devchestra/schema";
import { DevChestraError } from "../errors.js";
import { ensureManagedDirectory, etagForBytes } from "../workflows/io.js";
import { withProjectLock } from "../workflows/lock.js";
import { withFileLock } from "./file-lock.js";

const DEVCHESTRA_DIR = ".devchestra";
const GITIGNORE_FILE = ".gitignore";
const LOCK_FILE = "settings.lock";
const MAX_GITIGNORE_BYTES = 1024 * 1024;
const GITIGNORE_HEADER = "# DevChestra: machine-local files, not shared with the team";

/** One settings file as read from disk. A missing file reads as an empty document. */
export interface SettingsLayer {
  scope: SettingsScope;
  document: SettingsFile;
  etag: string;
  exists: boolean;
  warnings: string[];
  /** Unknown top-level keys, written back untouched on save. Not part of the HTTP response. */
  extras: SettingsExtras;
}

function emptyDocument(): SettingsFile {
  return { version: SETTINGS_VERSION };
}

function layerPath(root: string, scope: SettingsScope): string {
  return join(root, DEVCHESTRA_DIR, SETTINGS_FILE_NAMES[scope]);
}

function unsafe(label: string): DevChestraError {
  return new DevChestraError(
    "E_FORBIDDEN_PATH",
    `${label} must be a regular file inside the project, not a link.`,
  );
}

/**
 * Reads one file without following links and rejects hard-linked files (another name for the
 * same inode would be changed by an in-place write); null when it does not exist.
 */
function readRegularFile(path: string, label: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw unsafe(label);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unsafe(label);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw unsafe(label);
    if (stat.size > maxBytes) {
      throw new DevChestraError(
        "E_VALIDATION",
        `${label} exceeds the ${maxBytes / 1024} KiB limit.`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes `bytes` to a new temporary file next to `path`, then renames it over `path`. */
function writeFileAtomic(path: string, bytes: Buffer, mode: number): void {
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* the rename consumed the temporary file */
    }
  }
}

function devchestraDirExists(root: string): boolean {
  try {
    const stat = lstatSync(join(root, DEVCHESTRA_DIR));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads one settings layer. A file that is not valid settings raises E_VALIDATION naming the file. */
export function readSettingsLayer(root: string, scope: SettingsScope): SettingsLayer {
  const name = SETTINGS_FILE_NAMES[scope];
  const bytes = devchestraDirExists(root)
    ? readRegularFile(layerPath(root, scope), name, MAX_SETTINGS_FILE_BYTES)
    : null;
  if (bytes === null) {
    const document = emptyDocument();
    return {
      scope,
      document,
      etag: etagForBytes(Buffer.from(serializeSettings(document), "utf8")),
      exists: false,
      warnings: [],
      extras: {},
    };
  }
  const parsed = parseSettings(bytes.toString("utf8"));
  if (!parsed.ok) {
    throw new DevChestraError("E_VALIDATION", `${name} is not valid: ${parsed.error.message}`, {
      details: parsed.error.details,
    });
  }
  return {
    scope,
    document: parsed.value.file,
    etag: etagForBytes(bytes),
    exists: true,
    warnings: parsed.value.warnings,
    extras: parsed.value.extras,
  };
}

/** The tier mapping a run in this project would use, local file over committed file. */
export function loadEffectiveModelTiers(projectPath: string): EffectiveModelTiers {
  let root: string;
  try {
    root = realpathSync.native(projectPath);
  } catch {
    throw new DevChestraError(
      "E_CONFLICT",
      "Project path is missing; relink the project before starting a run.",
    );
  }
  return mergeModelTiers(
    readSettingsLayer(root, "project").document,
    readSettingsLayer(root, "local").document,
  );
}

/**
 * Keeps `settings.local.json` out of git without touching the project's own `.gitignore`.
 * Links are rejected, and an append replaces the file instead of rewriting its inode, so
 * another name for the same file is never modified.
 */
function ensureLocalIgnored(root: string): void {
  const path = join(root, DEVCHESTRA_DIR, GITIGNORE_FILE);
  const existing = readRegularFile(path, ".devchestra/.gitignore", MAX_GITIGNORE_BYTES);
  const text = existing?.toString("utf8") ?? "";
  const entry = SETTINGS_FILE_NAMES.local;
  const covered = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === entry || line === `/${entry}`);
  if (covered) return;
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  const addition = text === "" ? `${GITIGNORE_HEADER}\n${entry}\n` : `${separator}${entry}\n`;
  const mode = existing === null ? 0o644 : lstatSync(path).mode & 0o777;
  writeFileAtomic(path, Buffer.from(`${text}${addition}`, "utf8"), mode);
}

function resolveRoot(projectPath: string, action: string): string {
  try {
    return realpathSync.native(projectPath);
  } catch {
    throw new DevChestraError(
      "E_CONFLICT",
      `Project path is missing; relink the project before ${action}.`,
    );
  }
}

/**
 * Runs `run` while no other DevChestra process (or request in this one) is changing this
 * project's settings. The revision check and the commit must both happen inside it.
 */
async function withSettingsLock<T>(root: string, run: () => T): Promise<T> {
  return withProjectLock(root, async () => {
    const dir = join(root, DEVCHESTRA_DIR);
    ensureManagedDirectory(dir, root);
    return withFileLock(join(dir, LOCK_FILE), run);
  });
}

/**
 * Checks `expectedEtag` against the file on disk and writes the new document. Must run inside
 * `withSettingsLock`. Unknown top-level keys of the file as it is now are carried over, and the
 * file is only removed when neither tiers nor such keys remain.
 */
function commitSettingsLayer(
  root: string,
  scope: SettingsScope,
  document: SettingsFile,
  expectedEtag: string,
): SettingsLayer {
  const current = readSettingsLayer(root, scope);
  if (current.etag !== expectedEtag) {
    throw new DevChestraError(
      "E_CONFLICT",
      `${SETTINGS_FILE_NAMES[scope]} changed on disk. Reload and retry.`,
      { currentEtag: current.etag },
    );
  }
  const path = layerPath(root, scope);
  const hasModels = document.models !== undefined && Object.keys(document.models).length > 0;
  if (scope === "local") ensureLocalIgnored(root);
  if (!hasModels && Object.keys(current.extras).length === 0) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return readSettingsLayer(root, scope);
  }
  const bytes = Buffer.from(serializeSettings(document, current.extras), "utf8");
  if (bytes.length > MAX_SETTINGS_FILE_BYTES) {
    throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Settings file is too large.");
  }
  writeFileAtomic(path, bytes, scope === "local" ? 0o600 : 0o644);
  return readSettingsLayer(root, scope);
}

/**
 * Saves one settings layer if `expectedEtag` still matches the file on disk. Saving the local
 * layer also makes sure git ignores it. A document without tiers removes the file instead of
 * leaving an empty one behind, unless the file holds keys this version does not know.
 */
export async function saveSettingsLayer(
  projectPath: string,
  scope: SettingsScope,
  document: SettingsFile,
  expectedEtag: string,
): Promise<SettingsLayer> {
  const root = resolveRoot(projectPath, "editing settings");
  return withSettingsLock(root, () => commitSettingsLayer(root, scope, document, expectedEtag));
}

function missingTiers(root: string): { missing: ModelTierId[]; local: SettingsLayer } {
  const shared = readSettingsLayer(root, "project");
  const local = readSettingsLayer(root, "local");
  const missing = MODEL_TIERS.filter(
    (tier) =>
      shared.document.models?.[tier] === undefined && local.document.models?.[tier] === undefined,
  );
  return { missing, local };
}

/**
 * Points every tier that neither settings file maps yet at `cli` (its own default model) in the
 * machine-local file, so tiered workflows run on a freshly registered project. Tiers a committed
 * or earlier local mapping already covers are left alone. Returns the tiers it set.
 */
export async function seedLocalModelTiers(
  projectPath: string,
  cli: AgentCli,
): Promise<ModelTierId[]> {
  const root = realpathSync.native(projectPath);
  // Nothing to do is decided without the lock so it never creates `.devchestra`.
  if (missingTiers(root).missing.length === 0) return [];
  return withSettingsLock(root, () => {
    // Read again under the lock: another process may have mapped tiers since the check above.
    const { missing, local } = missingTiers(root);
    if (missing.length === 0) return [];
    const models = { ...(local.document.models ?? {}) };
    for (const tier of missing) models[tier] = { cli };
    commitSettingsLayer(root, "local", { version: SETTINGS_VERSION, models }, local.etag);
    return missing;
  });
}
