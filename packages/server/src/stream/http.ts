import type { Hono } from "hono";
import type { StreamHub } from "./hub.js";

/**
 * Register only the two SSE GET routes. Host/Origin/auth/CSRF/security headers
 * remain the composition root's middleware responsibility and must run first.
 */
export function mountStreamRoutes(app: Hono, hub: StreamHub): void {
  app.get("/api/runs/:rid/stream", (c) => hub.handleRunStream(c.req.raw, c.req.param("rid")));
  app.get("/api/stream", (c) => hub.handleGlobalStream(c.req.raw));
}
