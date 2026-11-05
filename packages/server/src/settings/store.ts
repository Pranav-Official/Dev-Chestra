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
  type SettingsFile,
  type SettingsScope,
  serializeSettings,
} from "@devchestra/schema";
import { DevChestraError } from "../errors.js";
import { ensureManagedDirectory, etagForBytes } from "../workflows/io.js";
import { withProjectLock } from "../workflows/lock.js";

const DEVCHESTRA_DIR = ".devchestra";
const GITIGNORE_FILE = ".gitignore";
const GITIGNORE_HEADER = "# DevChestra: machine-local files, not shared with the team";

/** One settings file as read from disk. A missing file reads as an empty document. */
export interface SettingsLayer {
  scope: SettingsScope;
  document: SettingsFile;
  etag: string;
  exists: boolean;
  warnings: string[];
}

function emptyDocument(): SettingsFile {
  return { version: SETTINGS_VERSION };
}

function layerPath(root: string, scope: SettingsScope): string {
  return join(root, DEVCHESTRA_DIR, SETTINGS_FILE_NAMES[scope]);
}

function unsafe(scope: SettingsScope): DevChestraError {
  return new DevChestraError(
    "E_FORBIDDEN_PATH",
    `${SETTINGS_FILE_NAMES[scope]} must be a regular file inside the project, not a link.`,
  );
}

/** Reads one file without following links; null when it does not exist. */
function readRegularFile(path: string, scope: SettingsScope): Buffer | null {
  let fd: number;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw unsafe(scope);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unsafe(scope);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw unsafe(scope);
    if (stat.size > MAX_SETTINGS_FILE_BYTES) {
      throw new DevChestraError(
        "E_VALIDATION",
        `${SETTINGS_FILE_NAMES[scope]} exceeds the ${MAX_SETTINGS_FILE_BYTES / 1024} KiB limit.`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
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
  const bytes = devchestraDirExists(root) ? readRegularFile(layerPath(root, scope), scope) : null;
  if (bytes === null) {
    const document = emptyDocument();
    return {
      scope,
      document,
      etag: etagForBytes(Buffer.from(serializeSettings(document), "utf8")),
      exists: false,
      warnings: [],
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

/** Keeps `settings.local.json` out of git without touching the project's own `.gitignore`. */
function ensureLocalIgnored(root: string): void {
  const path = join(root, DEVCHESTRA_DIR, GITIGNORE_FILE);
  let text = "";
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new DevChestraError(
        "E_FORBIDDEN_PATH",
        ".devchestra/.gitignore must be a regular file, not a link.",
      );
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entry = SETTINGS_FILE_NAMES.local;
  const covered = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === entry || line === `/${entry}`);
  if (covered) return;
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  const addition = text === "" ? `${GITIGNORE_HEADER}\n${entry}\n` : `${separator}${entry}\n`;
  writeFileSync(path, `${text}${addition}`, { mode: 0o644 });
}

/**
 * Saves one settings layer if `expectedEtag` still matches the file on disk. Saving the local
 * layer also makes sure git ignores it. An empty document removes the file instead of leaving
 * an empty one behind.
 */
export async function saveSettingsLayer(
  projectPath: string,
  scope: SettingsScope,
  document: SettingsFile,
  expectedEtag: string,
): Promise<SettingsLayer> {
  let root: string;
  try {
    root = realpathSync.native(projectPath);
  } catch {
    throw new DevChestraError(
      "E_CONFLICT",
      "Project path is missing; relink the project before editing settings.",
    );
  }
  return withProjectLock(root, async () => {
    const dir = join(root, DEVCHESTRA_DIR);
    ensureManagedDirectory(dir, root);
    const current = readSettingsLayer(root, scope);
    if (current.etag !== expectedEtag) {
      throw new DevChestraError(
        "E_CONFLICT",
        `${SETTINGS_FILE_NAMES[scope]} changed on disk. Reload and retry.`,
        { currentEtag: current.etag },
      );
    }
    const path = layerPath(root, scope);
    const text = serializeSettings(document);
    const isEmpty = document.models === undefined || Object.keys(document.models).length === 0;
    if (scope === "local") ensureLocalIgnored(root);
    if (isEmpty) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return readSettingsLayer(root, scope);
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_SETTINGS_FILE_BYTES) {
      throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Settings file is too large.");
    }
    const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const fd = openSync(temp, "wx", scope === "local" ? 0o600 : 0o644);
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
    return readSettingsLayer(root, scope);
  });
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
  const shared = readSettingsLayer(root, "project");
  const local = readSettingsLayer(root, "local");
  const missing = MODEL_TIERS.filter(
    (tier) =>
      shared.document.models?.[tier] === undefined && local.document.models?.[tier] === undefined,
  );
  if (missing.length === 0) return [];
  const models = { ...(local.document.models ?? {}) };
  for (const tier of missing) models[tier] = { cli };
  await saveSettingsLayer(projectPath, "local", { version: SETTINGS_VERSION, models }, local.etag);
  return missing;
}
