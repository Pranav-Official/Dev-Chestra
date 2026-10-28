import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { buildChildEnv, type CliId, getProvider } from "@relay/adapters";
import type { CatalogCli } from "@relay/server";

const MAX_ANCESTOR_DEPTH = 32;
const MAX_ANCESTOR_PATH = 1_024;

// Context observes env names/presence, never values. Rotating a secret without changing
// presence cannot be detected: restart Relay or refresh explicitly after rotation.
const GLOBAL_ENV_NAMES = ["HOME", "XDG_CONFIG_HOME"] as const;

export interface CatalogContext {
  key: string;
  versionKey: string;
  binaryKey: string;
  binaryPath: string | null;
  version: string | null;
  configId: string;
  env: Record<string, string>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function identityOf(path: string): string {
  try {
    const real = realpathSync.native(path);
    const info = statSync(real);
    const kind = info.isDirectory() ? "d" : info.isFile() ? "f" : "o";
    return `${kind}:${digest(real)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function filesIdentity(dir: string, names: readonly string[]): string {
  return names.map((name) => `${name}:${identityOf(join(dir, name))}`).join(":");
}

/** Directory identity without mtime/size: config dirs accumulate volatile cache files. */
function stableDirIdentity(path: string): string {
  try {
    const real = realpathSync.native(path);
    const info = statSync(real);
    return `d:${digest(real)}:${info.dev}:${info.ino}`;
  } catch {
    return "missing";
  }
}

export function resolveExecutable(
  bin: string,
  env: Record<string, string>,
  cwd: string,
): string | null {
  const candidates: string[] = [];
  if (bin.includes("/") || isAbsolute(bin)) {
    candidates.push(isAbsolute(bin) ? resolve(bin) : resolve(cwd, bin));
  } else {
    for (const part of (env.PATH ?? "").split(delimiter)) {
      if (part === "") continue;
      candidates.push(isAbsolute(part) ? join(part, bin) : resolve(cwd, part, bin));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function ancestorConfigIdentity(
  dirName: string,
  files: readonly string[],
  includeDirIdentity: boolean,
  cwd: string,
): string {
  const parts: string[] = [];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  let depth = 0;
  while (depth < MAX_ANCESTOR_DEPTH && dir.length <= MAX_ANCESTOR_PATH) {
    const configDir = join(dir, dirName);
    const dirIdentity = stableDirIdentity(configDir);
    if (dirIdentity !== "missing") {
      // Config directories accumulate session/project/plugin/cache state, so
      // their mtime/size is not identity. Only canonical dir dev/ino plus the
      // named settings/auth files count (dir dev/ino only where the provider asks).
      parts.push(
        includeDirIdentity
          ? `${digest(configDir)}:${dirIdentity}:${filesIdentity(configDir, files)}`
          : `${digest(configDir)}:${filesIdentity(configDir, files)}`,
      );
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth += 1;
  }
  return parts.join("|");
}

function homeConfigIdentity(
  homeEnvVar: string,
  homeSubdir: string,
  files: readonly string[],
  userPresenceFile: string | undefined,
  home: string | null,
  env: Record<string, string>,
  cwd: string,
): string {
  const pathFrom = (value: string): string =>
    isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const fromEnv =
    homeEnvVar !== "" && env[homeEnvVar] !== undefined && env[homeEnvVar] !== ""
      ? pathFrom(env[homeEnvVar] as string)
      : null;
  const configDir = fromEnv ?? (home === null || homeSubdir === "" ? null : join(home, homeSubdir));
  // settings/auth files are strict identity; the config directory's own
  // mtime is excluded (session/project/plugin state would self-invalidate).
  const base =
    configDir === null ? "none" : `${digest(configDir)}:${filesIdentity(configDir, files)}`;
  if (userPresenceFile === undefined || home === null) return base;
  // Presence only (e.g. ~/.claude.json mixes provider settings with volatile
  // cache counters): a normal launch must not discard an otherwise valid catalog.
  const userFile = !existsSync(join(home, userPresenceFile)) ? "absent" : "present";
  return `${base}|${userFile}`;
}

export function configIdentity(cli: CatalogCli, env: Record<string, string>, cwd: string): string {
  const identity = getProvider(cli as CliId).contextIdentity;
  const names = [
    ...GLOBAL_ENV_NAMES,
    ...identity.envNames,
    ...Object.keys(env)
      .filter((name) => identity.extraEnvPrefixes.some((prefix) => name.startsWith(prefix)))
      .sort(),
  ];
  const presence = names.map((name) => `${name}:${env[name] === undefined ? "0" : "1"}`).join(",");
  const pathFrom = (value: string): string =>
    isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const home = env.HOME !== undefined && env.HOME !== "" ? pathFrom(env.HOME) : null;
  const homePart = homeConfigIdentity(
    identity.homeEnvVar,
    identity.homeSubdir,
    identity.configFiles,
    identity.userPresenceFile,
    home,
    env,
    cwd,
  );
  const ancestorPart = ancestorConfigIdentity(
    identity.configDirName,
    identity.configFiles,
    identity.includeConfigDirIdentity,
    cwd,
  );
  return `${presence}|${homePart}|${ancestorPart}`;
}

export function contextKey(
  cli: CatalogCli,
  binaryKey: string,
  version: string | null,
  configId: string,
): string {
  return digest([cli, binaryKey, version ?? "unknown", configId].join("\0"));
}

export function versionKey(cli: CatalogCli, binaryKey: string): string {
  return `${cli}\0${binaryKey}`;
}

export function buildContext(
  cli: CatalogCli,
  bin: string,
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  versionFor: (key: string) => string | null,
): CatalogContext {
  const env = buildChildEnv(cli, { base: baseEnv });
  const binaryPath = resolveExecutable(bin, env, cwd);
  const binaryKey = binaryPath === null ? "missing" : identityOf(binaryPath);
  const configId = configIdentity(cli, env, cwd);
  const memoKey = versionKey(cli, binaryKey);
  const version = versionFor(memoKey);
  return {
    key: contextKey(cli, binaryKey, version, configId),
    versionKey: memoKey,
    binaryKey,
    binaryPath,
    version,
    configId,
    env,
  };
}
