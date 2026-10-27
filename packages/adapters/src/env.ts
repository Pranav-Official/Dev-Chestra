import { RelayError } from "@relay/core";
import type { BuildEnvOptions, CliId } from "./types.js";

const ALWAYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

const AUTH: Record<CliId, readonly string[]> = {
  "claude-code": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
  ],
  codex: ["CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  fake: [],
};

const INJECTION = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "PERL5LIB",
  "RUBYLIB",
  "GCONV_PATH",
  "LOCPATH",
]);

function reject(name: string, why: string): never {
  throw new RelayError("E_VALIDATION", `Environment variable ${name} is not allowed: ${why}`);
}

/**
 * Build a child environment from an explicit allowlist. Process env is never
 * copied wholesale. Declared non-reserved names pass through; RELAY_* only
 * comes from trusted `injected` values; loader/injection vars are refused.
 */
export function buildChildEnv(cli: CliId, options: BuildEnvOptions = {}): Record<string, string> {
  const base = options.base ?? process.env;
  const env: Record<string, string> = {};
  const copy = (name: string): void => {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  };
  const declared = (name: string): void => {
    if (INJECTION.has(name)) reject(name, "loader/injection variables are blocked");
    if (name.startsWith("RELAY_")) reject(name, "RELAY_* must be supplied through injected env");
  };

  for (const name of ALWAYS) copy(name);
  for (const name of Object.keys(base)) if (name.startsWith("LC_")) copy(name);
  for (const name of AUTH[cli]) copy(name);
  if (cli === "claude-code") {
    for (const name of Object.keys(base)) if (name.startsWith("CLAUDE_CODE_")) copy(name);
  }

  for (const name of [...(options.extraNames ?? []), ...(options.nodeEnvNames ?? [])]) {
    declared(name);
    copy(name);
  }
  for (const [name, value] of Object.entries(options.nodeEnv ?? {})) {
    declared(name);
    env[name] = value;
  }
  for (const [name, value] of Object.entries(options.cliEnv ?? {})) {
    declared(name);
    env[name] = value;
  }
  for (const [name, value] of Object.entries(options.injected ?? {})) {
    if (INJECTION.has(name)) reject(name, "loader/injection variables are blocked");
    env[name] = value;
  }

  for (const name of Object.keys(env)) {
    if (name.startsWith("RELAY_") && !(name in (options.injected ?? {}))) delete env[name];
  }
  env.TERM = "dumb";
  env.CI = "1";
  return env;
}
