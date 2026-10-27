const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[abp]-[A-Za-z0-9-]{8,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export interface SecretFinding {
  source: "pattern" | "registered";
  label: string;
  path: string;
}

/**
 * In-memory only. Registered values (e.g. an exec token) are never persisted;
 * they are used to reject or redact values before any disk write.
 */
export class SecretRegistry {
  readonly #registered = new Map<string, string>();

  constructor(initial: readonly string[] = []) {
    for (const value of initial) this.register(value);
  }

  register(value: string, name = "secret"): () => void {
    if (value.length < 8) {
      throw new Error("Registered secrets must be at least 8 characters");
    }
    this.#registered.set(value, name);
    return () => {
      this.#registered.delete(value);
    };
  }

  unregister(value: string): void {
    this.#registered.delete(value);
  }

  scanString(text: string, path = "$"): SecretFinding | null {
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return { source: "pattern", label: pattern.source, path };
    }
    for (const [secret, name] of this.#registered) {
      if (text.includes(secret)) return { source: "registered", label: name, path };
    }
    return null;
  }

  scanValue(value: unknown, path = "$", depth = 0): SecretFinding | null {
    if (depth > 32) return null;
    if (typeof value === "string") return this.scanString(value, path);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = this.scanValue(value[index], `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const keyFinding = this.scanString(key, `${path}.<key>`);
        if (keyFinding) return keyFinding;
        const found = this.scanValue(child, `${path}.${key}`, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  redactString(text: string): string {
    let out = text;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
    for (const [secret, name] of [...this.#registered].sort(
      (left, right) => right[0].length - left[0].length,
    )) {
      out = out.split(secret).join(`[redacted:${name}]`);
    }
    return out;
  }

  redactValue<T>(value: T, depth = 0): T {
    if (depth > 32) return value;
    if (typeof value === "string") return this.redactString(value) as T;
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1)) as T;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[this.redactString(key)] = this.redactValue(child, depth + 1);
      }
      return out as T;
    }
    return value;
  }
}

const defaultRegistry = new SecretRegistry();

/** Pattern-only default redaction for callers that do not own a registry. */
export function redactJson<T>(value: T): T {
  return defaultRegistry.redactValue(value);
}
