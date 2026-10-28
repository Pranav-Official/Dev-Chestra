import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import { DevChestraError } from "@devchestra/core";
import { processAlive, processIdentity } from "./lock.js";

export interface ServerMetadata {
  version: string;
  pid: number;
  pidStart: string;
  port: number;
  token: string;
  instanceId: string;
  startedAt: number;
}

export type MetadataRead =
  | { status: "missing" }
  | { status: "valid"; value: ServerMetadata }
  | { status: "invalid"; reason: string }
  | { status: "unsafe"; reason: string };

const FILE = "server.json";

export function serverMetadataPath(dataDir: string): string {
  return join(dataDir, FILE);
}

export function createInstanceId(): string {
  return randomBytes(16).toString("base64url");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isServerMetadata(value: unknown): value is ServerMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === "string" &&
    record.version !== "" &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.pidStart === "string" &&
    record.pidStart !== "" &&
    Number.isSafeInteger(record.port) &&
    (record.port as number) > 0 &&
    (record.port as number) <= 65535 &&
    typeof record.token === "string" &&
    record.token.length >= 32 &&
    typeof record.instanceId === "string" &&
    record.instanceId !== "" &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt)
  );
}

function ownerOnly(stat: { mode: number; uid: number }): string | null {
  if ((stat.mode & 0o077) !== 0) return "metadata is not owner-only (expected mode 0600)";
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return "metadata is owned by another user";
  return null;
}

export async function readServerMetadata(dataDir: string): Promise<MetadataRead> {
  const file = serverMetadataPath(dataDir);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", reason: "metadata could not be inspected" };
  }
  if (stat.isSymbolicLink()) {
    return { status: "unsafe", reason: "metadata path is a symlink" };
  }
  if (!stat.isFile()) {
    return { status: "unsafe", reason: "metadata path is not a regular file" };
  }
  const mode = ownerOnly(stat);
  if (mode !== null) return { status: "unsafe", reason: mode };

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: "invalid", reason: "metadata could not be opened" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { status: "unsafe", reason: "metadata is not a regular file" };
    const addressed = ownerOnly(opened);
    if (addressed !== null) return { status: "unsafe", reason: addressed };
    const text = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "invalid", reason: "metadata is not valid JSON" };
    }
    if (!isServerMetadata(parsed))
      return { status: "invalid", reason: "metadata shape is invalid" };
    return { status: "valid", value: parsed };
  } catch {
    return { status: "invalid", reason: "metadata could not be read" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureOwnerDataDir(dataDir: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(dataDir);
  }
  if (stat.isSymbolicLink()) {
    throw new DevChestraError(
      "E_CONFLICT",
      "The data directory is a symlink; refusing to write metadata",
    );
  }
  if (!stat.isDirectory()) {
    throw new DevChestraError("E_VALIDATION", "The data directory is not a directory");
  }
}

export async function writeServerMetadata(
  dataDir: string,
  metadata: ServerMetadata,
): Promise<void> {
  await ensureOwnerDataDir(dataDir);
  const file = serverMetadataPath(dataDir);
  try {
    const existing = await fs.lstat(file);
    if (existing.isSymbolicLink()) {
      throw new DevChestraError("E_CONFLICT", "server.json is a symlink; refusing to replace it");
    }
    if (!existing.isFile()) {
      throw new DevChestraError("E_CONFLICT", "server.json is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = join(dataDir, `.server.json.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** Remove a stale metadata file while holding the data-dir lock. Never follows links. */
export async function clearServerMetadata(dataDir: string): Promise<void> {
  const file = serverMetadataPath(dataDir);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new DevChestraError(
        "E_CONFLICT",
        "server.json is not a regular file; refusing to replace it",
      );
    }
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function removeOwnServerMetadata(
  dataDir: string,
  own: Pick<ServerMetadata, "pid" | "pidStart" | "instanceId" | "token">,
): Promise<void> {
  const read = await readServerMetadata(dataDir);
  if (read.status !== "valid") return;
  const value = read.value;
  if (
    value.pid !== own.pid ||
    value.pidStart !== own.pidStart ||
    value.instanceId !== own.instanceId ||
    value.token !== own.token
  ) {
    return;
  }
  await fs.unlink(serverMetadataPath(dataDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function ownerLooksAlive(
  metadata: Pick<ServerMetadata, "pid" | "pidStart">,
  identity: (pid: number) => string | null = processIdentity,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  if (!alive(metadata.pid)) return false;
  const current = identity(metadata.pid);
  return current !== null && current === metadata.pidStart;
}

export interface HealthIdentity {
  ok?: unknown;
  instanceId?: unknown;
  webReady?: unknown;
}

export async function attachToServer(
  metadata: ServerMetadata,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    identity?: (pid: number) => string | null;
    alive?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  if (
    !ownerLooksAlive(metadata, options.identity ?? processIdentity, options.alive ?? processAlive)
  ) {
    throw new DevChestraError("E_CONFLICT", "The recorded server owner is not running");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  let payload: HealthIdentity;
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `http://127.0.0.1:${metadata.port}/api/health`,
      {
        headers: { accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new DevChestraError("E_CONFLICT", "The running server rejected the health check");
    }
    payload = (await response.json()) as HealthIdentity;
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
    throw new DevChestraError("E_CONFLICT", "The recorded server did not answer its health check", {
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    clearTimeout(timer);
  }
  if (payload.ok !== true || payload.instanceId !== metadata.instanceId) {
    throw new DevChestraError(
      "E_CONFLICT",
      "The running server identity does not match server.json",
    );
  }
  if (payload.webReady === false) {
    throw new DevChestraError("E_CONFLICT", "The running server is not serving the web app");
  }
}

export function bootstrapUrl(metadata: ServerMetadata): string {
  return `http://127.0.0.1:${metadata.port}/?t=${encodeURIComponent(metadata.token)}`;
}

export function plainUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}
