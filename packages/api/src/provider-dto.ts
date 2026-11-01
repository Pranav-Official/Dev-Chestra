import { type CatalogCli, catalogCliSchema } from "./model-catalog.js";
import { epochMsSchema } from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const PROVIDER_STATE_VALUES = ["ready", "notInstalled", "error", "unknown"] as const;

export type ProviderState = (typeof PROVIDER_STATE_VALUES)[number];

export const providerStateSchema = z.enum(PROVIDER_STATE_VALUES);

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Result of a version probe for one provider CLI. Never carries secrets. */
export interface ProviderStatusItem {
  id: CatalogCli;
  state: ProviderState;
  version: string | null;
  detail?: string;
  /** Epoch ms the probe finished; cached statuses keep their original time. */
  checkedAt: number;
}

export const providerStatusItemSchema = strict({
  id: catalogCliSchema,
  state: providerStateSchema,
  version: z.string().max(128).nullable(),
  detail: z
    .string()
    .max(256)
    .refine((value) => !hasControlChars(value), "must not contain control characters")
    .optional(),
  checkedAt: epochMsSchema,
}) as unknown as z.ZodType<ProviderStatusItem>;

export interface CliStatusResponse {
  statuses: ProviderStatusItem[];
}

export const cliStatusResponseSchema = strict({
  statuses: z.array(providerStatusItemSchema).max(32),
}) as unknown as z.ZodType<CliStatusResponse>;

export interface UpdateCliRequest {
  enabled: boolean;
}

export const updateCliRequestSchema = strict({
  enabled: z.boolean(),
}) as unknown as z.ZodType<UpdateCliRequest>;
