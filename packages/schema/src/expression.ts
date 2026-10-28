import { canonicalJson, err, ok, RelayError, type Result } from "@relay/core";
import jsonata from "jsonata";

const MAX_SOURCE_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 2_000;

/**
 * Pure JSONata built-ins only. Variable binding, lambdas, partial application,
 * function application and the transform operator are rejected separately, so
 * this list cannot be bypassed by aliasing or dynamic invocation.
 */
const ALLOWED_FUNCTIONS = new Set([
  "abs",
  "append",
  "assert",
  "average",
  "base64decode",
  "base64encode",
  "boolean",
  "ceil",
  "clone",
  "contains",
  "count",
  "decodeUrl",
  "decodeUrlComponent",
  "distinct",
  "each",
  "encodeUrl",
  "encodeUrlComponent",
  "error",
  "exists",
  "filter",
  "floor",
  "formatBase",
  "formatInteger",
  "formatNumber",
  "join",
  "keys",
  "length",
  "lookup",
  "lowercase",
  "map",
  "match",
  "max",
  "merge",
  "min",
  "not",
  "number",
  "pad",
  "parseInteger",
  "power",
  "reduce",
  "replace",
  "reverse",
  "round",
  "sift",
  "single",
  "sort",
  "split",
  "spread",
  "sqrt",
  "string",
  "substring",
  "substringAfter",
  "substringBefore",
  "sum",
  "toMillis",
  "trim",
  "type",
  "uppercase",
  "zip",
]);

const BANNED_FUNCTIONS = new Set([
  "eval",
  "now",
  "millis",
  "fromMillis",
  "random",
  "shuffle",
  "uuid",
  "env",
]);

const DYNAMIC_NODE_TYPES = new Set(["lambda", "partial", "apply", "bind", "transform"]);

export interface CompiledExpression {
  readonly source: string;
  /** Bare scope roots referenced by the expression (built-ins and $/$$ excluded). */
  readonly roots: readonly string[];
  /** Built-in function names called by the expression. */
  readonly functions: readonly string[];
}

export interface ExpressionExecutor {
  /**
   * Execute a raw JSONata source string. Implementations MUST enforce the
   * timeout by terminating the execution context, not only by racing a promise.
   */
  evaluate(
    source: string,
    scope: Readonly<Record<string, unknown>>,
    options: { timeoutMs: number },
  ): Promise<unknown>;
  /**
   * Extra wall-clock time the executor may need to become ready (for example a
   * worker cold start) before the evaluation budget begins. `evaluate()` adds it to
   * its backstop timer. Omit for executors that start instantly.
   */
  readonly startupGraceMs?: number;
}

export interface EvaluateOptions {
  /** Default 250 ms, maximum 2000 ms. */
  timeoutMs?: number;
  /** Required in the browser-safe main entry. Use @relay/schema/node in Node. */
  executor?: ExpressionExecutor;
}

interface AstNode {
  type?: unknown;
  value?: unknown;
  procedure?: unknown;
  arguments?: unknown;
  steps?: unknown;
  stages?: unknown;
  expressions?: unknown;
  body?: unknown;
  lhs?: unknown;
  rhs?: unknown;
  expr?: unknown;
  [key: string]: unknown;
}

interface Analysis {
  roots: Set<string>;
  functions: Set<string>;
}

const cache = new Map<string, Result<CompiledExpression, RelayError>>();

function exprError(message: string, cause?: unknown): RelayError {
  return new RelayError("E_EXPR", message, cause === undefined ? undefined : { cause });
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function banned(name: string): RelayError {
  return exprError(
    `Function $${name} is not allowed: expressions must be deterministic and cannot access host capabilities.`,
  );
}

function checkVariable(node: AstNode): void {
  const name = node.value;
  if (name === "" || name === "$") return;
  if (typeof name !== "string") {
    throw exprError("Invalid variable reference in expression");
  }
  if (BANNED_FUNCTIONS.has(name)) throw banned(name);
  if (!ALLOWED_FUNCTIONS.has(name)) {
    throw exprError(
      `Variable $${name} is not available. Reference scope values as bare names (for example start.topic); variable binding and dynamic calls are not supported.`,
    );
  }
}

function visit(value: unknown, rootContext: boolean, analysis: Analysis): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, rootContext, analysis);
    return;
  }
  if (!isAstNode(value)) return;

  const type = value.type;
  if (type === "error") {
    throw exprError("Expression contains a parse error");
  }
  if (typeof type === "string" && DYNAMIC_NODE_TYPES.has(type)) {
    throw exprError(
      `JSONata '${type}' is not allowed: lambdas, variable binding and dynamic function calls are unsupported.`,
    );
  }

  if (type === "function") {
    const procedure = value.procedure;
    if (
      !isAstNode(procedure) ||
      procedure.type !== "variable" ||
      typeof procedure.value !== "string"
    ) {
      throw exprError(
        "Dynamic function invocation is not allowed. Call an allowed built-in by name (for example $string(...)).",
      );
    }
    const name = procedure.value;
    if (BANNED_FUNCTIONS.has(name)) throw banned(name);
    if (!ALLOWED_FUNCTIONS.has(name)) {
      throw exprError(
        `Function $${name} is not allowed. Only deterministic JSONata built-ins are available.`,
      );
    }
    analysis.functions.add(name);
    visit(value.arguments, rootContext, analysis);
    return;
  }

  if (type === "path") {
    const steps = value.steps;
    if (!Array.isArray(steps)) return;
    const first = steps[0];
    if (isAstNode(first)) {
      if (first.type === "name") {
        if (rootContext && typeof first.value === "string") analysis.roots.add(first.value);
      } else if (first.type === "variable") {
        checkVariable(first);
      } else {
        visit(first, rootContext, analysis);
      }
      if (first.stages !== undefined) visit(first.stages, false, analysis);
    }
    for (let i = 1; i < steps.length; i += 1) visit(steps[i], false, analysis);
    return;
  }

  if (type === "variable") {
    checkVariable(value);
    return;
  }

  if (type === "name") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "position" ||
      key === "type" ||
      key === "thunk" ||
      key === "keepArray" ||
      key === "consarray" ||
      key === "tupleStream" ||
      key === "focus"
    ) {
      continue;
    }
    if (typeof child === "object" && child !== null) visit(child, rootContext, analysis);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Parse a JSONata expression, enforce size/root/function policy, and return an
 * immutable compiled reference. Cached by source string.
 */
export function compileExpression(source: string): Result<CompiledExpression, RelayError> {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;

  let result: Result<CompiledExpression, RelayError>;
  if (source.trim() === "") {
    result = err(exprError("Expression source is empty"));
  } else if (utf8Bytes(source) > MAX_SOURCE_BYTES) {
    result = err(exprError(`Expression source exceeds ${MAX_SOURCE_BYTES} bytes`));
  } else {
    try {
      const ast: unknown = jsonata(source).ast();
      const analysis: Analysis = { roots: new Set(), functions: new Set() };
      visit(ast, true, analysis);
      const compiled: CompiledExpression = Object.freeze({
        source,
        roots: Object.freeze([...analysis.roots].sort()),
        functions: Object.freeze([...analysis.functions].sort()),
      });
      result = ok(compiled);
    } catch (error) {
      result = err(
        error instanceof RelayError
          ? error
          : exprError(
              `Invalid JSONata expression: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
      );
    }
  }

  cache.set(source, result);
  return result;
}

function timeoutOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw exprError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const item of Object.values(value)) deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

function cloneScope(scope: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    return deepFreeze(structuredClone(scope));
  } catch (error) {
    throw exprError(
      `Expression scope must be structured-cloneable JSON: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw exprError("Expression result contains a non-finite number");
      return value;
    case "bigint":
    case "function":
    case "symbol":
      throw exprError(`Expression result contains an unsupported ${typeof value}`);
    default:
      break;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw exprError("Expression result must be plain JSON data");
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Safe for an own "__proto__" key produced by JSON.parse.
      Object.defineProperty(out, key, {
        value: sanitize(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw exprError("Expression result is not JSON data");
}

/**
 * Evaluate a compiled expression in the injected executor. The browser-safe
 * main entry has no default executor: import createNodeExpressionExecutor from
 * "@relay/schema/node". Timeout termination is the executor's responsibility.
 */
export async function evaluate(
  compiled: CompiledExpression,
  scope: Readonly<Record<string, unknown>>,
  options: EvaluateOptions = {},
): Promise<Result<unknown, RelayError>> {
  try {
    const timeoutMs = timeoutOf(options.timeoutMs);
    const executor = options.executor;
    if (executor === undefined) {
      return err(
        exprError(
          'No expression executor configured. In Node, import { createNodeExpressionExecutor } from "@relay/schema/node" and pass it as options.executor. Browser worker execution is not implemented in P1.',
        ),
      );
    }
    const frozen = cloneScope(scope);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // Backstop only: the executor owns the real budget. Startup (cold start) is not part
      // of it, so executors that need time to boot declare `startupGraceMs`.
      timer = setTimeout(
        () => {
          reject(exprError(`Expression timed out after ${timeoutMs}ms`));
        },
        timeoutMs + (executor.startupGraceMs ?? 0),
      );
    });
    let value: unknown;
    try {
      value = await Promise.race([
        executor.evaluate(compiled.source, frozen, { timeoutMs }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const clean = sanitize(value);
    const serialized = canonicalJson(clean);
    if (utf8Bytes(serialized) > MAX_RESULT_BYTES) {
      return err(exprError(`Expression result exceeds ${MAX_RESULT_BYTES} bytes`));
    }
    return ok(clean);
  } catch (error) {
    return err(error instanceof RelayError ? error : exprError(String(error), error));
  }
}
