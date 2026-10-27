import { createHash } from "node:crypto";

export type JsonRpcRequestId = string | number;

/**
 * Derive the transport receipt id for one MCP tool-call request.
 *
 * - The numeric JSON-RPC id 1 and the string id "1" hash differently.
 * - The same request id in the same shim process hashes identically, so an
 *   HTTP transport retry reuses the receipt id.
 * - A new shim process gets a new random instance id, so ids are never claimed
 *   to be stable across restart. The gateway must bind receipts to the
 *   server-authorized execution scope/generation and keep them idempotent
 *   within that boundary.
 */
export function deriveCallId(shimInstanceId: string, requestId: JsonRpcRequestId): string {
  const taggedId = typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`;
  const digest = createHash("sha256")
    .update(shimInstanceId)
    .update("\u0000")
    .update(taggedId)
    .digest("base64url");
  return `shim_${digest.slice(0, 32)}`;
}
