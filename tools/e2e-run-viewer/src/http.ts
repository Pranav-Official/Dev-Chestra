import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text: string;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  csrf?: boolean;
  omitContentType?: boolean;
  cookie?: string | null;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  host?: string;
  origin?: string;
}

export interface BootstrapResult {
  cookie: string;
  status: number;
  location: string | null;
  setCookie: string[];
  html: string;
}

function parseSetCookies(headers: Record<string, string | string[] | undefined>): string[] {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const raw of setCookies) {
    const first = raw.split(";")[0]?.trim();
    if (first?.startsWith(`${name}=`)) return first;
  }
  return null;
}

export class DevChestraHttp {
  readonly baseUrl: string;
  readonly port: number;
  cookie: string | null = null;
  readonly requests: Array<{ method: string; path: string; status: number }> = [];

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    const url = new URL(baseUrl);
    this.port = Number(url.port);
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResult> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/html;q=0.9, */*;q=0.1",
      ...options.headers,
    };
    if (options.host !== undefined) headers.Host = options.host;
    if (options.origin !== undefined) headers.Origin = options.origin;
    const cookie = options.cookie === undefined ? this.cookie : options.cookie;
    if (cookie !== null && cookie !== undefined) headers.Cookie = cookie;
    if (options.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      if (options.omitContentType !== true) headers["Content-Type"] = "application/json";
    } else if (options.rawBody !== undefined) {
      payload = options.rawBody;
      if (options.omitContentType !== true) headers["Content-Type"] = "application/json";
    }
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating && options.csrf !== false) headers["X-DevChestra-Csrf"] = "1";

    const result = await new Promise<HttpResult>((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          method,
          headers,
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            if (text !== "" && (res.headers["content-type"] ?? "").includes("application/json")) {
              try {
                body = JSON.parse(text) as unknown;
              } catch {
                body = text;
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              text,
            });
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`request timed out: ${method} ${path}`));
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    this.requests.push({ method, path, status: result.status });
    return result;
  }

  async bootstrap(token: string): Promise<BootstrapResult> {
    const result = await this.send("GET", `/?t=${encodeURIComponent(token)}`, {
      cookie: null,
      headers: { Accept: "text/html" },
    });
    if (result.status !== 302 && result.status !== 303 && result.status !== 307) {
      throw new Error(`bootstrap expected a redirect, got ${String(result.status)}`);
    }
    const setCookie = parseSetCookies(result.headers);
    const cookie = cookieValue(setCookie, "devchestra_session");
    if (cookie === null) throw new Error("bootstrap did not set devchestra_session");
    const location = typeof result.headers.location === "string" ? result.headers.location : null;
    if (location === null) throw new Error("bootstrap did not set Location");
    if (location.includes("t=") || location.includes(token)) {
      throw new Error("bootstrap Location still carries the token");
    }
    this.cookie = cookie;
    const root = await this.send("GET", "/", { headers: { Accept: "text/html" } });
    if (root.status !== 200) throw new Error(`GET / returned ${String(root.status)}`);
    if (root.text.includes(token)) throw new Error("bootstrap HTML leaked the token");
    return { cookie, status: result.status, location, setCookie, html: root.text };
  }

  async api(method: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.send(method, path, options);
  }

  async health(): Promise<unknown> {
    const result = await this.send("GET", "/api/health", { cookie: null });
    if (result.status !== 200) throw new Error(`health returned ${String(result.status)}`);
    return result.body;
  }
}

export function hasApiHeader(result: HttpResult): boolean {
  const value = result.headers["x-devchestra-api"];
  return typeof value === "string" && value !== "";
}

export function errorCode(result: HttpResult): string | null {
  const body = result.body;
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function fieldString(body: unknown, keys: readonly string[]): string | null {
  let current: unknown = body;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}
