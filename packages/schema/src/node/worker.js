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
    const expression = jsonata(request.source, {
      timeout: Math.max(1, Math.trunc(request.timeoutMs)),
      stack: 100,
    });
    const value = await expression.evaluate(request.scope);
    parentPort.postMessage({ ok: true, value: capResult(value) });
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    parentPort.postMessage({ ok: false, error: message });
  }
});
