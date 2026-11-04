import { isRecord } from "@devchestra/core";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DevChestraError, devchestraErrorCode, errorBody, toDevChestraError } from "./errors.js";
import type { SubmissionPort, SubmitOutcome } from "./ports.js";
import {
  EXEC_GRACE_MS,
  EXEC_TOOL_NAME,
  execDescription,
  execInputSchema,
  runPolicyExec,
} from "./shell-exec.js";
import { type ExecScope, type ExecTokenRegistry, scopeKey } from "./tokens.js";
import { formatIssues, type OutputValidator } from "./validate.js";

export interface RateLimitOptions {
  capacity?: number;
  refillPerSecond?: number;
}

export interface AgentGatewayOptions {
  tokens: ExecTokenRegistry;
  submissions: SubmissionPort;
  validator: OutputValidator;
  /** Listening port, or a provider used once the loopback listener is bound. */
  port: number | (() => number);
  now?: () => number;
  rateLimit?: RateLimitOptions;
  submitTimeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  logger?: (line: string) => void;
  /** Host platform for the exec guard; defaults to process.platform. Tests inject win32. */
  execPlatform?: NodeJS.Platform;
}

type GatewayEnv = { Variables: { execScope: ExecScope; execToken: string } };

const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RATE_ENTRIES = 10_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerSecond: number;

  constructor(capacity: number, refillPerSecond: number) {
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
  }

  take(key: string, now: number): boolean {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= MAX_RATE_ENTRIES) {
        this.#buckets.clear();
      }
      bucket = { tokens: this.#capacity, updatedAt: now };
      this.#buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }
}

function allowedHosts(port: number): Set<string> | null {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function hostNameOnly(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const lastColon = host.lastIndexOf(":");
  return lastColon === -1 ? host : host.slice(0, lastColon);
}

function isLoopbackHost(host: string): boolean {
  const name = hostNameOnly(host).toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function allowedOrigins(port: number): Set<string> | null {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") {
      return false;
    }
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function containsSecret(value: unknown, secret: string): boolean {
  if (secret === "") {
    return false;
  }
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      break;
    }
    visited += 1;
    if (visited > 20_000 || next.depth > 32) {
      return true;
    }
    const current = next.value;
    if (typeof current === "string") {
      if (current.includes(secret)) {
        return true;
      }
    } else if (Array.isArray(current)) {
      for (const item of current) {
        stack.push({ value: item, depth: next.depth + 1 });
      }
    } else if (typeof current === "object" && current !== null) {
      for (const [key, item] of Object.entries(current)) {
        if (key.includes(secret)) {
          return true;
        }
        stack.push({ value: item, depth: next.depth + 1 });
      }
    }
  }
  return false;
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function callResult(
  text: string,
  isError: boolean,
): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text", text }], isError };
}

function sameScope(left: ExecScope, right: ExecScope): boolean {
  return (
    left.identity.runId === right.identity.runId &&
    left.identity.path === right.identity.path &&
    left.identity.attempt === right.identity.attempt &&
    left.identity.generation === right.identity.generation &&
    left.toolset === right.toolset
  );
}

function timeoutError(): DevChestraError {
  return new DevChestraError("E_INTERNAL", "Request timed out.");
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw timeoutError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(timeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readJsonObject(
  c: Context<GatewayEnv>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
  }

  const body = c.req.raw.body;
  if (body === null) {
    throw new DevChestraError("E_VALIDATION", "Request body must be a JSON object.");
  }

  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        throw timeoutError();
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const value = next.value;
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) {
      throw timeoutError();
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled or released.
    }
  }

  if (signal.aborted) {
    throw timeoutError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new DevChestraError("E_VALIDATION", "Request body must be valid UTF-8 JSON.");
  }
  if (!isRecord(parsed)) {
    throw new DevChestraError("E_VALIDATION", "Request body must be a JSON object.");
  }
  return parsed;
}

export function createAgentGateway(options: AgentGatewayOptions): Hono<GatewayEnv> {
  const { tokens, submissions, validator } = options;
  const now = options.now ?? Date.now;
  const submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const buckets = new TokenBuckets(
    options.rateLimit?.capacity ?? 20,
    options.rateLimit?.refillPerSecond ?? 20,
  );
  const portProvider = options.port;
  const currentPort = (): number =>
    typeof portProvider === "function" ? portProvider() : portProvider;
  const log = options.logger ?? ((): void => undefined);
  const execPlatform = options.execPlatform ?? process.platform;

  const app = new Hono<GatewayEnv>();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  // Host allowlist: defense against DNS rebinding.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || host === "") {
      return c.json(errorBody("E_FORBIDDEN", "Host is not allowed."), 421);
    }
    const allowed = allowedHosts(currentPort());
    if (allowed === null) {
      if (!isLoopbackHost(host)) {
        return c.json(errorBody("E_FORBIDDEN", "Host is not allowed."), 421);
      }
    } else if (!allowed.has(host)) {
      return c.json(errorBody("E_FORBIDDEN", "Host is not allowed."), 421);
    }
    await next();
  });

  // Origin check for state-changing agent calls.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "" && c.req.method !== "GET") {
      const allowed = allowedOrigins(currentPort());
      const ok = allowed === null ? isLoopbackOrigin(origin) : allowed.has(origin);
      if (!ok) {
        return c.json(errorBody("E_FORBIDDEN", "Origin is not allowed."), 403);
      }
    }
    await next();
  });

  app.use("/internal/agent/*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (token === null) {
      return c.json(errorBody("E_AUTH", "A bearer execution token is required."), 401);
    }
    const scope = tokens.resolve(token, now());
    if (scope === null) {
      return c.json(errorBody("E_AUTH", "The execution token is invalid or expired."), 401);
    }
    if (scope.toolset !== "agent") {
      return c.json(errorBody("E_FORBIDDEN", "Only the agent toolset is supported."), 403);
    }
    if (!buckets.take(scopeKey(scope), now())) {
      return c.json(
        errorBody("E_RATE_LIMIT", "Too many gateway requests for this execution."),
        429,
      );
    }
    c.set("execScope", scope);
    c.set("execToken", token);
    await next();
  });

  app.get("/internal/agent/tools", (c) => {
    const scope = c.get("execScope");
    const body = {
      tools: [
        {
          name: "submit_result",
          description:
            "Submit the final structured result for this node. Arguments must match the output schema. Call exactly once when the work is complete.",
          inputSchema: scope.outputSchema,
        },
        // Advertised only for tokens that carry a server-owned shell policy.
        ...(scope.shell === undefined
          ? []
          : [
              {
                name: EXEC_TOOL_NAME,
                description: execDescription(scope.shell.policy),
                inputSchema: execInputSchema(),
              },
            ]),
      ],
    };
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
      return c.json(errorBody("E_INTERNAL", "Tool schema is too large."), 500);
    }
    return c.body(text, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.post("/internal/agent/call", async (c) => {
    const scope = c.get("execScope");
    const execToken = c.get("execToken");
    const callId = c.req.header("x-devchestra-call-id");
    if (callId === undefined || !/^[A-Za-z0-9._:-]{1,200}$/.test(callId)) {
      return c.json(
        errorBody("E_VALIDATION", "X-DevChestra-Call-Id is required and must be a stable id."),
        400,
      );
    }
    if (callId.includes(execToken)) {
      return c.json(
        errorBody("E_VALIDATION", "The request was rejected by the secret guard."),
        400,
      );
    }
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return c.json(errorBody("E_VALIDATION", "Content-Type must be application/json."), 400);
    }

    // A policy exec may legitimately run for its own deadline; the request
    // controller must outlive that deadline, not the 60s submit timer.
    const timeoutMs =
      scope.shell === undefined
        ? submitTimeoutMs
        : Math.max(submitTimeoutMs, scope.shell.timeoutMs + EXEC_GRACE_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const body = await readJsonObject(c, maxBodyBytes, controller.signal);
      if (containsSecret(body, execToken)) {
        return c.json(
          errorBody("E_VALIDATION", "The request was rejected by the secret guard."),
          400,
        );
      }
      if (typeof body.name !== "string" || body.name === "") {
        return c.json(errorBody("E_VALIDATION", "Tool name is required."), 400);
      }
      if (!isRecord(body.arguments)) {
        return c.json(errorBody("E_VALIDATION", "Tool arguments must be a JSON object."), 400);
      }
      const name = body.name;
      const args = body.arguments;

      if (name === EXEC_TOOL_NAME) {
        return await execCall(c, scope, execToken, callId, args, controller.signal);
      }

      if (name !== "submit_result") {
        return c.json(
          errorBody("E_FORBIDDEN", "That tool is not available to this execution."),
          403,
        );
      }

      const identity = scope.identity;
      const compiled = validator.compile(scope.outputSchema);
      const validation = compiled.validate(args);

      const work = (async (): Promise<Response> => {
        if (validation.ok) {
          const current = tokens.resolve(execToken, now());
          if (current === null) {
            throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
          }
          if (!sameScope(current, scope)) {
            throw new DevChestraError("E_CONFLICT", "This execution is no longer current.");
          }
          let outcome: SubmitOutcome;
          try {
            outcome = await submissions.submit({
              identity,
              callId,
              request: { name, arguments: args },
              ok: true,
              output: args,
              schemaHash: scope.outputSchemaHash,
            });
          } catch (error) {
            if (devchestraErrorCode(error) === "E_ATTEMPTS_EXHAUSTED") {
              return c.json(
                callResult("No attempts left. Stop now and report the failure.", true),
                200,
              );
            }
            throw error;
          }
          if (outcome.kind === "accepted" || outcome.kind === "already_accepted") {
            return c.json(
              callResult("Result accepted. You are done; do not call any other tool.", false),
              200,
            );
          }
          throw new DevChestraError("E_INTERNAL", "The store rejected a valid submission.");
        }

        const current = tokens.resolve(execToken, now());
        if (current === null) {
          throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
        }
        if (!sameScope(current, scope)) {
          throw new DevChestraError("E_CONFLICT", "This execution is no longer current.");
        }
        let outcome: SubmitOutcome;
        try {
          outcome = await submissions.submit({
            identity,
            callId,
            request: { name, arguments: args },
            ok: false,
            errors: validation.issues,
          });
        } catch (error) {
          if (devchestraErrorCode(error) === "E_ATTEMPTS_EXHAUSTED") {
            return c.json(
              callResult("No attempts left. Stop now and report the failure.", true),
              200,
            );
          }
          throw error;
        }
        if (outcome.kind === "accepted" || outcome.kind === "already_accepted") {
          return c.json(
            callResult("Result accepted. You are done; do not call any other tool.", false),
            200,
          );
        }
        if (outcome.kind !== "rejected") {
          throw new DevChestraError("E_INTERNAL", "The store accepted an invalid submission.");
        }
        const remaining = outcome.validationAttemptsLeft;
        if (remaining <= 0) {
          return c.json(
            callResult("No attempts left. Stop now and report the failure.", true),
            200,
          );
        }
        const text =
          `The result is invalid:\n${formatIssues(validation.issues)}\n` +
          `Fix these and call submit_result again. (${remaining} attempt${remaining === 1 ? "" : "s"} left)`;
        return c.json(callResult(text, true), 200);
      })();

      return await raceAbort(work, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * Policy exec. The policy, cwd and env come only from the token scope; the
   * arguments carry just the command string. Denials and run failures are HTTP
   * 200 tool results so the model can recover.
   */
  async function execCall(
    c: Context<GatewayEnv>,
    scope: ExecScope,
    execToken: string,
    callId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    if (scope.shell === undefined) {
      throw new DevChestraError("E_FORBIDDEN", "That tool is not available to this execution.");
    }
    const keys = Object.keys(args);
    if (keys.length !== 1 || keys[0] !== "command" || typeof args.command !== "string") {
      throw new DevChestraError(
        "E_VALIDATION",
        "exec accepts exactly one string argument: command.",
      );
    }
    if (args.command === "") {
      throw new DevChestraError("E_VALIDATION", "exec command must not be empty.");
    }
    if (execPlatform === "win32") {
      return c.json(
        callResult(
          "exec is POSIX-only: the shell policy command runner is not available on this host.",
          true,
        ),
      );
    }
    const current = tokens.resolve(execToken, now());
    if (current === null) {
      throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
    }
    if (!sameScope(current, scope) || current.shell === undefined) {
      throw new DevChestraError("E_CONFLICT", "This execution is no longer current.");
    }
    const command = args.command;
    const shell = current.shell;
    const outcome = await raceAbort(
      tokens.execute(
        execToken,
        callId,
        command,
        (jobSignal) => runPolicyExec({ shell, command, signal: jobSignal }),
        now(),
      ),
      signal,
    );
    return c.json(callResult(outcome.text, outcome.isError));
  }

  app.notFound((c) => c.json(errorBody("E_NOT_FOUND", "Not found."), 404));

  app.onError((error, c) => {
    const safe = toDevChestraError(error);
    if (safe.code === "E_INTERNAL") {
      log(`gateway error: ${safe.message}`);
    }
    return c.json(
      errorBody(safe.code, safe.message, safe.details),
      safe.status as ContentfulStatusCode,
    );
  });

  return app;
}
