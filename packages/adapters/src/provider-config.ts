import { PROD_CLI_LABELS } from "@devchestra/schema";
import type { AdapterOptions, CliAdapter, CliId } from "./types.js";

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
  /** Reserved: every shipped adapter is official; kept so the API shape stays stable. */
  readonly experimental: boolean;
}

/** Static provider metadata. Pure data: this module imports no adapter
 * factory, discovery or env code, so adapter implementations can depend on
 * it without forming an import cycle with the provider registry. */
export interface ProviderStatic {
  readonly id: CliId;
  readonly label: string;
  readonly binNames: readonly string[];
  readonly defaultBin: string;
  readonly contextIdentity: ContextIdentityProvider;
  /** CLI flag carrying an explicit model id ("" when the CLI has none). */
  readonly modelArg: string;
  readonly permissionMap: PermissionMap;
  /** Reserved: every shipped adapter is official; kept so the API shape stays stable. */
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

export const claudeStatic: ProviderStatic = {
  id: "claude-code",
  label: PROD_CLI_LABELS["claude-code"],
  binNames: ["claude"],
  defaultBin: "claude",
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
  experimental: false,
};

export const codexStatic: ProviderStatic = {
  id: "codex",
  label: PROD_CLI_LABELS.codex,
  binNames: ["codex"],
  defaultBin: "codex",
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
  experimental: false,
};

export const piStatic: ProviderStatic = {
  id: "pi",
  label: PROD_CLI_LABELS.pi,
  binNames: ["pi"],
  defaultBin: "pi",
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
  experimental: false,
};

export const fakeStatic: ProviderStatic = {
  id: "fake",
  label: "Fake",
  binNames: ["node"],
  defaultBin: "node",
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

export const opencodeStatic: ProviderStatic = {
  id: "opencode",
  label: PROD_CLI_LABELS.opencode,
  binNames: ["opencode"],
  defaultBin: "opencode",
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
  experimental: false,
};

/** Static metadata by CLI id, for consumers (adapter plans, child-env)
 * that must not depend on the factory registry. */
export const providerStatics: Record<CliId, ProviderStatic> = {
  "claude-code": claudeStatic,
  codex: codexStatic,
  opencode: opencodeStatic,
  pi: piStatic,
  fake: fakeStatic,
};

/** Container homes are independent of host CLI configuration and databases. */
export const containerProviders = {
  "claude-code": {
    bin: "claude",
    login: ["auth", "login"],
    credentials: [".claude/.credentials.json", ".claude.json"],
    sessions: [".claude/projects"],
  },
  codex: {
    bin: "codex",
    login: ["login", "--device-auth"],
    credentials: [".codex/auth.json", ".codex/config.toml"],
    sessions: [".codex/sessions"],
  },
  pi: {
    bin: "pi",
    login: [],
    credentials: [".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/settings.json"],
    sessions: [".pi/sessions"],
  },
  opencode: {
    bin: "opencode",
    login: ["auth", "login"],
    credentials: [".local/share/opencode/auth.json", ".local/share/opencode/mcp-auth.json"],
    sessions: [".local/share/opencode"],
  },
} as const;
