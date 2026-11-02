// Pure helpers for scripts/setup-global.mjs. No side effects, so they are unit-tested.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** The only secrets DevChestra ever reads (see packages/decisions/src/secrets.ts). */
export const SECRET_NAMES = ["TYPESAFE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"];

/** Per-user config dir, matching the lookup in the decisions package. */
export function configDir(env = process.env, home = homedir()) {
  if (env.DEVCHESTRA_CONFIG_DIR) return env.DEVCHESTRA_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "devchestra");
  return join(home, ".config", "devchestra");
}

/** The allowed secrets present (non-empty) in a .env text. Anything else is ignored. */
export function pickSecrets(text) {
  let parsed;
  try {
    parsed = parseEnv(text);
  } catch {
    return {};
  }
  const found = {};
  for (const name of SECRET_NAMES) {
    const value = parsed[name];
    if (typeof value === "string" && value !== "") found[name] = value;
  }
  return found;
}

/**
 * What to do about the keys. Never overwrites a value that is already in the
 * config file; only adds names it does not have yet.
 * @returns {{action: "none" | "complete" | "write", add: string[], have: string[]}}
 */
export function planKeys(repoText, configText) {
  const fromRepo = repoText === null ? {} : pickSecrets(repoText);
  const existing = configText === null ? {} : pickSecrets(configText);
  const have = Object.keys(existing);
  const add = Object.keys(fromRepo).filter((name) => existing[name] === undefined);
  if (Object.keys(fromRepo).length === 0 && have.length === 0) {
    return { action: "none", add: [], have };
  }
  return { action: add.length > 0 ? "write" : "complete", add, have };
}

/** New config file text: keeps every existing line, appends only the missing keys. */
export function mergedConfigText(configText, repoText, add) {
  const fromRepo = pickSecrets(repoText ?? "");
  const base = configText === null || configText === "" ? "" : configText.replace(/\n?$/u, "\n");
  const lines = add.map((name) => `${name}=${fromRepo[name]}`);
  return `${base}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** True when group/other can read or write the file. */
export function modeTooOpen(mode) {
  return (mode & 0o077) !== 0;
}

export function pathContains(pathValue, dir) {
  return (pathValue ?? "").split(":").filter(Boolean).includes(dir);
}

export function nodeMajorOk(version, minimum = 22) {
  const major = Number(String(version).replace(/^v/u, "").split(".")[0]);
  return Number.isInteger(major) && major >= minimum;
}

/** Decision providers and the secrets each one needs (names match .env.example). */
export const PROVIDERS = [
  { label: "Jev (TypeSafe AI)", secrets: ["TYPESAFE_API_KEY"] },
  {
    label: "Clef (Cloudflare Workers AI)",
    secrets: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
  },
];

/** Providers that still lack at least one secret, with just the missing names. */
export function providerGaps(haveNames) {
  const have = new Set(haveNames);
  return PROVIDERS.map((provider) => ({
    label: provider.label,
    missing: provider.secrets.filter((name) => !have.has(name)),
  })).filter((gap) => gap.missing.length > 0);
}

/** Config text with the given allowed secrets appended. Existing lines are kept; blanks skipped. */
export function appendSecrets(configText, values) {
  const lines = Object.entries(values)
    .filter(([name, value]) => SECRET_NAMES.includes(name) && value.trim() !== "")
    .map(([name, value]) => `${name}=${value.trim()}`);
  const base = configText === null || configText === "" ? "" : configText.replace(/\n?$/u, "\n");
  return `${base}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}
