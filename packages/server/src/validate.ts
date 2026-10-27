import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { hashJson } from "./hash.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

type FormatsPlugin = (ajv: Ajv2020) => Ajv2020;

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

const MAX_ISSUES = 10;
const MAX_TEXT = 240;

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}...`;
}

function issuePath(error: ErrorObject): string {
  const base = error.instancePath === "" ? "/" : error.instancePath;
  const missing = error.params as { missingProperty?: unknown };
  if (typeof missing.missingProperty === "string") {
    return `${base === "/" ? "" : base}/${missing.missingProperty}` || "/";
  }
  return base;
}

/**
 * Bounded Ajv validation. The agent sees at most 10 short issues so a hostile
 * schema/value cannot turn a tool error into an unbounded response.
 */
export class OutputValidator {
  readonly #ajv: Ajv2020;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
      validateFormats: true,
    });
    addFormats(this.#ajv);
  }

  /** Compile eagerly so a broken schema fails at token issue, not mid-run. */
  compile(schema: Record<string, unknown>): {
    hash: string;
    validate: (value: unknown) => ValidationResult;
  } {
    const hash = hashJson(schema);
    const cached = this.#cache.get(hash);
    if (cached !== undefined) {
      return { hash, validate: (value) => this.#run(cached, value) };
    }

    let compiled: ValidateFunction;
    try {
      compiled = this.#ajv.compile(schema);
    } catch {
      throw new Error("Output schema is not a valid JSON Schema.");
    }
    this.#cache.set(hash, compiled);
    return { hash, validate: (value) => this.#run(compiled, value) };
  }

  #run(compiled: ValidateFunction, value: unknown): ValidationResult {
    if (compiled(value) === true) {
      return { ok: true };
    }
    const errors = compiled.errors ?? [];
    const issues: ValidationIssue[] = errors.slice(0, MAX_ISSUES).map((error) => ({
      path: truncate(issuePath(error)),
      message: truncate(error.message ?? "is invalid"),
    }));
    return { ok: false, issues };
  }
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  const lines = issues.map((issue) => `${issue.path}: ${issue.message}`);
  return lines.join("\n");
}
