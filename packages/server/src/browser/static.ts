import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const INSTRUCTIONS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevChestra</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;color:#111;background:#fafafa}code{background:#eee;padding:.15rem .35rem;border-radius:.25rem}h1{font-size:1.4rem}</style></head>
<body><h1>Open DevChestra from your terminal</h1>
<p>This local DevChestra instance is running, but this browser has no session.</p>
<p>Run <code>devchestra start</code> (or the command that printed this address) and open the printed URL. The session token is placed in an HttpOnly cookie and removed from the address bar.</p>
<p>Do not share the launch URL. It contains the session token for this local DevChestra instance; the token stays valid until DevChestra restarts.</p>
</body></html>`;

const APP_ROUTE_PATTERNS = [
  /^\/$/,
  /^\/p\/[^/?#]+(?:[?#].*)?$/,
  /^\/p\/[^/?#]+\/workflows(?:[?#].*)?$/,
  /^\/p\/[^/?#]+\/w\/[^/?#]+(?:\/.*)?$/,
  /^\/p\/[^/?#]+\/runs(?:\/.*)?$/,
  /^\/p\/[^/?#]+\/r\/[^/?#]+(?:\/.*)?$/,
  /^\/settings(?:\/(?:providers|models|usage|execution))?(?:[?#].*)?$/,
  /^\/p\/[^/?#]+\/settings(?:\/(?:providers|models|usage|execution))?(?:[?#].*)?$/,
];

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function decodePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function segments(relativePath: string): string[] | null {
  const parts = relativePath.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (part === "." || part === "..") return null;
    out.push(part);
  }
  return out;
}

export function isKnownAppRoute(pathname: string): boolean {
  const decoded = decodePath(pathname);
  if (decoded === null) return false;
  return APP_ROUTE_PATTERNS.some((pattern) => pattern.test(decoded));
}

export class StaticWebRoot {
  readonly #root: string | null;
  readonly #cache = new Map<string, { bytes: Buffer; type: string; path: string }>();

  constructor(root: string | null) {
    if (root === null) {
      this.#root = null;
      return;
    }
    const absolute = resolve(root);
    const real = realpathSync.native(absolute);
    if (!lstatSync(real).isDirectory()) {
      throw new Error(`Configured webRoot is not a directory: ${root}`);
    }
    this.#root = real;
  }

  get configured(): boolean {
    return this.#root !== null;
  }

  read(relativePath: string): { bytes: Buffer; type: string; path: string } | null {
    const root = this.#root;
    if (root === null) return null;
    const cached = this.#cache.get(relativePath);
    if (cached !== undefined) return cached;
    const parts = segments(relativePath);
    if (parts === null) return null;
    const candidate = join(root, ...parts);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    let real: string;
    try {
      real = realpathSync.native(candidate);
    } catch {
      return null;
    }
    if (!within(root, real)) return null;
    let bytes: Buffer;
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      if (!fstatSync(fd).isFile()) return null;
      bytes = readFileSync(fd);
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
    const dot = relativePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : relativePath.slice(dot).toLowerCase();
    const value = {
      bytes,
      type: CONTENT_TYPES[ext] ?? "application/octet-stream",
      path: relativePath,
    };
    this.#cache.set(relativePath, value);
    return value;
  }

  index(): { bytes: Buffer; type: string; path: string } | null {
    return this.read("index.html");
  }
}

export function instructionsResponse(c: Context, status = 200): Response {
  c.header("Cache-Control", "no-store");
  return c.body(INSTRUCTIONS, status as 200, { "content-type": "text/html; charset=utf-8" });
}

export function staticResponse(c: Context, web: StaticWebRoot, pathname: string): Response | null {
  const decoded = decodePath(pathname);
  if (decoded === null) return null;
  const relativePath = decoded.replace(/^\/+/u, "");
  if (relativePath === "") return null;
  const asset = web.read(relativePath);
  if (asset === null) return null;
  const cache = relativePath.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return c.body(new Uint8Array(asset.bytes), 200, {
    "content-type": asset.type,
    "Cache-Control": cache,
  });
}

export function indexResponse(c: Context, web: StaticWebRoot): Response | null {
  const index = web.index();
  if (index === null) return null;
  return c.body(new Uint8Array(index.bytes), 200, {
    "content-type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
}
