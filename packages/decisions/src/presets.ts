import type { DecisionProviderId } from "@devchestra/schema";
import type { DecisionSecretName } from "./secrets.js";

/** Fixed per-provider host preset. */
export interface DecisionPreset {
  id: DecisionProviderId;
  method: "POST";
  /** URL template. `$CLOUDFLARE_ACCOUNT_ID` is substituted from secrets. */
  url: string;
  /** Env names that must all be present for this provider. */
  requiredEnv: readonly DecisionSecretName[];
  /** `model` string sent in the request body. */
  bodyModel: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_DECISION_TIMEOUT_MS = 20_000;

/**
 * Fixed presets, typed as a Record so adding a {@link DecisionProviderId}
 * fails to compile until a preset is added here.
 */
export const DECISION_PRESETS: Record<DecisionProviderId, DecisionPreset> = {
  "typesafe-jev": {
    id: "typesafe-jev",
    method: "POST",
    url: "https://api.typesafe.ai/v1/systemone",
    requiredEnv: ["TYPESAFE_API_KEY"],
    bodyModel: "jev-latest",
    timeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
  },
  "cloudflare-clef": {
    id: "cloudflare-clef",
    method: "POST",
    url: "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef",
    requiredEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
    bodyModel: "clef",
    timeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
  },
  "cloudflare-clef-flash": {
    id: "cloudflare-clef-flash",
    method: "POST",
    url: "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef-flash",
    requiredEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
    bodyModel: "clef-flash",
    timeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
  },
};

/** Substitute `$CLOUDFLARE_ACCOUNT_ID` in the preset URL template. */
export function resolvePresetUrl(preset: DecisionPreset, accountId: string): string {
  // Function replacer: `$&`-style patterns in the value are not interpreted, and the value is
  // encoded so it can only ever be a single path segment.
  return preset.url.replace("$CLOUDFLARE_ACCOUNT_ID", () => encodeURIComponent(accountId));
}
