import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Exact secret names ever read (contract §2). Nothing else is taken. */
export const DECISION_SECRET_NAMES = [
  "TYPESAFE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AUTH_TOKEN",
] as const;

export type DecisionSecretName = (typeof DECISION_SECRET_NAMES)[number];

const secretNameSet: ReadonlySet<string> = new Set(DECISION_SECRET_NAMES);

export function isDecisionSecretName(value: unknown): value is DecisionSecretName {
  return typeof value === "string" && secretNameSet.has(value);
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Where DevChestra looks for a `.env` when none is given, most specific first:
 * `$DEVCHESTRA_ENV_FILE`, `<cwd>/.env`, then the per-user config directory
 * (`$DEVCHESTRA_CONFIG_DIR`, else `$XDG_CONFIG_HOME/devchestra`, else
 * `~/.config/devchestra`). The last one is what a globally installed command
 * relies on, because it is not started from the repository folder.
 */
export function defaultDotenvPaths(env: EnvLike = process.env, cwd = process.cwd()): string[] {
  const paths: string[] = [];
  const explicit = env.DEVCHESTRA_ENV_FILE;
  if (explicit !== undefined && explicit !== "") paths.push(explicit);
  paths.push(join(cwd, ".env"));
  const configDir =
    env.DEVCHESTRA_CONFIG_DIR !== undefined && env.DEVCHESTRA_CONFIG_DIR !== ""
      ? env.DEVCHESTRA_CONFIG_DIR
      : env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
        ? join(env.XDG_CONFIG_HOME, "devchestra")
        : join(homedir(), ".config", "devchestra");
  paths.push(join(configDir, ".env"));
  return paths;
}

/** Human-readable list of the lookup places, for error messages and `doctor`. */
export const DOTENV_LOOKUP_HINT =
  "the environment, a .env in the folder you start devchestra from, or ~/.config/devchestra/.env";

export interface LoadSecretsOptions {
  /** Defaults to `process.env`. Injected in tests; never written to. */
  env?: EnvLike | undefined;
  /**
   * Absolute path of the one `.env` file to fall back to. When omitted, the
   * places in {@link defaultDotenvPaths} are tried. Pass `null` to skip file
   * fallback entirely.
   */
  dotenvPath?: string | null | undefined;
}

/**
 * Load decision key material. Source order: real `process.env` first, then
 * each `.env` file in order (see {@link defaultDotenvPaths}), parsed with
 * `node:util` `parseEnv`. Each name comes from the first source that has it.
 * Only {@link DECISION_SECRET_NAMES} are ever taken from a file; anything else
 * in it is ignored. `process.env` is never mutated. Empty strings count as
 * missing.
 */
export function loadDecisionSecrets(
  options: LoadSecretsOptions = {},
): Partial<Record<DecisionSecretName, string>> {
  const env: EnvLike = options.env ?? process.env;
  const found: Partial<Record<DecisionSecretName, string>> = {};
  for (const name of DECISION_SECRET_NAMES) {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") {
      found[name] = fromEnv;
    }
  }
  if (options.dotenvPath === null) {
    return found;
  }
  const files = options.dotenvPath === undefined ? defaultDotenvPaths(env) : [options.dotenvPath];
  for (const file of files) {
    if (DECISION_SECRET_NAMES.every((name) => found[name] !== undefined)) break;
    let parsed: Record<string, string | undefined>;
    try {
      if (!existsSync(file)) continue;
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const name of DECISION_SECRET_NAMES) {
      if (found[name] !== undefined) continue;
      const fromFile = parsed[name];
      if (fromFile !== undefined && fromFile !== "") found[name] = fromFile;
    }
  }
  return found;
}

/** Names from `required` that are absent from `secrets`. Values never appear. */
export function missingSecretNames(
  secrets: Partial<Record<DecisionSecretName, string>>,
  required: readonly DecisionSecretName[],
): DecisionSecretName[] {
  return required.filter((name) => {
    const value = secrets[name];
    if (value === undefined) return true;
    // A malformed value counts as missing so it is reported by name only and
    // never reaches a URL. The account id is substituted into a request path.
    const pattern = SECRET_FORMATS[name];
    return pattern !== undefined && !pattern.test(value);
  });
}

/** Format checks for secrets that are placed into a URL. Values never appear in messages. */
const SECRET_FORMATS: Partial<Record<DecisionSecretName, RegExp>> = {
  CLOUDFLARE_ACCOUNT_ID: /^[A-Za-z0-9_-]{1,64}$/,
};

/**
 * Replace every known secret value in `text` with `[redacted]`. Applied to
 * every error, event and log string before it leaves this package, so a key
 * value can never appear in errors, events, logs, API responses or fixtures.
 */
export function redactSecrets(
  text: string,
  secrets: Partial<Record<DecisionSecretName, string>>,
): string {
  let out = text;
  const values = Object.values(secrets).filter((v): v is string => v !== undefined && v !== "");
  values.sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join("[redacted]");
  }
  return out;
}
