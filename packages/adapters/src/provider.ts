import { RelayError } from "@relay/core";
import { createClaudeAdapter } from "./claude.js";
import { discoverClaudeModels } from "./claude-model-discovery.js";
import { createCodexAdapter } from "./codex.js";
import { createFakeAdapter } from "./fake.js";
import { discoverCodexModels } from "./model-catalog.js";
import { createOpencodeAdapter } from "./opencode.js";
import { discoverOpencodeModels } from "./opencode-discovery.js";
import { createPiAdapter } from "./pi.js";
import { discoverPiModels } from "./pi-discovery.js";
import type { AdapterOptions, CliAdapter, CliId, ProdCliId } from "./types.js";

export type ModelDiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";

export type ModelDiscoverySource =
  | "codex-app-server"
  | "claude-sdk"
  | "pi-list-models"
  | "opencode-models";

export interface ModelDiscoveryItem {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  source: ModelDiscoverySource;
}

export interface ModelDiscoveryRequest {
  cwd: string;
  bin?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ModelDiscoveryResult {
  status: ModelDiscoveryStatus;
  items: ModelDiscoveryItem[];
  cliVersion: string | null;
  truncated: boolean;
  message?: string;
}

export interface ModelDiscoveryProvider {
  readonly source: ModelDiscoverySource | "none";
  discover(request: ModelDiscoveryRequest): Promise<ModelDiscoveryResult>;
}

export interface ContextIdentityProvider {
  readonly configDirName: string;
  readonly configFiles: readonly string[];
  /** Provider-specific env names for child-env allowlist and identity presence. */
  readonly envNames: readonly string[];
  /** Extra env prefixes copied into the child env and observed by presence. */
  readonly extraEnvPrefixes: readonly string[];
  /** Codex observes the config dir dev/ino; Claude excludes volatile dir mtime/size. */
  readonly includeConfigDirIdentity: boolean;
  /** e.g. ".claude.json": presence (not content) is identity. Absent when undefined. */
  readonly userPresenceFile?: string;
  /** Env var overriding the home config dir (e.g. CODEX_HOME); "" means none. */
  readonly homeEnvVar: string;
  /** Home config subdir (e.g. ".codex"); "" means no home config. */
  readonly homeSubdir: string;
}

export interface PermissionMap {
  readonly writeMode: string;
  readonly readOnlyMode: string;
  readonly networkTools: readonly string[];
  readonly writeTools: readonly string[];
  readonly readOnlyDeniedTools: readonly string[];
}

export interface CliProvider {
  readonly id: CliId;
  readonly label: string;
  readonly binNames: readonly string[];
  readonly defaultBin: string;
  adapter(options?: AdapterOptions): CliAdapter;
  readonly discovery: ModelDiscoveryProvider;
  readonly contextIdentity: ContextIdentityProvider;
  /** CLI flag carrying an explicit model id ("" when the CLI has none). */
  readonly modelArg: string;
  readonly permissionMap: PermissionMap;
  /** Real CLIs need an explicit experimental opt-in; the fake never does. */
  readonly experimental: boolean;
}

export const claudePermissionMap: PermissionMap = {
  writeMode: "dontAsk",
  readOnlyMode: "dontAsk",
  networkTools: ["WebFetch", "WebSearch"],
  writeTools: ["Edit", "Write", "Bash"],
  readOnlyDeniedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
};

export const codexPermissionMap: PermissionMap = {
  writeMode: "workspace-write",
  readOnlyMode: "read-only",
  networkTools: [],
  writeTools: [],
  readOnlyDeniedTools: [],
};

export const piPermissionMap: PermissionMap = {
  writeMode: "advisory",
  readOnlyMode: "advisory",
  networkTools: ["web_search", "web_fetch"],
  writeTools: [],
  readOnlyDeniedTools: ["edit", "write", "bash", "powershell"],
};

export const fakePermissionMap: PermissionMap = {
  writeMode: "advisory",
  readOnlyMode: "advisory",
  networkTools: [],
  writeTools: [],
  readOnlyDeniedTools: [],
};

const FAKE_CATALOG_MESSAGE = "This CLI does not provide a model catalog.";

async function discoverFake(): Promise<ModelDiscoveryResult> {
  return { status: "unsupported", items: [], cliVersion: null, truncated: false };
}

export const claudeProvider: CliProvider = {
  id: "claude-code",
  label: "Claude Code",
  binNames: ["claude"],
  defaultBin: "claude",
  adapter: (options: AdapterOptions = {}) => createClaudeAdapter(options),
  discovery: {
    source: "claude-sdk",
    // Lazy wrappers: provider.ts sits inside the claude/codex/probe/env import
    // cycle, so adapter and discovery bindings are only touched at call time.
    discover: (request) => discoverClaudeModels(request),
  },
  contextIdentity: {
    configDirName: ".claude",
    configFiles: ["settings.json", "settings.local.json", ".credentials.json"],
    envNames: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CONFIG_DIR",
    ],
    extraEnvPrefixes: ["CLAUDE_CODE_"],
    includeConfigDirIdentity: false,
    userPresenceFile: ".claude.json",
    homeEnvVar: "CLAUDE_CONFIG_DIR",
    homeSubdir: ".claude",
  },
  modelArg: "--model",
  permissionMap: claudePermissionMap,
  experimental: true,
};

export const codexProvider: CliProvider = {
  id: "codex",
  label: "Codex",
  binNames: ["codex"],
  defaultBin: "codex",
  adapter: (options: AdapterOptions = {}) => createCodexAdapter(options),
  discovery: {
    source: "codex-app-server",
    discover: (request) => discoverCodexModels(request),
  },
  contextIdentity: {
    configDirName: ".codex",
    configFiles: ["config.toml", "config.json", "auth.json"],
    envNames: ["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
    extraEnvPrefixes: [],
    includeConfigDirIdentity: true,
    homeEnvVar: "CODEX_HOME",
    homeSubdir: ".codex",
  },
  modelArg: "-m",
  permissionMap: codexPermissionMap,
  experimental: true,
};

export const piProvider: CliProvider = {
  id: "pi",
  label: "Pi",
  binNames: ["pi"],
  defaultBin: "pi",
  adapter: (options: AdapterOptions = {}) => createPiAdapter(options),
  discovery: {
    source: "pi-list-models",
    discover: (request) => discoverPiModels(request),
  },
  contextIdentity: {
    configDirName: ".pi",
    configFiles: ["mcp.json", "models.json", "auth.json"],
    // Pi resolves provider credentials from the process environment (see
    // pi.dev/docs/latest/providers), so API-key providers only authenticate
    // in the isolated agent dir when their variables pass the child-env
    // allowlist. Discovery and execution both build env through here.
    envNames: [
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_OFFLINE",
      "OPENCODE_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "NVIDIA_API_KEY",
      "GEMINI_API_KEY",
      "COPILOT_GITHUB_TOKEN",
      "MISTRAL_API_KEY",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "AI_GATEWAY_API_KEY",
      "ZAI_API_KEY",
      "ZAI_CODING_CN_API_KEY",
      "RADIUS_API_KEY",
      "TYPESAFE_API_KEY",
      "HF_TOKEN",
      "FIREWORKS_API_KEY",
      "TOGETHER_API_KEY",
      "BASETEN_API_KEY",
      "KIMI_API_KEY",
      "META_API_KEY",
      "MINIMAX_API_KEY",
      "MINIMAX_CN_API_KEY",
      "MOONSHOT_API_KEY",
      "QWEN_TOKEN_PLAN_API_KEY",
      "QWEN_TOKEN_PLAN_CN_API_KEY",
      "XIAOMI_API_KEY",
      "XIAOMI_TOKEN_PLAN_CN_API_KEY",
      "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
      "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      "ANT_LING_API_KEY",
    ],
    extraEnvPrefixes: [],
    includeConfigDirIdentity: true,
    homeEnvVar: "PI_CODING_AGENT_DIR",
    homeSubdir: ".pi/agent",
  },
  modelArg: "--model",
  permissionMap: piPermissionMap,
  experimental: true,
};

export const fakeProvider: CliProvider = {
  id: "fake",
  label: "Fake",
  binNames: ["node"],
  defaultBin: "node",
  adapter: (options: AdapterOptions = {}) => createFakeAdapter(options),
  discovery: { source: "none", discover: discoverFake },
  contextIdentity: {
    configDirName: ".fake",
    configFiles: [],
    envNames: [],
    extraEnvPrefixes: [],
    includeConfigDirIdentity: false,
    homeEnvVar: "",
    homeSubdir: "",
  },
  modelArg: "",
  permissionMap: fakePermissionMap,
  experimental: false,
};

/** Test-only gate: the fake provider is invisible unless explicitly enabled. */
// ponytail: single env flag; promote to a registry option if more test seams appear.
export function isFakeProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RELAY_ALLOW_FAKE;
  return value === "1" || value === "true";
}

export const opencodeProvider: CliProvider = {
  id: "opencode",
  label: "Opencode",
  binNames: ["opencode"],
  defaultBin: "opencode",
  adapter: (options: AdapterOptions = {}) => createOpencodeAdapter(options),
  discovery: {
    source: "opencode-models",
    discover: (request) => discoverOpencodeModels(request),
  },
  contextIdentity: {
    configDirName: ".opencode",
    configFiles: ["opencode.json", "auth.json"],
    envNames: ["OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    extraEnvPrefixes: ["OPENCODE_"],
    includeConfigDirIdentity: true,
    homeEnvVar: "",
    homeSubdir: ".opencode",
  },
  modelArg: "--model",
  permissionMap: codexPermissionMap,
  experimental: true,
};

export function fakeCatalogMessage(): string {
  return FAKE_CATALOG_MESSAGE;
}

const providers = new Map<CliId, CliProvider>();

registerProvider(claudeProvider);
registerProvider(codexProvider);
registerProvider(opencodeProvider);
registerProvider(piProvider);
registerProvider(fakeProvider);

export function registerProvider(provider: CliProvider): void {
  providers.set(provider.id, provider);
}

function requireVisible(id: CliId): void {
  if (id === "fake" && !isFakeProviderEnabled()) {
    throw new RelayError("E_VALIDATION", "Adapter fake is test-only (RELAY_ALLOW_FAKE=1).");
  }
}

export function hasProvider(id: CliId): boolean {
  if (id === "fake" && !isFakeProviderEnabled()) return false;
  return providers.has(id);
}

export function getProvider(id: CliId): CliProvider {
  requireVisible(id);
  const provider = providers.get(id);
  if (provider === undefined) {
    throw new RelayError("E_VALIDATION", `Unknown CLI provider '${String(id)}'`);
  }
  return provider;
}

export function listProviders(): CliProvider[] {
  return [...providers.values()].filter(
    (provider) => provider.id !== "fake" || isFakeProviderEnabled(),
  );
}

export function providerIds(): CliId[] {
  return listProviders().map((provider) => provider.id);
}

/** Production registry ids (no live probes; static registry only). */
export function prodProviderIds(): ProdCliId[] {
  return ["claude-code", "codex", "opencode", "pi"];
}
