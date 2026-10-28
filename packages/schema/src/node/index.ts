import { Worker } from "node:worker_threads";
import { DevChestraError } from "@devchestra/core";
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

/** Cold start (spawn + importing jsonata) must not count against the evaluation budget. */
const WORKER_START_TIMEOUT_MS = 10_000;

function isReady(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { ready?: unknown }).ready === true
  );
}

/**
 * Node-only JSONata executor. Every evaluation gets a fresh worker; the worker
 * is terminated on timeout/error, so a synchronous runaway loop cannot keep
 * running after the deadline. JSONata's own evaluation timeout/stack limit are
 * also set as a second layer.
 */
export interface NodeExpressionExecutorOptions {
  /** Test seam: override the worker module (it must still post `{ ready: true }`). */
  workerUrl?: URL;
}

export function createNodeExpressionExecutor(
  options: NodeExpressionExecutorOptions = {},
): ExpressionExecutor {
  const workerUrl = options.workerUrl ?? new URL("./worker.js", import.meta.url);
  return {
    startupGraceMs: WORKER_START_TIMEOUT_MS,
    evaluate(source, scope, options) {
      return new Promise<unknown>((resolve, reject) => {
        const timeoutMs =
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? Math.trunc(options.timeoutMs)
            : 250;

        let worker: Worker;
        try {
          worker = new Worker(workerUrl, {
            resourceLimits: {
              maxOldGenerationSizeMb: 64,
              maxYoungGenerationSizeMb: 16,
              stackSizeMb: 4,
            },
          });
        } catch (error) {
          reject(
            new DevChestraError("E_EXPR", "Could not start the expression worker", {
              cause: error,
            }),
          );
          return;
        }

        let settled = false;
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        let evalTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(startTimer);
          clearTimeout(evalTimer);
          void worker.terminate().catch(() => undefined);
          fn();
        };
        startTimer = setTimeout(() => {
          finish(() =>
            reject(
              new DevChestraError(
                "E_EXPR",
                `Expression worker did not start within ${WORKER_START_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, WORKER_START_TIMEOUT_MS);

        worker.on("message", (raw: unknown) => {
          if (isReady(raw)) {
            // The worker is booted: only now does the evaluation budget start.
            clearTimeout(startTimer);
            evalTimer = setTimeout(() => {
              finish(() =>
                reject(new DevChestraError("E_EXPR", `Expression timed out after ${timeoutMs}ms`)),
              );
            }, timeoutMs);
            try {
              worker.postMessage({ source, scope, timeoutMs });
            } catch (error) {
              finish(() =>
                reject(
                  new DevChestraError("E_EXPR", "Could not send the expression to its worker", {
                    cause: error,
                  }),
                ),
              );
            }
            return;
          }
          if (!isReply(raw) || raw.ok !== true) {
            const message =
              isReply(raw) && typeof raw.error === "string"
                ? raw.error
                : "Expression worker returned an invalid result";
            finish(() => reject(new DevChestraError("E_EXPR", message)));
            return;
          }
          finish(() => resolve(raw.value));
        });
        worker.once("error", (error) => {
          finish(() =>
            reject(
              new DevChestraError("E_EXPR", `Expression worker failed: ${error.message}`, {
                cause: error,
              }),
            ),
          );
        });
        worker.once("exit", (code) => {
          if (!settled && code !== 0) {
            finish(() =>
              reject(new DevChestraError("E_EXPR", `Expression worker exited with code ${code}`)),
            );
          }
        });
      });
    },
  };
}
