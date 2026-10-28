import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isRecord } from "@devchestra/core";
import {
  type AgentCallResult,
  type AgentGatewayClient,
  type AgentToolCallInput,
  type AgentToolDescriptor,
  GatewayClientError,
  type GatewayClientOptions,
  type LoopbackAddress,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_RETRIES = 1;

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackAddress(address: string): boolean {
  const bare = stripBrackets(address);
  if (bare === "::1") {
    return true;
  }
  if (isIP(bare) === 4) {
    return bare.startsWith("127.");
  }
  return false;
}

async function defaultLookupAll(hostname: string): Promise<LoopbackAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

function replaceHostWithLiteral(url: URL, address: string): URL {
  const copy = new URL(url.toString());
  const literal = address.includes(":") ? `[${address}]` : address;
  copy.host = url.port === "" ? literal : `${literal}:${url.port}`;
  return copy;
}

/**
 * Resolve a gateway base URL and prove it targets loopback only.
 *
 * Literal loopback addresses are preferred. "localhost" is accepted only when
 * every resolved address is loopback, and the URL is rewritten to the resolved
 * literal so no later request performs a fresh DNS lookup (DNS rebinding).
 */
export async function resolveLoopbackGatewayUrl(
  raw: string,
  lookupAll: (hostname: string) => Promise<LoopbackAddress[]> = defaultLookupAll,
): Promise<URL> {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GatewayClientError("E_CONFIG", "DEVCHESTRA_GATEWAY_URL is required.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL must be a valid absolute URL.",
    );
  }

  if (url.protocol !== "http:") {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL must use plain http on loopback.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL must not contain credentials.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL must not contain a query or fragment.",
    );
  }

  const hostname = stripBrackets(url.hostname);
  if (isLoopbackAddress(hostname)) {
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url;
  }

  if (hostname !== "localhost") {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL must use a loopback literal (127.0.0.1 or [::1]); other hostnames are rejected.",
    );
  }

  let addresses: LoopbackAddress[];
  try {
    addresses = await lookupAll(hostname);
  } catch {
    throw new GatewayClientError("E_CONFIG", "DEVCHESTRA_GATEWAY_URL host could not be resolved.");
  }
  if (addresses.length === 0 || !addresses.every((entry) => isLoopbackAddress(entry.address))) {
    throw new GatewayClientError(
      "E_CONFIG",
      "DEVCHESTRA_GATEWAY_URL host must resolve only to loopback addresses.",
    );
  }

  const first = addresses[0];
  if (first === undefined) {
    throw new GatewayClientError("E_CONFIG", "DEVCHESTRA_GATEWAY_URL host could not be resolved.");
  }
  const rewritten = replaceHostWithLiteral(url, first.address);
  if (!rewritten.pathname.endsWith("/")) {
    rewritten.pathname += "/";
  }
  return rewritten;
}

/** Remove the exec token from any string that could reach a log or tool error. */
export function redactToken(text: string, token: string): string {
  if (token === "") {
    return text;
  }
  return text.split(token).join("[REDACTED]");
}

function safeCauseSuffix(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? "" : ` (${code})`;
  }
  return "";
}

function errorCodeForStatus(status: number): GatewayClientError["code"] {
  if (status === 401) {
    return "E_AUTH";
  }
  if (status === 403) {
    return "E_FORBIDDEN";
  }
  if (status === 429) {
    return "E_RATE_LIMITED";
  }
  return "E_HTTP_ERROR";
}

function formatErrorBody(rawBody: string, token: string): string {
  const body = redactToken(rawBody, token).trim();
  if (body === "") {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "string") {
      return redactToken(parsed, token);
    }
    if (isRecord(parsed)) {
      const nested = parsed.error;
      if (typeof nested === "string") {
        return redactToken(nested, token);
      }
      if (isRecord(nested)) {
        const code = typeof nested.code === "string" ? nested.code : undefined;
        const message = typeof nested.message === "string" ? nested.message : undefined;
        if (code !== undefined && message !== undefined) {
          return redactToken(`${code}: ${message}`, token);
        }
        if (message !== undefined) {
          return redactToken(message, token);
        }
      }
      const code = typeof parsed.code === "string" ? parsed.code : undefined;
      const message = typeof parsed.message === "string" ? parsed.message : undefined;
      if (code !== undefined && message !== undefined) {
        return redactToken(`${code}: ${message}`, token);
      }
      if (message !== undefined) {
        return redactToken(message, token);
      }
    }
  } catch {
    // Not JSON; keep the original error text intact.
  }
  return body;
}

function parseCallResult(rawBody: string, token: string): AgentCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      content: [
        { type: "text", text: "DevChestra gateway returned an invalid tool result (not JSON)." },
      ],
      isError: true,
    };
  }

  if (!isRecord(parsed) || typeof parsed.isError !== "boolean" || !Array.isArray(parsed.content)) {
    return {
      content: [{ type: "text", text: "DevChestra gateway returned an invalid tool result." }],
      isError: true,
    };
  }

  const content: AgentCallResult["content"] = [];
  for (const item of parsed.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      return {
        content: [{ type: "text", text: "DevChestra gateway returned an invalid tool result." }],
        isError: true,
      };
    }
    content.push({ type: "text", text: redactToken(item.text, token) });
  }

  return { content, isError: parsed.isError };
}

function parseTools(rawBody: string, token: string): AgentToolDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new GatewayClientError(
      "E_BAD_GATEWAY",
      "DevChestra gateway returned an invalid tools response.",
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new GatewayClientError(
      "E_BAD_GATEWAY",
      "DevChestra gateway returned an invalid tools response.",
    );
  }

  const tools: AgentToolDescriptor[] = [];
  for (const item of parsed.tools) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name === "" ||
      !isRecord(item.inputSchema)
    ) {
      throw new GatewayClientError(
        "E_BAD_GATEWAY",
        "DevChestra gateway returned an invalid tool descriptor.",
      );
    }
    const tool: AgentToolDescriptor = {
      name: item.name,
      inputSchema: item.inputSchema,
    };
    if (typeof item.description === "string") {
      tool.description = redactToken(item.description, token);
    }
    tools.push(tool);
  }
  return tools;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new GatewayClientError(
      "E_RESPONSE_TOO_LARGE",
      "DevChestra gateway response exceeded the size limit.",
    );
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayClientError(
          "E_RESPONSE_TOO_LARGE",
          "DevChestra gateway response exceeded the size limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

interface HttpResult {
  status: number;
  body: string;
}

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  body?: string;
  callId?: string;
  timeoutMs: number;
}

function abortableSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function createAgentGatewayClient(
  options: GatewayClientOptions,
): Promise<AgentGatewayClient> {
  if (options.token === "") {
    throw new GatewayClientError("E_CONFIG", "DEVCHESTRA_EXEC_TOKEN is required.");
  }
  if (options.toolset !== "agent" && options.toolset !== "supervisor") {
    throw new GatewayClientError("E_CONFIG", 'DEVCHESTRA_TOOLSET must be "agent" or "supervisor".');
  }

  const baseUrl = await resolveLoopbackGatewayUrl(
    options.gatewayUrl,
    options.lookupAll ?? defaultLookupAll,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const submitTimeoutMs = options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const token = options.token;

  async function perform(
    spec: RequestSpec,
    externalSignal: AbortSignal | undefined,
  ): Promise<HttpResult> {
    const url = new URL(spec.path, baseUrl);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new GatewayClientError("E_ABORTED", "DevChestra gateway request was cancelled.");
      }
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    const headers = new Headers({
      authorization: `Bearer ${token}`,
      accept: "application/json",
    });
    if (spec.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (spec.callId !== undefined) {
      headers.set("x-devchestra-call-id", spec.callId);
    }

    const init: RequestInit = {
      method: spec.method,
      headers,
      redirect: "error",
      signal: controller.signal,
    };
    if (spec.body !== undefined) {
      init.body = spec.body;
    }

    try {
      const response = await fetchImpl(url, init);
      const body = await readLimitedBody(response, maxResponseBytes);
      return { status: response.status, body };
    } catch (error) {
      if (timedOut) {
        throw new GatewayClientError("E_TIMEOUT", "DevChestra gateway request timed out.", {
          cause: error,
        });
      }
      if (externalSignal?.aborted === true) {
        throw new GatewayClientError("E_ABORTED", "DevChestra gateway request was cancelled.", {
          cause: error,
        });
      }
      if (error instanceof GatewayClientError) {
        throw error;
      }
      throw new GatewayClientError(
        "E_GATEWAY_UNAVAILABLE",
        `DevChestra is not reachable${safeCauseSuffix(error)}.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  async function request(
    spec: RequestSpec,
    externalSignal: AbortSignal | undefined,
  ): Promise<HttpResult> {
    const maxAttempts = retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await perform(spec, externalSignal);
        if (
          (result.status === 502 || result.status === 503 || result.status === 504) &&
          attempt < maxAttempts
        ) {
          if (externalSignal?.aborted === true) {
            throw new GatewayClientError("E_ABORTED", "DevChestra gateway request was cancelled.");
          }
          await abortableSleep(25 * attempt);
          continue;
        }
        return result;
      } catch (error) {
        if (
          error instanceof GatewayClientError &&
          error.code === "E_GATEWAY_UNAVAILABLE" &&
          attempt < maxAttempts
        ) {
          if (externalSignal?.aborted === true) {
            throw new GatewayClientError("E_ABORTED", "DevChestra gateway request was cancelled.");
          }
          await abortableSleep(25 * attempt);
          continue;
        }
        throw error;
      }
    }
    throw new GatewayClientError("E_GATEWAY_UNAVAILABLE", "DevChestra is not reachable.");
  }

  return {
    gatewayUrl: baseUrl,

    async listTools(signal?: AbortSignal): Promise<AgentToolDescriptor[]> {
      const result = await request(
        { method: "GET", path: "internal/agent/tools", timeoutMs: defaultTimeoutMs },
        signal,
      );
      if (result.status < 200 || result.status >= 300) {
        const detail = formatErrorBody(result.body, token);
        throw new GatewayClientError(
          errorCodeForStatus(result.status),
          detail === "" ? `DevChestra gateway returned HTTP ${result.status}.` : detail,
          { status: result.status },
        );
      }
      return parseTools(result.body, token);
    },

    async callTool(input: AgentToolCallInput, signal?: AbortSignal): Promise<AgentCallResult> {
      if (typeof input.name !== "string" || input.name === "") {
        throw new GatewayClientError("E_CONFIG", "Tool name is required.");
      }
      if (!isRecord(input.arguments)) {
        throw new GatewayClientError("E_CONFIG", "Tool arguments must be an object.");
      }
      if (typeof input.callId !== "string" || input.callId === "") {
        throw new GatewayClientError("E_CONFIG", "A transport call id is required.");
      }

      const body = JSON.stringify({ name: input.name, arguments: input.arguments });
      if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
        return {
          content: [{ type: "text", text: "DevChestra gateway request exceeded the size limit." }],
          isError: true,
        };
      }

      const timeoutMs =
        input.timeoutMs ?? (input.name === "submit_result" ? submitTimeoutMs : defaultTimeoutMs);
      const result = await request(
        {
          method: "POST",
          path: "internal/agent/call",
          body,
          callId: input.callId,
          timeoutMs,
        },
        signal,
      );

      if (result.status < 200 || result.status >= 300) {
        const detail = formatErrorBody(result.body, token);
        return {
          content: [
            {
              type: "text",
              text: detail === "" ? `DevChestra gateway returned HTTP ${result.status}.` : detail,
            },
          ],
          isError: true,
        };
      }

      return parseCallResult(result.body, token);
    },
  };
}
