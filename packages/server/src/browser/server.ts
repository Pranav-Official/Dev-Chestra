import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { startLoopbackServer } from "../node.js";
import { type BrowserAppDeps, createBrowserApp } from "./app.js";

export interface BrowserServerDeps extends Omit<BrowserAppDeps, "port"> {
  hostname?: "127.0.0.1" | "::1";
  port?: number;
}

export interface RunningBrowserServer {
  app: Hono;
  server: Awaited<ReturnType<typeof startLoopbackServer>>["server"];
  host: string;
  port: number;
  url: string;
  instanceId: string;
  close: () => Promise<void>;
}

function assertWebRoot(webRoot: string): void {
  let real: string;
  try {
    real = realpathSync.native(webRoot);
  } catch {
    throw new Error(
      `Configured webRoot does not exist: ${webRoot}. Build the web app or pass the correct path.`,
    );
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`Configured webRoot is not a directory: ${webRoot}`);
  }
  try {
    if (!statSync(join(real, "index.html")).isFile()) {
      throw new Error("index.html is not a file");
    }
  } catch {
    throw new Error(`Configured webRoot has no index.html: ${webRoot}. Build the web app first.`);
  }
}

export async function startBrowserServer(deps: BrowserServerDeps): Promise<RunningBrowserServer> {
  if (deps.webRoot !== undefined) assertWebRoot(deps.webRoot);
  let actualPort = 0;
  const app = createBrowserApp({
    ...deps,
    port: () => actualPort,
    ...(deps.webRoot === undefined ? {} : { webRoot: deps.webRoot }),
  });
  const listener = await startLoopbackServer(app, {
    ...(deps.hostname === undefined ? {} : { hostname: deps.hostname }),
    ...(deps.port === undefined ? {} : { port: deps.port }),
  });
  actualPort = listener.port;
  const url = listener.host === "::1" ? `http://[::1]:${listener.port}` : listener.url;
  return {
    app,
    server: listener.server,
    host: listener.host,
    port: listener.port,
    url,
    instanceId: deps.instanceId,
    close: async (): Promise<void> => {
      try {
        deps.stream?.close?.();
      } finally {
        await listener.close();
      }
    },
  };
}
