import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createAgentGatewayClient, redactToken } from "./gateway-client.js";
import { deriveCallId } from "./receipt.js";
import { type AgentCallResult, type AgentToolDescriptor, GatewayClientError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const SERVER_VERSION = "0.1.0";

/**
 * SDK request schema for tools/call with transparent argument passthrough.
 *
 * CallToolRequestSchema validates `arguments` as a Zod record, which rebuilds
 * the object and drops an own "__proto__" key (and any other data Zod's record
 * handling does not copy verbatim). Keep every other SDK params field (name,
 * _meta, task) validated by the SDK, but remove `arguments` from the record and
 * let it pass through as an unknown value, so the exact object received over
 * JSON-RPC reaches the gateway unchanged. The raw object shape is still
 * enforced here: arguments, when present, must be a non-null, non-array JSON
 * object. The outer schema keeps CallToolRequestSchema's literal method.
 */
const ToolCallParamsSchema = CallToolRequestSchema.shape.params
  .omit({ arguments: true })
  .passthrough()
  .superRefine((params, ctx) => {
    const toolArguments = params.arguments;
    if (
      toolArguments !== undefined &&
      (toolArguments === null || typeof toolArguments !== "object" || Array.isArray(toolArguments))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "tools/call params.arguments must be a JSON object.",
        path: ["arguments"],
      });
    }
  });

const ToolCallRequestSchema = CallToolRequestSchema.extend({ params: ToolCallParamsSchema });

export interface ShimOptions {
  gatewayUrl: string;
  execToken: string;
  toolset: "agent" | "supervisor";
  defaultTimeoutMs?: number | undefined;
  submitTimeoutMs?: number | undefined;
  maxRequestBytes?: number | undefined;
  maxResponseBytes?: number | undefined;
  retries?: number | undefined;
  /** Test/documentation seam only; a new random id is the production default. */
  shimInstanceId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  logger?: ((line: string) => void) | undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read the documented shim environment. Errors never include the token. */
export function readShimConfig(env: NodeJS.ProcessEnv = process.env): ShimOptions {
  const execToken = env.RELAY_EXEC_TOKEN;
  if (execToken === undefined || execToken === "") {
    throw new Error("RELAY_EXEC_TOKEN is required.");
  }
  const gatewayUrl = env.RELAY_GATEWAY_URL;
  if (gatewayUrl === undefined || gatewayUrl === "") {
    throw new Error("RELAY_GATEWAY_URL is required.");
  }
  const toolset = env.RELAY_TOOLSET;
  if (toolset !== "agent" && toolset !== "supervisor") {
    throw new Error('RELAY_TOOLSET must be "agent" or "supervisor".');
  }

  const debug = env.RELAY_MCP_DEBUG === "1";
  const options: ShimOptions = { gatewayUrl, execToken, toolset };
  options.defaultTimeoutMs = parsePositiveInt(env.RELAY_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  options.submitTimeoutMs = parsePositiveInt(env.RELAY_SUBMIT_TIMEOUT_MS, SUBMIT_TIMEOUT_MS);
  options.maxRequestBytes = parsePositiveInt(
    env.RELAY_MAX_REQUEST_BYTES,
    DEFAULT_MAX_REQUEST_BYTES,
  );
  options.maxResponseBytes = parsePositiveInt(
    env.RELAY_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  options.retries = parseNonNegativeInt(env.RELAY_GATEWAY_RETRIES, 1);
  if (debug) {
    options.logger = (line: string): void => {
      process.stderr.write(`relay-mcp-shim ${line}\n`);
    };
  }
  return options;
}

function mapGatewayError(error: unknown, execToken: string): string {
  if (error instanceof GatewayClientError) {
    switch (error.code) {
      case "E_GATEWAY_UNAVAILABLE":
        return "Relay is not reachable. Stop and report this.";
      case "E_TIMEOUT":
        return "Relay gateway request timed out. Stop and report this.";
      case "E_ABORTED":
        return "Relay gateway request was cancelled.";
      case "E_CONFIG":
        return "Relay MCP transport is misconfigured. Stop and report this.";
      default:
        return redactToken(`Relay gateway error (${error.code}): ${error.message}`, execToken);
    }
  }
  const message = error instanceof Error ? error.message : "unknown transport error";
  return redactToken(`Relay MCP transport error: ${message}`, execToken);
}

/**
 * Build the low-level MCP server. It forwards tools/list and tools/call to the
 * loopback gateway; it holds no validation, persistence or success authority.
 */
export async function createShimServer(options: ShimOptions): Promise<Server> {
  const client = await createAgentGatewayClient({
    gatewayUrl: options.gatewayUrl,
    token: options.execToken,
    toolset: options.toolset,
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.submitTimeoutMs === undefined ? {} : { submitTimeoutMs: options.submitTimeoutMs }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const instanceId = options.shimInstanceId ?? randomBytes(16).toString("base64url");
  const logger = options.logger ?? ((): void => undefined);
  let toolsCache: AgentToolDescriptor[] | undefined;

  const server = new Server(
    { name: "relay-mcp-shim", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try {
      const tools = toolsCache ?? (await client.listTools(extra.signal));
      toolsCache = tools;
      logger(`tools/list count=${tools.length}`);
      return { tools };
    } catch (error) {
      const message = mapGatewayError(error, options.execToken);
      logger(`tools/list failed: ${message}`);
      throw new Error(message);
    }
  });

  server.setRequestHandler(
    ToolCallRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const callId = deriveCallId(instanceId, extra.requestId);
      const started = Date.now();
      const params = request.params as {
        name: string;
        arguments?: Record<string, unknown> | undefined;
      };
      const result: AgentCallResult = await (async (): Promise<AgentCallResult> => {
        try {
          return await client.callTool(
            {
              name: params.name,
              arguments: params.arguments ?? {},
              callId,
            },
            extra.signal,
          );
        } catch (error) {
          logger(
            `call name=${params.name} callId=${callId} error=${error instanceof GatewayClientError ? error.code : "unknown"} ms=${Date.now() - started}`,
          );
          return {
            content: [{ type: "text", text: mapGatewayError(error, options.execToken) }],
            isError: true,
          };
        }
      })();

      logger(
        `call name=${params.name} callId=${callId} isError=${String(result.isError)} ms=${Date.now() - started}`,
      );
      return { content: result.content, isError: result.isError };
    },
  );

  return server;
}

/**
 * Connect the shim to MCP over stdio. stdout is reserved for protocol frames;
 * all diagnostics go to stderr (only when RELAY_MCP_DEBUG=1).
 */
export async function runShim(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readShimConfig(env);
  const server = await createShimServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
}
