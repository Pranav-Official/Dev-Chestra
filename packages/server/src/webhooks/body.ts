import type { Context } from "hono";
import { DevChestraError } from "../errors.js";

/** Largest webhook body accepted before any authentication or parsing. */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reads the raw request bytes, enforcing the same discipline as the JSON reader:
 * a declared length above the limit is refused before any read, the stream is
 * counted while it is read, and a stalled body is cancelled by a timer.
 * The bytes are returned unchanged so the signature and fingerprint cover what
 * the sender actually transmitted.
 */
export async function readRawBody(
  c: Context,
  options: { maxBytes: number; timeoutMs?: number },
): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  const body = c.req.raw.body;
  if (body === null) return new Uint8Array(0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (controller.signal.aborted) {
        throw new DevChestraError("E_VALIDATION", "Request body was not received in time.");
      }
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled.
    }
  }
  if (controller.signal.aborted) {
    throw new DevChestraError("E_VALIDATION", "Request body was not received in time.");
  }
  return Buffer.concat(chunks);
}
