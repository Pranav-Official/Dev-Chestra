import { RelayError } from "./error.js";

function invalid(message: string): RelayError {
  return new RelayError("E_VALIDATION", message);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw invalid(`Non-finite number: ${String(value)}`);
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
      throw invalid("undefined is not representable in canonical JSON");
    case "bigint":
    case "symbol":
    case "function":
      throw invalid(`${typeof value} is not representable in canonical JSON`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalid("Circular value in canonical JSON");
    ancestors.add(value);
    const out = value.map((item) => encode(item, ancestors));
    ancestors.delete(value);
    return `[${out.join(",")}]`;
  }

  if (typeof value === "object") {
    if (ancestors.has(value)) throw invalid("Circular value in canonical JSON");
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw invalid("Only plain objects and arrays are representable in canonical JSON");
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encode(item, ancestors)}`);
    }
    ancestors.delete(value);
    return `{${parts.join(",")}}`;
  }

  throw invalid(`Unsupported value: ${String(value)}`);
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new RelayError("E_INTERNAL", "Web Crypto SHA-256 is unavailable in this runtime");
  }
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await subtle.digest("SHA-256", bytes);
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
