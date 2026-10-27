export interface AgentToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolsResponse {
  tools: AgentToolDescriptor[];
}

/**
 * Wire shape of POST /internal/agent/call. The idempotency receipt travels in
 * the X-Relay-Call-Id header so this body stays exactly the spec's
 * { name, arguments } shape.
 */
export interface AgentCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTextContent {
  type: "text";
  text: string;
}

/** MCP CallToolResult-compatible gateway response. */
export interface AgentCallResult {
  content: AgentTextContent[];
  isError: boolean;
}

export interface AgentToolCallInput extends AgentCallRequest {
  /**
   * Stable transport receipt id for this forwarded invocation. A transport
   * retry of the same invocation reuses it; a distinct model call does not.
   */
  callId: string;
  timeoutMs?: number;
}

export interface AgentGatewayClient {
  readonly gatewayUrl: URL;
  listTools(signal?: AbortSignal): Promise<AgentToolDescriptor[]>;
  callTool(input: AgentToolCallInput, signal?: AbortSignal): Promise<AgentCallResult>;
}

export type GatewayErrorCode =
  | "E_CONFIG"
  | "E_AUTH"
  | "E_FORBIDDEN"
  | "E_RATE_LIMITED"
  | "E_GATEWAY_UNAVAILABLE"
  | "E_TIMEOUT"
  | "E_ABORTED"
  | "E_BAD_GATEWAY"
  | "E_RESPONSE_TOO_LARGE"
  | "E_REQUEST_TOO_LARGE"
  | "E_HTTP_ERROR";

export class GatewayClientError extends Error {
  readonly code: GatewayErrorCode;
  readonly status?: number;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayClientError";
    this.code = code;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface LoopbackAddress {
  address: string;
  family: number;
}

export interface GatewayClientOptions {
  /** Base gateway URL, for example http://127.0.0.1:4310. */
  gatewayUrl: string;
  /** Exec bearer token. Only ever sent in the Authorization header. */
  token: string;
  /** Declared toolset; the gateway remains authoritative from the token scope. */
  toolset: "agent" | "supervisor";
  fetchImpl?: typeof fetch;
  lookupAll?: (hostname: string) => Promise<LoopbackAddress[]>;
  defaultTimeoutMs?: number;
  submitTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Extra attempts for transient transport failures (network, 502/503/504). */
  retries?: number;
}
