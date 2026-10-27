import { Worker } from "node:worker_threads";
import { RelayError } from "@relay/core";
import type { ExpressionExecutor } from "../expression.js";

export type { ExpressionExecutor } from "../expression.js";

interface WorkerReply {
  ok?: unknown;
  value?: unknown;
  error?: unknown;
}

function isReply(value: unknown): value is WorkerReply {
  return value !== null && typeof value === "object";
}

/**
 * Node-only JSONata executor. Every evaluation gets a fresh worker; the worker
 * is terminated on timeout/error, so a synchronous runaway loop cannot keep
 * running after the deadline. JSONata's own evaluation timeout/stack limit are
 * also set as a second layer.
 */
export function createNodeExpressionExecutor(): ExpressionExecutor {
  return {
    evaluate(source, scope, options) {
      return new Promise<unknown>((resolve, reject) => {
        const timeoutMs =
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? Math.trunc(options.timeoutMs)
            : 250;

        let worker: Worker;
        try {
          worker = new Worker(new URL("./worker.js", import.meta.url), {
            resourceLimits: {
              maxOldGenerationSizeMb: 64,
              maxYoungGenerationSizeMb: 16,
              stackSizeMb: 4,
            },
          });
        } catch (error) {
          reject(
            new RelayError("E_EXPR", "Could not start the expression worker", { cause: error }),
          );
          return;
        }

        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate().catch(() => undefined);
          fn();
        };
        const timer = setTimeout(() => {
          finish(() =>
            reject(new RelayError("E_EXPR", `Expression timed out after ${timeoutMs}ms`)),
          );
        }, timeoutMs);

        worker.once("message", (raw: unknown) => {
          if (!isReply(raw) || raw.ok !== true) {
            const message =
              isReply(raw) && typeof raw.error === "string"
                ? raw.error
                : "Expression worker returned an invalid result";
            finish(() => reject(new RelayError("E_EXPR", message)));
            return;
          }
          finish(() => resolve(raw.value));
        });
        worker.once("error", (error) => {
          finish(() =>
            reject(
              new RelayError("E_EXPR", `Expression worker failed: ${error.message}`, {
                cause: error,
              }),
            ),
          );
        });
        worker.once("exit", (code) => {
          if (!settled && code !== 0) {
            finish(() =>
              reject(new RelayError("E_EXPR", `Expression worker exited with code ${code}`)),
            );
          }
        });

        try {
          worker.postMessage({ source, scope, timeoutMs });
        } catch (error) {
          finish(() =>
            reject(
              new RelayError("E_EXPR", "Could not send the expression to its worker", {
                cause: error,
              }),
            ),
          );
        }
      });
    },
  };
}
