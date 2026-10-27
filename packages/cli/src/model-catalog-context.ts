import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { buildChildEnv } from "@relay/adapters";
import type { CatalogCli } from "@relay/server";

const MAX_ANCESTOR_DEPTH = 32;
const MAX_ANCESTOR_PATH = 1_024;

// Context observes env names/presence, never values. Rotating a secret without changing
// presence cannot be detected: restart Relay or refresh explicitly after rotation.
export const ENV_NAMES = [
  "HOME",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

const CODEX_FILES = ["config.toml", "config.json", "auth.json"] as const;
const CLAUDE_FILES = ["settings.json", "settings.local.json", ".credentials.json"] as const;

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

function ancestorConfigIdentity(cli: CatalogCli, cwd: string): string {
  const dirName = cli === "claude-code" ? ".claude" : ".codex";
  const names = cli === "claude-code" ? CLAUDE_FILES : CODEX_FILES;
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
      // named settings/auth files count (Claude files only for Claude).
      parts.push(
        cli === "claude-code"
          ? `${digest(configDir)}:${filesIdentity(configDir, names)}`
          : `${digest(configDir)}:${dirIdentity}:${filesIdentity(configDir, names)}`,
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

function homeConfigIdentity(cli: CatalogCli, env: Record<string, string>, cwd: string): string {
  const pathFrom = (value: string): string =>
    isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const home = env.HOME !== undefined && env.HOME !== "" ? pathFrom(env.HOME) : null;
  if (cli === "claude-code") {
    const configDir =
      env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
        ? pathFrom(env.CLAUDE_CONFIG_DIR)
        : home === null
          ? null
          : join(home, ".claude");
    // settings.json/settings.local.json/.credentials.json are strict identity.
    // The config directory's own mtime is excluded: Claude writes session,
    // project and plugin state inside it, which would self-invalidate the cache.
    const files =
      configDir === null
        ? "none"
        : `${digest(configDir)}:${filesIdentity(configDir, CLAUDE_FILES)}`;
    // ~/.claude.json mixes provider/model settings with volatile startup/auth
    // cache counters. Observe presence only so a normal launch cannot discard an
    // otherwise valid catalog; auth still comes from .credentials.json above.
    const userFile =
      home === null || !existsSync(join(home, ".claude.json")) ? "absent" : "present";
    return `${files}|${userFile}`;
  }
  const codexHome =
    env.CODEX_HOME !== undefined && env.CODEX_HOME !== ""
      ? pathFrom(env.CODEX_HOME)
      : home === null
        ? null
        : join(home, ".codex");
  // Do not include the Codex home directory's mtime/size: the native app-server
  // may write models_cache.json or other files there during discovery. Only the
  // named config/auth files are identity.
  return codexHome === null
    ? "none"
    : `${digest(codexHome)}:${filesIdentity(codexHome, CODEX_FILES)}`;
}

export function configIdentity(cli: CatalogCli, env: Record<string, string>, cwd: string): string {
  const names =
    cli === "claude-code"
      ? [
          ...ENV_NAMES,
          ...Object.keys(env)
            .filter((name) => name.startsWith("CLAUDE_CODE_"))
            .sort(),
        ]
      : ENV_NAMES;
  const presence = names.map((name) => `${name}:${env[name] === undefined ? "0" : "1"}`).join(",");
  return `${presence}|${homeConfigIdentity(cli, env, cwd)}|${ancestorConfigIdentity(cli, cwd)}`;
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
