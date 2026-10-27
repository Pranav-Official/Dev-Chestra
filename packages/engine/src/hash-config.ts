function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "ui") continue;
    out[key] = strip(item);
  }
  return out;
}

/** Removes editor-only `ui` keys before hashing. The snapshot is already normalized. */
export function stripUi<T extends Record<string, unknown>>(value: T): T {
  return strip(value) as T;
}
