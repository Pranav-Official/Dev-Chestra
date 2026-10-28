import { MCP_SCOPES } from "@relay/schema";
import { catalogCliSchema } from "./model-catalog.js";
import { projectIdSchema } from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const MCP_SERVER_STATUS_VALUES = [
  "ready",
  "needs-trust",
  "needs-auth",
  "disabled-in-cli",
  "invalid",
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUS_VALUES)[number];

export const MCP_TRANSPORT_VALUES = ["stdio", "http", "sse"] as const;

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

/** What the UI sees. Never contains env values, header values, tokens or full URLs with credentials. */
export const discoveredMcpServerSchema = strict({
  id: safeText(200),
  name: safeText(128),
  scope: z.enum(MCP_SCOPES as unknown as [string, ...string[]]),
  transport: z.enum(MCP_TRANSPORT_VALUES),
  summary: safeText(200),
  source: safeText(512),
  status: z.enum(MCP_SERVER_STATUS_VALUES),
  hasSecrets: z.boolean(),
  /** Connectors only: how many tools the connector exposes, when known. */
  toolCount: z.number().int().nonnegative().optional(),
});
export type DiscoveredMcpServer = z.infer<typeof discoveredMcpServerSchema>;

export const cliMcpServersSchema = strict({
  cli: catalogCliSchema,
  projectId: projectIdSchema,
  servers: z.array(discoveredMcpServerSchema).max(500),
  /** Config locations that were read (paths only). */
  scanned: z.array(safeText(512)).max(50),
  warnings: z.array(safeText(256)).max(50),
});
export type CliMcpServers = z.infer<typeof cliMcpServersSchema>;
