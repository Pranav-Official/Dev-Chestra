import { createHash } from "node:crypto";
import { canonicalJson } from "@relay/core";

/** Store-local synchronous hash: canonical JSON from core + node:crypto SHA-256. */
export function hashJsonSync(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
