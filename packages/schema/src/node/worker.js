/**
 * Plain ESM JavaScript on purpose: this file runs both from src (Vitest) and from
 * the copy in dist. tsc does not typecheck it because checkJs is disabled; the
 * public executor in index.ts is typechecked.
 */
import { parentPort } from "node:worker_threads";
import jsonata from "jsonata";

const MAX_RESULT_BYTES = 64 * 1024;

if (parentPort === null) {
  throw new Error("Expression worker must be started with a parent port");
}

function sanitize(value, seen = new Set()) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Expression result contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`Expression result contains an unsupported ${typeof value}`);
  }
  if (typeof value !== "object") throw new Error("Expression result is not JSON data");
  if (seen.has(value)) throw new Error("Expression result contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("Expression result must be plain JSON data");
  }
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: sanitize(item, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function capResult(value) {
  const clean = sanitize(value);
  const text = JSON.stringify(clean);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(`Expression result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return JSON.parse(text);
}

// A null operand to a relational comparison (<, <=, >, >=) makes JSONata
// throw T2010. Relay semantics: unknown (null) values compare false instead
// of failing the expression, so `d.confidence >= 0.8` is false when the
// provider refused and confidence is null. Every other type error (string
// vs number, boolean operands, ...) still throws, keeping gates fail-closed.
function nullsToUndefined(value, seen = new Set()) {
  if (value === null) return undefined;
  if (typeof value !== "object" || value === undefined) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => nullsToUndefined(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = nullsToUndefined(item, seen);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

async function runOnce(source, scope, timeoutMs) {
  const expression = jsonata(source, {
    timeout: Math.max(1, Math.trunc(timeoutMs)),
    stack: 100,
  });
  return expression.evaluate(scope);
}

function workerError(error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : undefined;
  const reply = { ok: false, error: message };
  if (code !== undefined) reply.code = code;
  if (error && typeof error === "object" && "value" in error && error.value === null) {
    reply.nullOperand = true;
  }
  return reply;
}

parentPort.once("message", async (request) => {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.source !== "string" ||
    request.scope === null ||
    typeof request.scope !== "object" ||
    !Number.isFinite(request.timeoutMs)
  ) {
    parentPort.postMessage({ ok: false, error: "Invalid expression worker request" });
    return;
  }

  try {
    const value = await runOnce(request.source, request.scope, request.timeoutMs);
    parentPort.postMessage({ ok: true, value: capResult(value) });
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    const nullOperand =
      error && typeof error === "object" && "value" in error && error.value === null;
    if (code === "T2010" && nullOperand) {
      // Retry with nulls as undefined: a null comparison yields undefined,
      // which sanitizes to null/false downstream. A concrete retry result is
      // returned as-is (boolean composition still resolves); any fresh error
      // is genuine and replaces the original.
      try {
        const retry = await runOnce(
          request.source,
          nullsToUndefined(request.scope),
          request.timeoutMs,
        );
        if (retry === undefined) {
          parentPort.postMessage({ ok: true, value: false });
        } else {
          parentPort.postMessage({ ok: true, value: capResult(retry) });
        }
      } catch (retryError) {
        parentPort.postMessage(workerError(retryError));
      }
      return;
    }
    parentPort.postMessage(workerError(error));
  }
});
