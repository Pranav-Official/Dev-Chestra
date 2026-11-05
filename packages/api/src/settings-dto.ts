import { MODEL_TIERS, SETTINGS_SCOPES } from "@devchestra/schema";
import { catalogCliSchema } from "./model-catalog.js";
import { etagSchema } from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const settingsScopeSchema = z.enum(SETTINGS_SCOPES);
export type SettingsScopeValue = z.infer<typeof settingsScopeSchema>;

export const modelTierIdSchema = z.enum(MODEL_TIERS);

/** A provider CLI and optionally one of its models; no model means the CLI's own default. */
export const modelRefSchema = strict({
  cli: catalogCliSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !hasControlChars(value), "model must not contain control characters")
    .optional(),
});
export type ModelRefDto = z.infer<typeof modelRefSchema>;

export const settingsDocumentSchema = strict({
  version: z.literal(1),
  models: strict({
    high: modelRefSchema.optional(),
    medium: modelRefSchema.optional(),
    low: modelRefSchema.optional(),
  }).optional(),
});
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;

/** One settings file. `exists` is false (and `document` empty) until it is first saved. */
export const settingsResponseSchema = strict({
  scope: settingsScopeSchema,
  document: settingsDocumentSchema,
  etag: etagSchema,
  exists: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/** The mapping a run on this machine would use for one tier, and which file supplied it. */
export const effectiveTierSchema = strict({
  tier: modelTierIdSchema,
  mapping: strict({ ref: modelRefSchema, source: settingsScopeSchema }).nullable(),
});
export type EffectiveTier = z.infer<typeof effectiveTierSchema>;

export const effectiveSettingsResponseSchema = strict({
  tiers: z.array(effectiveTierSchema).length(MODEL_TIERS.length),
});
export type EffectiveSettingsResponse = z.infer<typeof effectiveSettingsResponseSchema>;
