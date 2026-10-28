import { PROD_CLIS } from "@relay/schema";
import { projectIdSchema } from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const CATALOG_CLI_VALUES = [...PROD_CLIS] as unknown as [
  "claude-code",
  "codex",
  "opencode",
  "pi",
];

export type CatalogCli = (typeof CATALOG_CLI_VALUES)[number];

export const catalogCliSchema = z.enum(CATALOG_CLI_VALUES);

export const MODEL_CATALOG_STATUS_VALUES = [
  "ready",
  "stale",
  "unsupported",
  "unavailable",
  "authRequired",
] as const;

export type ModelCatalogStatus = (typeof MODEL_CATALOG_STATUS_VALUES)[number];

export const modelCatalogStatusSchema = z.enum(MODEL_CATALOG_STATUS_VALUES);

export const MODEL_CATALOG_SOURCE_VALUES = [
  "codex-app-server",
  "claude-sdk",
  "opencode-models",
  "pi-list-models",
  "none",
] as const;

export type ModelCatalogSource = (typeof MODEL_CATALOG_SOURCE_VALUES)[number];

export const modelCatalogSourceSchema = z.enum(MODEL_CATALOG_SOURCE_VALUES);

export const CLI_MODEL_ITEM_SOURCE_VALUES = [
  "codex-app-server",
  "claude-sdk",
  "opencode-models",
  "pi-list-models",
] as const;

export type CliModelItemSource = (typeof CLI_MODEL_ITEM_SOURCE_VALUES)[number];

export const cliModelItemSourceSchema = z.enum(CLI_MODEL_ITEM_SOURCE_VALUES);

const CONTROL_CHARS_MAX = 0x1f;
const DELETE = 0x7f;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= CONTROL_CHARS_MAX || code === DELETE) return true;
  }
  return false;
}

function boundedIdentifier(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControlChars(value), "must not contain control characters");
}

export interface CliModelItem {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  source: CliModelItemSource;
}

export const cliModelItemSchema = strict({
  id: boundedIdentifier(256),
  label: z.string().min(1).max(256),
  provider: z.string().max(128).optional(),
  description: z.string().max(1024).optional(),
  aliases: z.array(boundedIdentifier(256)).max(32).optional(),
  isDefault: z.boolean().optional(),
  source: cliModelItemSourceSchema,
}) as unknown as z.ZodType<CliModelItem>;

export interface CliModelCatalog {
  cli: CatalogCli;
  projectId: string;
  status: ModelCatalogStatus;
  scope: "relay-runtime";
  source: ModelCatalogSource;
  cliVersion: string | null;
  items: CliModelItem[];
  fetchedAt: number | null;
  expiresAt: number | null;
  truncated: boolean;
  customSupported: true;
  message?: string;
}

export const cliModelCatalogSchema = strict({
  cli: catalogCliSchema,
  projectId: projectIdSchema,
  status: modelCatalogStatusSchema,
  scope: z.literal("relay-runtime"),
  source: modelCatalogSourceSchema,
  cliVersion: z.string().max(128).nullable(),
  items: z.array(cliModelItemSchema).max(1000),
  fetchedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  customSupported: z.literal(true),
  message: z
    .string()
    .max(256)
    .refine((value) => !hasControlChars(value), "must not contain control characters")
    .optional(),
}) as unknown as z.ZodType<CliModelCatalog>;
