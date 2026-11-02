import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** `whk_` plus 16 random bytes in base64url. Hook IDs are routing keys, not credentials. */
export const HOOK_ID_PATTERN = /^whk_[A-Za-z0-9_-]{22}$/u;
export const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/u;

/** `whk_` plus 16 random bytes in base64url. */
export function newHookId(): string {
  return `whk_${randomBytes(16).toString("base64url")}`;
}

/**
 * The sender's secret: 20 random bytes as 40 hex characters, the form GitHub's
 * documentation suggests (`SecureRandom.hex(20)`). Stored as-is, because HMAC needs
 * the key itself to verify a delivery.
 */
export function newSigningSecret(): string {
  return randomBytes(20).toString("hex");
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hmacSha256Hex(secret: string, bytes: Uint8Array): string {
  return createHmac("sha256", secret).update(bytes).digest("hex");
}

/**
 * Constant-time equality for two lowercase sha256 hex digests. Anything that is
 * not exactly 64 lowercase hex characters compares unequal.
 */
export function digestEquals(provided: string, expected: string): boolean {
  if (!HEX_DIGEST.test(provided) || !HEX_DIGEST.test(expected)) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

/** Parses `sha256=<64 hex>` into lowercase hex, or null for any other shape. */
export function signatureFromHeader(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = SIGNATURE_HEADER.exec(value.trim());
  return match === null ? null : (match[1] ?? "").toLowerCase();
}

export function isDeliveryId(value: string): boolean {
  return DELIVERY_ID_PATTERN.test(value);
}
